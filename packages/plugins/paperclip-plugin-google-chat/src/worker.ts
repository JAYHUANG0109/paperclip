import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type {
  PluginContext,
  PluginWebhookInput,
  PluginWebhookResponse,
  ToolResult
} from "@paperclipai/plugin-sdk";
import { DEFAULT_CONFIG, SEND_DM_TOOL, SEND_SPACE_TOOL, WEBHOOK_KEY } from "./manifest.js";
import {
  type AccessToken,
  mintAccessToken,
  parseServiceAccountKey
} from "./google-auth.js";
import { extractCardClick, extractInboundMessage, extractSpaceRef, type InboundMessage, sendMessage, splitFirstImage } from "./chat.js";
import { rememberDmTarget, resolveDmSpace } from "./dm.js";
import { learnSpaceFromApi, listKnownSpaces, rememberSpace, resolveSpaceName } from "./spaces.js";
import {
  type AgentAssignment,
  getAssignment,
  getAssignmentByAgentId,
  listAssignments,
  removeAssignment,
  setAssignment
} from "./assignments.js";
import { formatForChat } from "./format.js";
import { commentSignature, orderedForwardable } from "./mirror.js";
import { listConversationEntries, listSenders, recordConversation } from "./conversations.js";
import { verifyInboundRequest, extractBearerToken, decodeJwt } from "./verify.js";
import {
  appendToConversation,
  conversationKey,
  dispatchToAgent,
  clearConversationIssue,
  getChatTarget,
  getConversationIssue,
  getLastUserMessage,
  rememberChatTarget,
  rememberLastUserMessage,
  rememberRecentTask,
  getRecentTasks,
  resolveAgentId,
  resolveCompanyId,
  redactSecrets,
  setConversationIssue
} from "./routing.js";

interface GoogleChatConfig {
  serviceAccountSecretRef: string;
  echoMode: boolean;
  verifyInbound: boolean;
  senderServiceAccountEmail: string;
  expectedAudience: string;
  cardActionUrl: string;
  routingEnabled: boolean;
  companyId: string;
  defaultAgentUrlKey: string;
  gateUnassigned: boolean;
  unassignedMessage: string;
  forwardNotifications: boolean;
  forwardNotificationEmails: string[];
}

/** Set during setup() so the context-less onWebhook handler can reach host APIs. */
let currentContext: PluginContext | null = null;

/** In-process access-token cache; refreshed when within 60s of expiry. */
let cachedToken: AccessToken | null = null;

async function getConfig(ctx: PluginContext): Promise<GoogleChatConfig> {
  const raw = await ctx.config.get();
  return { ...DEFAULT_CONFIG, ...(raw as Partial<GoogleChatConfig>) };
}

/** Resolve a valid Chat API access token, minting (and caching) as needed. */
async function getAccessToken(ctx: PluginContext, config: GoogleChatConfig): Promise<string> {
  const nowMs = Date.now();
  if (cachedToken && cachedToken.expiresAtMs - nowMs > 60_000) {
    return cachedToken.token;
  }
  const rawKey = await ctx.secrets.resolve(config.serviceAccountSecretRef);
  const key = parseServiceAccountKey(rawKey);
  cachedToken = await mintAccessToken(key, (url, init) => ctx.http.fetch(url, init), { nowMs });
  return cachedToken.token;
}

/**
 * Build a Google Chat add-on SYNCHRONOUS action response carrying a text reply.
 * Returned from onWebhook so Chat renders the reply immediately (an instant
 * acknowledgement) and never shows the "「SeasonartsAI」沒有回應" placeholder.
 * The slow agent answer still arrives later as a separate async message.
 */
function chatTextResponse(text: string): PluginWebhookResponse {
  return {
    jsonBody: {
      hostAppDataAction: {
        chatDataAction: {
          createMessageAction: { message: { text } }
        }
      }
    }
  };
}

/** One-line, truncated form of the user's question for reply labels. */
function labelizeQuestion(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 60 ? `${flat.slice(0, 59)}…` : flat;
}

/**
 * Post an agent's markdown reply to Chat: convert to Chat's text dialect
 * (tables→monospace, headers/bold/links) and split into <4096-char messages,
 * posted in order on the same thread. One token mint for the whole reply.
 */
async function postFormatted(
  ctx: PluginContext,
  config: GoogleChatConfig,
  target: { spaceName: string; threadName?: string },
  markdown: string,
  actionButton?: { text: string; fn: string },
  linkButton?: { text: string; url: string }
): Promise<void> {
  const token = await getAccessToken(ctx, config);
  const fetchImpl = (url: string, init?: RequestInit) => ctx.http.fetch(url, init);
  // Pull any image markdown out first: Chat can't render it as text, so it
  // goes out as a cardsV2 image widget after the formatted text chunks.
  const { text: body, imageUrl, imageAltText } = splitFirstImage(markdown);
  const chunks = formatForChat(body).filter((c) => c.trim().length > 0);
  for (let i = 0; i < chunks.length; i++) {
    // Attach the button to the FINAL sent message only (last text chunk,
    // unless an image follows — then it rides with the image).
    const isFinalText = i === chunks.length - 1 && !imageUrl;
    await sendMessage(fetchImpl, token, {
      spaceName: target.spaceName,
      threadName: target.threadName,
      text: chunks[i],
      ...(isFinalText && actionButton ? { actionButton } : {}),
      ...(isFinalText && linkButton ? { linkButton } : {})
    });
  }
  if (imageUrl) {
    await sendMessage(fetchImpl, token, {
      spaceName: target.spaceName,
      threadName: target.threadName,
      imageUrl,
      imageAltText,
      ...(actionButton ? { actionButton } : {}),
      ...(linkButton ? { linkButton } : {})
    });
  }
}

/** The DM "new conversation" reset button + the CARD_CLICKED function it fires. */
const NEW_CONVERSATION_FN = "paperclip_new_conversation";

/** CARD_CLICKED function for the "Resume" button on the /tasks picker card. */
const RESUME_TASK_FN = "paperclip_resume_task";

/** CARD_CLICKED function for accept/reject buttons on an interaction card. */
const INTERACTION_RESPOND_FN = "paperclip_interaction_respond";

/**
 * The app's public HTTPS webhook URL that interactive button clicks POST to. In
 * the Workspace add-on model a button's action.function MUST be a full URL (not
 * an action name), so we set it to this endpoint and carry the real handler name
 * in a "fn" parameter. Empty when unconfigured → callers fall back to a link.
 */
/** State key for the endpoint URL auto-learned from inbound JWTs (see below). */
const LEARNED_CARD_ACTION_URL_KEY = { scopeKind: "instance" as const, stateKey: "learned-card-action-url" };

/**
 * Resolve the webhook URL for interactive button callbacks. Prefers explicit
 * config (cardActionUrl / expectedAudience), then the URL auto-learned from
 * inbound Google JWTs — the `aud` claim of every request Google sends IS this
 * app's endpoint URL, so buttons self-configure with zero manual setup once the
 * bot has received at least one message.
 */
async function getCardActionUrl(ctx: PluginContext, config: GoogleChatConfig): Promise<string> {
  const explicit = (config.cardActionUrl || config.expectedAudience || "").trim();
  if (explicit) return explicit;
  const learned = await ctx.state.get(LEARNED_CARD_ACTION_URL_KEY);
  return typeof learned === "string" ? learned : "";
}

/** Cache the endpoint URL from an inbound request's signed JWT `aud` claim. */
async function learnCardActionUrl(ctx: PluginContext, headers: Record<string, string | string[]>): Promise<void> {
  try {
    const aud = decodeJwt(extractBearerToken(headers)).payload.aud;
    const url = Array.isArray(aud) ? aud[0] : aud;
    if (typeof url === "string" && /^https:\/\//i.test(url)) {
      const current = await ctx.state.get(LEARNED_CARD_ACTION_URL_KEY);
      if (current !== url) await ctx.state.set(LEARNED_CARD_ACTION_URL_KEY, url);
    }
  } catch {
    /* no/!valid token (e.g. verifyInbound off) — nothing to learn */
  }
}

/** Build the DM "new task" reset action button for a given endpoint URL. */
function newConversationButton(actionUrl: string) {
  return {
    text: "＋ 開新任務 / New task",
    actionUrl,
    parameters: [{ key: "fn", value: NEW_CONVERSATION_FN }]
  };
}

/**
 * Render a request_confirmation as an interactive Chat card — Accept /
 * Request-changes buttons — so the user can decide without leaving Chat. Each
 * button carries the interaction + issue ids so the CARD_CLICKED handler
 * resolves the exact interaction via issues.respondInteraction.
 */
async function postInteractionCard(
  ctx: PluginContext,
  config: GoogleChatConfig,
  spaceName: string,
  info: { title: string; summary: string; interactionId: string; issueId: string }
): Promise<void> {
  const token = await getAccessToken(ctx, config);
  const actionUrl = await getCardActionUrl(ctx, config);
  // action.function is the full endpoint URL; the handler name rides in "fn".
  const params = (decision: string) => [
    { key: "fn", value: INTERACTION_RESPOND_FN },
    { key: "interactionId", value: info.interactionId },
    { key: "issueId", value: info.issueId },
    { key: "decision", value: decision }
  ];
  const body = {
    cardsV2: [
      {
        cardId: `interaction-${info.interactionId}`,
        card: {
          header: { title: info.title || "需要你回覆 / Needs your input" },
          sections: [
            {
              widgets: [
                ...(info.summary ? [{ textParagraph: { text: info.summary } }] : []),
                {
                  buttonList: {
                    buttons: [
                      {
                        text: "✅ 確認 / Accept",
                        onClick: { action: { function: actionUrl, parameters: params("accept") } }
                      },
                      {
                        text: "✳️ 需修改 / Request changes",
                        onClick: { action: { function: actionUrl, parameters: params("reject") } }
                      }
                    ]
                  }
                }
              ]
            }
          ]
        }
      }
    ]
  };
  const res = await ctx.http.fetch(`https://chat.googleapis.com/v1/${spaceName}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    throw new Error(`interaction card post failed (${res.status}): ${await res.text()}`);
  }
}

/** CARD_CLICKED function for an ask_user_questions option button. */
const INTERACTION_ANSWER_FN = "paperclip_interaction_answer";

/**
 * Render a single-select ask_user_questions as a Chat card — one button per
 * option — so the user answers in-place. Each button carries the interaction +
 * issue + question + option ids; the click submits the answer via
 * respondInteraction(decision:"answer"). Multi-select / multi-question / free-
 * text forms aren't button-shaped, so those keep the "open in Paperclip" link.
 */
async function postQuestionCard(
  ctx: PluginContext,
  config: GoogleChatConfig,
  spaceName: string,
  info: {
    title: string;
    prompt: string;
    interactionId: string;
    issueId: string;
    questionId: string;
    options: Array<{ id: string; label: string }>;
  }
): Promise<void> {
  const token = await getAccessToken(ctx, config);
  const actionUrl = await getCardActionUrl(ctx, config);
  const buttons = info.options.slice(0, 6).map((opt) => ({
    text: opt.label.slice(0, 60),
    onClick: {
      action: {
        function: actionUrl,
        parameters: [
          { key: "fn", value: INTERACTION_ANSWER_FN },
          { key: "interactionId", value: info.interactionId },
          { key: "issueId", value: info.issueId },
          { key: "questionId", value: info.questionId },
          { key: "optionId", value: opt.id }
        ]
      }
    }
  }));
  const body = {
    cardsV2: [
      {
        cardId: `question-${info.interactionId}`,
        card: {
          header: { title: info.title || "需要你回覆 / A question for you" },
          sections: [{ widgets: [{ textParagraph: { text: info.prompt } }, { buttonList: { buttons } }] }]
        }
      }
    ]
  };
  const res = await ctx.http.fetch(`https://chat.googleapis.com/v1/${spaceName}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    throw new Error(`question card post failed (${res.status}): ${await res.text()}`);
  }
}

/** CARD_CLICKED functions for multi-widget FORM submits (checkbox / questions /
 *  suggest_tasks). The click carries the widget values in commonEventObject
 *  .formInputs, which we map back to respondInteraction. */
const FORM_CHECKBOX_FN = "paperclip_form_checkbox";
const FORM_QUESTIONS_FN = "paperclip_form_questions";
const FORM_TASKS_FN = "paperclip_form_tasks";

/** Field-name helpers so the submit handler can reconstruct which question each
 *  selection belongs to (the questionId is encoded in the widget name). */
const QUESTION_FIELD_PREFIX = "q_";
const CHECKBOX_FIELD = "sel";
const TASKS_FIELD = "tasks";

async function postCardJson(ctx: PluginContext, config: GoogleChatConfig, spaceName: string, card: unknown, label: string): Promise<void> {
  const token = await getAccessToken(ctx, config);
  const res = await ctx.http.fetch(`https://chat.googleapis.com/v1/${spaceName}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ cardsV2: [card] })
  });
  if (!res.ok) throw new Error(`${label} card post failed (${res.status}): ${await res.text()}`);
}

/** request_checkbox_confirmation → a CHECK_BOX form + Confirm / Request-changes. */
async function postCheckboxCard(
  ctx: PluginContext,
  config: GoogleChatConfig,
  spaceName: string,
  actionUrl: string,
  info: {
    title: string;
    prompt: string;
    interactionId: string;
    issueId: string;
    options: Array<{ id: string; label: string; description?: string | null }>;
    defaultSelectedOptionIds?: string[];
    acceptLabel?: string | null;
    rejectLabel?: string | null;
  }
): Promise<void> {
  const defaults = new Set(info.defaultSelectedOptionIds ?? []);
  const base = (decision: string) => [
    { key: "fn", value: FORM_CHECKBOX_FN },
    { key: "interactionId", value: info.interactionId },
    { key: "issueId", value: info.issueId },
    { key: "decision", value: decision }
  ];
  await postCardJson(ctx, config, spaceName, {
    cardId: `checkbox-${info.interactionId}`,
    card: {
      header: { title: info.title || "請勾選 / Please select" },
      sections: [{
        widgets: [
          { textParagraph: { text: info.prompt } },
          {
            selectionInput: {
              name: CHECKBOX_FIELD,
              type: "CHECK_BOX",
              items: info.options.slice(0, 100).map((o) => ({
                text: o.label.slice(0, 140),
                value: o.id,
                selected: defaults.has(o.id)
              }))
            }
          },
          {
            buttonList: {
              buttons: [
                { text: info.acceptLabel || "✅ 確認 / Confirm", onClick: { action: { function: actionUrl, parameters: base("accept") } } },
                { text: info.rejectLabel || "✳️ 需修改 / Request changes", onClick: { action: { function: actionUrl, parameters: base("reject") } } }
              ]
            }
          }
        ]
      }]
    }
  }, "checkbox");
}

/** ask_user_questions (any shape) → one selectionInput per question + Submit. */
async function postQuestionsFormCard(
  ctx: PluginContext,
  config: GoogleChatConfig,
  spaceName: string,
  actionUrl: string,
  info: {
    title: string;
    interactionId: string;
    issueId: string;
    submitLabel?: string | null;
    questions: Array<{ id: string; prompt: string; selectionMode?: string; options?: Array<{ id: string; label: string }> }>;
  }
): Promise<void> {
  const widgets: unknown[] = [];
  for (const q of info.questions) {
    widgets.push({
      selectionInput: {
        name: `${QUESTION_FIELD_PREFIX}${q.id}`,
        label: q.prompt.slice(0, 140),
        type: q.selectionMode === "multi" ? "CHECK_BOX" : "RADIO_BUTTON",
        items: (q.options ?? []).slice(0, 100).map((o) => ({ text: o.label.slice(0, 140), value: o.id, selected: false }))
      }
    });
  }
  widgets.push({
    buttonList: {
      buttons: [{
        text: info.submitLabel || "送出 / Submit",
        onClick: {
          action: {
            function: actionUrl,
            parameters: [
              { key: "fn", value: FORM_QUESTIONS_FN },
              { key: "interactionId", value: info.interactionId },
              { key: "issueId", value: info.issueId }
            ]
          }
        }
      }]
    }
  });
  await postCardJson(ctx, config, spaceName, {
    cardId: `questions-${info.interactionId}`,
    card: { header: { title: info.title || "需要你回覆 / A few questions" }, sections: [{ widgets }] }
  }, "questions");
}

/** suggest_tasks → a CHECK_BOX of proposed tasks + Accept / Reject. */
async function postSuggestTasksCard(
  ctx: PluginContext,
  config: GoogleChatConfig,
  spaceName: string,
  actionUrl: string,
  info: {
    title: string;
    interactionId: string;
    issueId: string;
    tasks: Array<{ clientKey: string; title: string; description?: string | null }>;
  }
): Promise<void> {
  const base = (decision: string) => [
    { key: "fn", value: FORM_TASKS_FN },
    { key: "interactionId", value: info.interactionId },
    { key: "issueId", value: info.issueId },
    { key: "decision", value: decision }
  ];
  await postCardJson(ctx, config, spaceName, {
    cardId: `tasks-${info.interactionId}`,
    card: {
      header: { title: info.title || "建議任務 / Suggested tasks" },
      sections: [{
        widgets: [
          {
            selectionInput: {
              name: TASKS_FIELD,
              type: "CHECK_BOX",
              items: info.tasks.slice(0, 100).map((t) => ({ text: t.title.slice(0, 140), value: t.clientKey, selected: true }))
            }
          },
          {
            buttonList: {
              buttons: [
                { text: "✅ 建立所選 / Create selected", onClick: { action: { function: actionUrl, parameters: base("accept") } } },
                { text: "✳️ 不用了 / Decline", onClick: { action: { function: actionUrl, parameters: base("reject") } } }
              ]
            }
          }
        ]
      }]
    }
  }, "suggest-tasks");
}

/** /tasks → a card listing this DM's recent tasks, each with a Resume button
 *  (RESUME_TASK_FN) that re-points the conversation to that task. */
async function postRecentTasksCard(
  ctx: PluginContext,
  config: GoogleChatConfig,
  spaceName: string,
  companyId: string,
  actionUrl: string,
  tasks: Array<{ issueId: string; identifier: string; title: string; status: string }>
): Promise<void> {
  const widgets = tasks.map((t) => ({
    decoratedText: {
      topLabel: `${t.identifier} · ${t.status}`,
      text: t.title.slice(0, 120) || t.identifier,
      wrapText: true,
      button: {
        text: "↩ 繼續 / Resume",
        onClick: {
          action: {
            function: actionUrl,
            parameters: [
              { key: "fn", value: RESUME_TASK_FN },
              { key: "issueId", value: t.issueId }
            ]
          }
        }
      }
    }
  }));
  void companyId;
  await postCardJson(ctx, config, spaceName, {
    cardId: "recent-tasks",
    card: {
      header: { title: "最近的任務 / Recent tasks" },
      sections: [{ widgets: widgets.length > 0 ? widgets : [{ textParagraph: { text: "（沒有最近的任務 / none yet）" } }] }]
    }
  }, "recent-tasks");
}

/**
 * DM target for an agent's OWNER — the person paired to it in the Assignments
 * map. Lets us mirror an agent's reply to Chat even when the conversation
 * started in the Paperclip UI (so there's no remembered Chat space). Returns
 * null when the agent is unpaired or the owner has never DM'd the bot (Google
 * won't let an app open a fresh DM), in which case we simply don't forward.
 */
async function resolveOwnerDmTarget(
  ctx: PluginContext,
  config: GoogleChatConfig,
  agentId: string,
  companyId: string
): Promise<{ spaceName: string; companyId: string; senderEmail: string; spaceType: string } | null> {
  const assignment = await getAssignmentByAgentId(ctx, agentId);
  const email = assignment?.email?.trim().toLowerCase();
  if (!email) return null;
  const token = await getAccessToken(ctx, config);
  const fetchImpl = (url: string, init?: RequestInit) => ctx.http.fetch(url, init);
  const spaceName = await resolveDmSpace(ctx, fetchImpl, token, email);
  if (!spaceName) return null;
  return { spaceName, companyId, senderEmail: email, spaceType: "DM" };
}

/**
 * Download any files attached to the inbound Chat message and upload them onto
 * the Paperclip issue. Best-effort per file: a failure to fetch/attach one file
 * must never block the message from reaching the agent.
 */
async function attachInboundFiles(
  ctx: PluginContext,
  config: GoogleChatConfig,
  issueId: string,
  companyId: string,
  inbound: InboundMessage
): Promise<void> {
  const atts = inbound.attachments ?? [];
  if (atts.length === 0) return;
  let token: string | null = null;
  for (const att of atts) {
    try {
      if (att.resourceName) {
        token = token ?? (await getAccessToken(ctx, config));
        // Have the HOST fetch the media bytes: the plugin's own ctx.http.fetch
        // returns text and corrupts binary, so we pass the URL + auth header and
        // let the host download the raw bytes and store them.
        // resourceName is an opaque base64 token (contains / + =) — it must be
        // percent-encoded as a single path segment, not left raw.
        const mediaUrl = `https://chat.googleapis.com/v1/media/${encodeURIComponent(att.resourceName)}?alt=media`;
        await ctx.issues.attachments.create({
          issueId,
          companyId,
          filename: att.contentName || "upload",
          contentType: att.contentType || "application/octet-stream",
          fetchUrl: mediaUrl,
          fetchHeaders: { Authorization: `Bearer ${token}` }
        });
        ctx.logger.info("Uploaded Chat attachment to issue", {
          issueId,
          filename: att.contentName
        });
      } else if (att.driveFileId) {
        // Drive-shared files need Drive API scope to fetch; note the reference
        // on the issue instead of downloading bytes.
        await ctx.issues.createComment(
          issueId,
          `📎 Google Drive 檔案：${att.contentName ?? att.driveFileId}`,
          companyId
        );
      }
    } catch (err) {
      // Put the reason in the message text — the plugin logger drops unknown
      // metadata keys, so an `error` field wouldn't show up.
      ctx.logger.warn(
        `Failed to attach Chat upload (${att.contentName ?? "file"}): ${err instanceof Error ? err.message : String(err)}`,
        { issueId }
      );
    }
  }
}

/** Per-issue record of which agent comments we've already mirrored to Chat. */
interface DeliveredRecord {
  ids: string[];
  sigs: string[];
}

const DELIVERED_CAP = 200;

function deliveredKey(issueId: string) {
  return { scopeKind: "instance" as const, stateKey: `delivered:${issueId}` };
}

async function getDelivered(ctx: PluginContext, issueId: string): Promise<DeliveredRecord> {
  const rec = (await ctx.state.get(deliveredKey(issueId))) as DeliveredRecord | null;
  return { ids: rec?.ids ?? [], sigs: rec?.sigs ?? [] };
}

async function saveDelivered(
  ctx: PluginContext,
  issueId: string,
  rec: DeliveredRecord
): Promise<void> {
  // Bound growth: keep only the most recent ids/sigs.
  await ctx.state.set(deliveredKey(issueId), {
    ids: rec.ids.slice(-DELIVERED_CAP),
    sigs: rec.sigs.slice(-DELIVERED_CAP)
  });
}

/**
 * Routing path: hand the message to the agent as a Paperclip issue and return a
 * quick acknowledgement string (delivered synchronously by onWebhook). The
 * agent's actual reply arrives later as an issue comment, mirrored to Chat by
 * the issue.comment.created handler registered in setup().
 */
async function routeToAgent(
  ctx: PluginContext,
  config: GoogleChatConfig,
  inbound: InboundMessage
): Promise<string> {
  if (!inbound.senderEmail) {
    return "抱歉，我無法辨識您的身分，請稍後再試。";
  }

  // "New conversation" reset for DMs — a typed command (the reliable twin of the
  // ＋開新對話 button/CARD_CLICKED): end the current session so the NEXT message
  // opens a fresh task. Everything else continues the same task.
  if (
    inbound.spaceType === "DM" &&
    /^\s*(\/new|＋?\s*開?新(對話|任務)|new(\s+(chat|task|conversation))?)\s*$/i.test(inbound.text ?? "")
  ) {
    await clearConversationIssue(ctx, conversationKey({ spaceType: "DM", spaceName: inbound.spaceName }));
    return "✅ 好的，下一則訊息會開一個新任務。/ New task — your next message starts a fresh one.";
  }

  // Access control: a sender's assignment decides which agent answers them.
  // When gating is on, anyone without an assignment is turned away politely and
  // no agent run is created.
  const assignment = await getAssignment(ctx, inbound.senderEmail);
  let companyId: string;
  let agentId: string;
  if (assignment) {
    companyId = assignment.companyId;
    agentId = assignment.agentId;
  } else if (config.gateUnassigned) {
    ctx.logger.info("Turned away unassigned sender", { email: inbound.senderEmail });
    return config.unassignedMessage;
  } else {
    companyId = await resolveCompanyId(ctx, config.companyId);
    agentId = await resolveAgentId(ctx, companyId, config.defaultAgentUrlKey);
  }
  const target = {
    spaceName: inbound.spaceName,
    threadName: inbound.threadName,
    companyId,
    senderEmail: inbound.senderEmail,
    spaceType: inbound.spaceType
  };

  // Resume-a-previous-task commands (DM only), on the reliable MESSAGE path.
  const cmd = (inbound.text ?? "").trim();
  if (inbound.spaceType === "DM" && /^(\/tasks?|任務清單|最近任務)$/i.test(cmd)) {
    const actionUrl = await getCardActionUrl(ctx, config);
    const recentIds = await getRecentTasks(ctx, inbound.spaceName);
    const tasks: Array<{ issueId: string; identifier: string; title: string; status: string }> = [];
    for (const id of recentIds) {
      const iss = await ctx.issues.get(id, companyId).catch(() => null);
      if (iss) tasks.push({ issueId: id, identifier: iss.identifier ?? id.slice(0, 8), title: iss.title ?? "", status: iss.status ?? "" });
    }
    if (actionUrl) {
      await postRecentTasksCard(ctx, config, inbound.spaceName, companyId, actionUrl, tasks);
      return "📋 最近的任務 / Your recent tasks:";
    }
    // No action URL yet → plain text list.
    const lines = tasks.length
      ? tasks.map((t) => `• ${t.identifier}（${t.status}）：${t.title}`)
      : ["（沒有最近的任務 / none yet）"];
    return `📋 最近的任務 / Recent tasks（輸入 /task <編號> 切回）:\n\n${lines.join("\n")}`;
  }
  const resumeMatch = /^(?:\/task|任務)\s+(\S+)$/i.exec(cmd);
  if (inbound.spaceType === "DM" && resumeMatch) {
    const wanted = resumeMatch[1].trim().toUpperCase();
    const recentIds = await getRecentTasks(ctx, inbound.spaceName);
    let match: { id: string; identifier: string } | null = null;
    for (const id of recentIds) {
      const iss = await ctx.issues.get(id, companyId).catch(() => null);
      if (iss && (iss.identifier ?? "").toUpperCase() === wanted) {
        match = { id, identifier: iss.identifier ?? id };
        break;
      }
    }
    if (!match) {
      return `找不到最近任務「${resumeMatch[1]}」。輸入 /tasks 看看清單。/ Task not found — try /tasks.`;
    }
    const rk = conversationKey({ spaceType: "DM", spaceName: inbound.spaceName });
    if (rk) {
      await setConversationIssue(ctx, rk, match.id, companyId);
      await rememberChatTarget(ctx, match.id, target);
      await rememberRecentTask(ctx, inbound.spaceName, match.id);
    }
    return `✅ 已切回 ${match.identifier}，接下來的訊息會繼續這個任務。/ Switched back — your next messages continue it.`;
  }

  // Conversation continuity: a DM is now ONE ongoing session (keyed by its DM
  // space) that accrues messages into a single task until the user starts a new
  // one via the ＋開新對話 button / command. Space threads continue per-thread as
  // before. (Previously every DM message opened a fresh task.)
  const convKey = conversationKey({
    spaceType: inbound.spaceType,
    spaceName: inbound.spaceName,
    threadName: inbound.threadName
  });
  const existingIssueId = convKey ? await getConversationIssue(ctx, convKey) : null;
  if (existingIssueId) {
    if (inbound.spaceType === "DM") await rememberRecentTask(ctx, inbound.spaceName, existingIssueId);
    try {
      // Pre-register the user's message as "delivered" BEFORE creating the
      // comment. Creating the comment fires issue.comment.created synchronously,
      // and the mirror handler can run before we'd otherwise mark it delivered —
      // that race is what echoed the user's own message back. Registering the
      // body signature up front makes the mirror skip it no matter the timing
      // (and regardless of whether the returned comment id is reliable).
      const pre = await getDelivered(ctx, existingIssueId);
      pre.sigs.push(commentSignature(inbound.text));
      await saveDelivered(ctx, existingIssueId, pre);
      // If the follow-up pasted a token, keep the raw value only in the comment
      // (the agent's capture channel) with a self-destruct directive; everything
      // else (last-message context, Chat Logs) gets the redacted text.
      const safeFollow = redactSecrets(inbound.text);
      const commentBody = safeFollow.hadSecret
        ? `${inbound.text}\n\n---\n⚠️ 含 Asana 權杖明文。請依 onboarding 指示用 POST /api/companies/${companyId}/connections/asana 儲存後,立即編輯本留言移除明文。`
        : inbound.text;
      const commentId = await appendToConversation(ctx, {
        issueId: existingIssueId,
        companyId,
        text: commentBody,
        senderEmail: inbound.senderEmail
      });
      if (commentId) {
        const delivered = await getDelivered(ctx, existingIssueId);
        delivered.ids.push(commentId);
        await saveDelivered(ctx, existingIssueId, delivered);
      }
      await rememberLastUserMessage(ctx, existingIssueId, safeFollow.text);
      await rememberChatTarget(ctx, existingIssueId, target);
      try {
        await recordConversation(ctx, {
          email: inbound.senderEmail,
          displayName: inbound.senderDisplayName,
          issueId: existingIssueId,
          text: safeFollow.text,
          at: new Date().toISOString()
        });
      } catch {
        /* chat-logs index is non-critical */
      }
      await attachInboundFiles(ctx, config, existingIssueId, companyId, inbound);
      ctx.logger.info("Appended follow-up to conversation", { issueId: existingIssueId, convKey });
      return "⏳ 處理中，請稍候… (Working on it…)";
    } catch (err) {
      ctx.logger.warn("Append to conversation failed; starting a new issue", {
        error: err instanceof Error ? err.message : String(err)
      });
      // fall through to a fresh issue
    }
  }

  const attachmentCount = inbound.attachments?.length ?? 0;
  const dispatchText =
    inbound.text || (attachmentCount > 0 ? `（已上傳 ${attachmentCount} 個檔案）` : "");
  const issueId = await dispatchToAgent(ctx, {
    companyId,
    agentId,
    text: dispatchText,
    senderDisplayName: inbound.senderDisplayName,
    target
  });
  if (convKey) await setConversationIssue(ctx, convKey, issueId, companyId);
  if (inbound.spaceType === "DM") await rememberRecentTask(ctx, inbound.spaceName, issueId);
  await rememberLastUserMessage(ctx, issueId, redactSecrets(inbound.text).text);
  await attachInboundFiles(ctx, config, issueId, companyId, inbound);
  ctx.logger.info("Dispatched Chat message to agent", { issueId, agentId, convKey });
  return "⏳ 處理中，請稍候… (Working on it…)";
}

const plugin = definePlugin({
  async setup(ctx) {
    currentContext = ctx;
    cachedToken = null;

    ctx.data.register("health", async () => {
      return {
        status: currentContext ? "ok" : "not-initialized",
        tokenCached: cachedToken !== null,
        checkedAt: new Date().toISOString()
      };
    });

    // Agent-callable tool: proactively message a person on Google Chat by email.
    // Works for anyone who has DM'd the bot (we learn their DM space from inbound
    // messages); an app can't open a brand-new DM itself, so unknown emails get a
    // clear "they must message the bot first" error.
    ctx.tools.register(
      SEND_DM_TOOL,
      {
        displayName: "Send Google Chat message",
        description:
          "Send a direct message to a person on Google Chat, addressed by their email. " +
          "Only works for people who have messaged the SeasonartsAI bot before.",
        parametersSchema: {
          type: "object",
          properties: {
            email: { type: "string", description: "The recipient's Google Chat (Workspace) email." },
            text: { type: "string", description: "The message text to send." }
          },
          required: ["email", "text"]
        }
      },
      async (params): Promise<ToolResult> => {
        const { email, text } = (params ?? {}) as { email?: string; text?: string };
        if (!email || !text) {
          return { error: "Both 'email' and 'text' are required." };
        }
        const config = await getConfig(ctx);
        const token = await getAccessToken(ctx, config);
        const fetchImpl = (url: string, init?: RequestInit) => ctx.http.fetch(url, init);
        const spaceName = await resolveDmSpace(ctx, fetchImpl, token, email);
        if (!spaceName) {
          return {
            error:
              `No known Google Chat DM for ${email}. They need to message SeasonartsAI at ` +
              `least once first (an app can't open a brand-new DM on its own).`
          };
        }
        try {
          await postFormatted(ctx, config, { spaceName }, text);
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
        ctx.logger.info("Sent Chat DM via tool", { email, space: spaceName });
        return { content: `Message sent to ${email}.`, data: { spaceName } };
      }
    );

    // Agent-callable tool: post to a GROUP space (room) by its name. The bot is
    // one identity for every agent, so we can't make the room message appear to
    // come from a per-user sender — instead we prefix it with the calling agent's
    // name (from runCtx) for attribution. The bot must already be a member of the
    // room; we learn a room's name from inbound activity there. On an unknown name
    // we return the rooms we CAN reach so the agent can pick correctly.
    ctx.tools.register(
      SEND_SPACE_TOOL,
      {
        displayName: "Send Google Chat group message",
        description:
          "Post a message to a Google Chat group space (room) by its name (e.g. \"領導團隊\"). " +
          "Prefixed with your agent name so the room knows who sent it. Only reaches rooms the " +
          "SeasonartsAI bot has been added to.",
        parametersSchema: {
          type: "object",
          properties: {
            space: { type: "string", description: "The room's name in Google Chat (a unique partial name works)." },
            text: { type: "string", description: "The message text to send." }
          },
          required: ["space", "text"]
        }
      },
      async (params, runCtx): Promise<ToolResult> => {
        const { space, text } = (params ?? {}) as { space?: string; text?: string };
        if (!space || !text) {
          return { error: "Both 'space' and 'text' are required." };
        }
        const config = await getConfig(ctx);
        const spaceName = await resolveSpaceName(ctx, space);
        if (!spaceName) {
          const known = await listKnownSpaces(ctx);
          const names = known.filter((s) => s.displayName).map((s) => `「${s.displayName}」`);
          return {
            error: names.length
              ? `找不到符合「${space}」的群組空間。我目前可張貼的群組：${names.join("、")}。請改用其中一個名稱（可用不重複的部分名稱）。`
              : `找不到符合「${space}」的群組空間，而且我還沒被加入任何群組。請先把 SeasonartsAI 機器人加入該群組，再試一次。`
          };
        }
        // Attribution: name the sending agent, since all agents share the one bot.
        let label = "Paperclip 助理";
        try {
          const a = await ctx.agents.get(runCtx.agentId, runCtx.companyId);
          const base = a?.name?.trim() || label;
          const role = (a?.title || a?.role || "").trim();
          label = role && !base.includes(role) ? `${base}_${role}` : base;
        } catch {
          /* fall back to the generic label */
        }
        try {
          await postFormatted(ctx, config, { spaceName }, `${label}：\n${text}`);
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
        ctx.logger.info("Sent Chat group message via tool", {
          agentId: runCtx.agentId,
          space: spaceName
        });
        return { content: `已張貼到群組空間。`, data: { spaceName, as: label } };
      }
    );

    // Liveness check backing the dashboard widget's "Ping Worker" button.
    ctx.actions.register("ping", async () => ({ ok: true, at: new Date().toISOString() }));

    // ----- Assignments admin (backs the Google Chat company-settings page) -----

    // Read: current email→agent assignments plus the agents available to pick.
    ctx.data.register("assignments", async (params) => {
      const config = await getConfig(ctx);
      const companyId = await resolveCompanyId(
        ctx,
        (typeof params.companyId === "string" && params.companyId) || config.companyId
      );
      const agents = await ctx.agents.list({ companyId });
      // Surface each agent's team(s) (metadata.teams[] or metadata.team) so the
      // admin UI can filter the assignment list by team — keeps a long roster
      // navigable instead of one big pile.
      const teamsOf = (a: (typeof agents)[number]): string[] => {
        const md = a.metadata as Record<string, unknown> | null;
        if (!md) return [];
        const out: string[] = [];
        if (Array.isArray(md.teams)) {
          for (const t of md.teams) if (typeof t === "string" && t.trim()) out.push(t.trim());
        } else if (typeof md.team === "string" && md.team.trim()) {
          out.push(md.team.trim());
        }
        return out;
      };
      return {
        companyId,
        gateUnassigned: config.gateUnassigned,
        assignments: await listAssignments(ctx),
        agents: agents.map((a) => ({ id: a.id, name: a.name, urlKey: a.urlKey, teams: teamsOf(a) }))
      };
    });

    // Write: assign an email to an agent.
    ctx.actions.register("assignments.set", async (params) => {
      const email = typeof params.email === "string" ? params.email.trim() : "";
      const agentId = typeof params.agentId === "string" ? params.agentId : "";
      if (!email || !agentId) {
        return { ok: false, error: "Both email and agent are required." };
      }
      const config = await getConfig(ctx);
      const companyId = await resolveCompanyId(
        ctx,
        (typeof params.companyId === "string" && params.companyId) || config.companyId
      );
      const agent = (await ctx.agents.list({ companyId })).find((a) => a.id === agentId);
      if (!agent) {
        return { ok: false, error: "That agent no longer exists in this company." };
      }
      const assignment: AgentAssignment = {
        email,
        agentId,
        agentName: agent.name,
        companyId,
        updatedAt: new Date().toISOString()
      };
      await setAssignment(ctx, assignment);
      ctx.logger.info("Set Chat assignment", { email, agentId });
      return { ok: true, assignments: await listAssignments(ctx) };
    });

    // Write: remove an assignment.
    ctx.actions.register("assignments.remove", async (params) => {
      const email = typeof params.email === "string" ? params.email.trim() : "";
      if (!email) return { ok: false, error: "email is required." };
      await removeAssignment(ctx, email);
      ctx.logger.info("Removed Chat assignment", { email });
      return { ok: true, assignments: await listAssignments(ctx) };
    });

    // ----- Chat Logs (backs the read-only conversation monitor page) -----
    //
    // No `email` param  → "people" mode: the roster of everyone who has chatted,
    //   enriched with their assigned agent + role, newest activity first.
    // With `email` param → "transcript" mode: that person's whole conversation as
    //   an ordered list of {role: user|agent, text, at}, assembled from the
    //   recorded user turns plus the agent's forwardable (CJK) reply comments.
    ctx.data.register("chat-logs", async (params) => {
      const config = await getConfig(ctx);
      const companyId = await resolveCompanyId(
        ctx,
        (typeof params.companyId === "string" && params.companyId) || config.companyId
      );
      const email = typeof params.email === "string" ? params.email.trim() : "";

      if (email) {
        const entries = await listConversationEntries(ctx, email);
        const messages: Array<{ role: "user" | "agent"; text: string; at: string }> = [];
        // Cap fan-out: only the most recent turns pull their reply comments.
        for (const entry of entries.slice(-50)) {
          messages.push({ role: "user", text: entry.text, at: entry.at });
          try {
            const comments = await ctx.issues.listComments(entry.issueId, companyId);
            for (const c of orderedForwardable(comments)) {
              const at =
                c.createdAt instanceof Date
                  ? c.createdAt.toISOString()
                  : typeof c.createdAt === "string"
                    ? c.createdAt
                    : entry.at;
              messages.push({ role: "agent", text: c.body ?? "", at });
            }
          } catch {
            /* issue may have been removed; skip its replies */
          }
        }
        // Order is already correct: turns are appended chronologically, and within
        // each turn the user message precedes its (oldest-first) agent replies. We
        // deliberately do NOT re-sort by timestamp — the user's turn is stamped at
        // dispatch and its replies arrive later, so per-turn order is authoritative.
        return { mode: "transcript", email, messages };
      }

      const [senders, assignments, agents] = await Promise.all([
        listSenders(ctx),
        listAssignments(ctx),
        ctx.agents.list({ companyId })
      ]);
      const agentById = new Map(agents.map((a) => [a.id, a]));
      const assignByEmail = new Map(assignments.map((a) => [a.email.toLowerCase(), a]));

      const people = new Map<
        string,
        {
          email: string;
          displayName?: string;
          agentId?: string;
          agentName?: string;
          role?: string;
          lastAt: string | null;
          assigned: boolean;
        }
      >();

      // Everyone who has chatted (roster), newest first from listSenders().
      for (const s of senders) {
        const key = s.email.toLowerCase();
        const asn = assignByEmail.get(key);
        const agent = asn ? agentById.get(asn.agentId) : undefined;
        people.set(key, {
          email: s.email,
          displayName: s.displayName,
          agentId: asn?.agentId,
          agentName: asn?.agentName ?? agent?.name,
          role: agent?.title ?? agent?.role,
          lastAt: s.lastAt,
          assigned: Boolean(asn)
        });
      }
      // Assigned people who haven't chatted yet still belong in the roster.
      for (const a of assignments) {
        const key = a.email.toLowerCase();
        if (people.has(key)) continue;
        const agent = agentById.get(a.agentId);
        people.set(key, {
          email: a.email,
          agentId: a.agentId,
          agentName: a.agentName ?? agent?.name,
          role: agent?.title ?? agent?.role,
          lastAt: null,
          assigned: true
        });
      }

      const list = Array.from(people.values()).sort((x, y) => {
        const tx = x.lastAt ? new Date(x.lastAt).getTime() : 0;
        const ty = y.lastAt ? new Date(y.lastAt).getTime() : 0;
        return ty - tx;
      });
      return { mode: "people", companyId, gateUnassigned: config.gateUnassigned, people: list };
    });

    // Mirror the agent conversation: forward each NEW agent message on a
    // Chat-originated issue to the originating space, as it's posted. This
    // replaces the old "deliver once when status hits done" logic, which lost
    // the real answer whenever the issue churned through `done` (e.g. a CEO
    // dispatching to a sub-issue) before the answer was written.
    ctx.events.on("issue.comment.created", async (event) => {
      try {
        const issueId = event.entityId;
        if (!issueId) return;
        const config = await getConfig(ctx);
        let target: { spaceName: string; threadName?: string; companyId: string; senderEmail?: string; spaceType?: string } | null =
          await getChatTarget(ctx, issueId);
        if (!target && event.actorType === "agent" && event.actorId) {
          // No remembered Chat space → this conversation started in the Paperclip
          // UI. Mirror the agent's reply to its OWNER's Chat DM instead, so a user
          // sees their agent's answer in Chat wherever they started the thread.
          target = await resolveOwnerDmTarget(ctx, config, event.actorId, event.companyId);
        }
        if (!target) return; // not Chat-originated and no reachable owner DM

        const comments = await ctx.issues.listComments(issueId, target.companyId);
        const delivered = await getDelivered(ctx, issueId);
        // Label the reply with the question it answers, so parallel conversations
        // are easy to match. Derive it from the ACTUAL thread — the latest
        // user-authored comment — rather than per-issue stored state, which can go
        // stale/cross-wired when messages span multiple tasks. Fall back to the
        // stored last message only if the thread has no user comment yet.
        const latestUserComment = [...comments]
          .reverse()
          .find((c) => c.authorType === "user" && (c.body ?? "").trim().length > 0);
        const lastUserMsg = latestUserComment?.body ?? (await getLastUserMessage(ctx, issueId));
        let labeledThisRound = false;

        for (const comment of orderedForwardable(comments)) {
          const id = comment.id ?? "";
          if (id && delivered.ids.includes(id)) continue;
          const sig = commentSignature(comment.body ?? "");
          if (delivered.sigs.includes(sig)) {
            if (id) delivered.ids.push(id); // mark seen, skip the duplicate body
            continue;
          }
          let body = comment.body ?? "";
          if (lastUserMsg && !labeledThisRound) {
            body = `↪︎ 回覆：「${labelizeQuestion(lastUserMsg)}」\n\n${body}`;
            labeledThisRound = true;
          }
          // On DMs, offer a one-tap "new task" reset. The button POSTs to our
          // webhook URL (add-on model); if no action URL is configured it's
          // omitted and users type "/new task" instead (MESSAGE path).
          const actionUrl = await getCardActionUrl(ctx, config);
          const resetButton =
            target.spaceType === "DM" && actionUrl ? newConversationButton(actionUrl) : undefined;
          await postFormatted(ctx, config, target, body, resetButton);
          if (id) delivered.ids.push(id);
          delivered.sigs.push(sig);
          ctx.logger.info("Mirrored agent comment to Chat", { issueId, commentId: id });
        }
        await saveDelivered(ctx, issueId, delivered);
      } catch (err) {
        ctx.logger.error("Failed to mirror comment to Chat", {
          error: err instanceof Error ? err.message : String(err)
        });
      }
    });

    // Forward each NEW Paperclip notification (Asana digest, @mention, blocker,
    // run failure, …) to the recipient's Google Chat DM. The server resolves the
    // recipient email into the event payload; we map it to a learned DM space.
    // Gated by an allowlist so the relay can be validated on one account first.
    ctx.events.on("notification.created", async (event) => {
      try {
        const config = await getConfig(ctx);
        if (!config.forwardNotifications) return;
        const p = (event.payload ?? {}) as {
          email?: string | null;
          kind?: string;
          title?: string;
          body?: string | null;
          link?: string | null;
        };
        // Interaction pings are rendered as rich CARDS by the
        // issue.thread_interaction_created handler — skip forwarding the plain
        // notification here to avoid a duplicate message in Chat.
        if (p.kind === "thread_interaction") return;
        const email = p.email?.trim().toLowerCase();
        if (!email) return; // recipient has no resolvable email
        const allow = config.forwardNotificationEmails ?? [];
        if (allow.length > 0 && !allow.map((e) => e.trim().toLowerCase()).includes(email)) {
          return; // not on the allowlist yet
        }

        const token = await getAccessToken(ctx, config);
        const fetchImpl = (url: string, init?: RequestInit) => ctx.http.fetch(url, init);
        const spaceName = await resolveDmSpace(ctx, fetchImpl, token, email);
        if (!spaceName) {
          ctx.logger.info("Skip notification forward: no known DM space", { email, kind: p.kind });
          return; // user must message the bot once before we can DM them
        }

        const lines = [`🔔 ${p.title ?? "Paperclip 通知 / Notification"}`];
        if (p.body) lines.push(p.body);
        // The server resolves the link to an absolute URL (from authPublicBaseUrl).
        // When present, render it as a tappable LINK button (openLink works in
        // every Chat config, unlike action callbacks). This is how interaction
        // prompts — confirmations, questions, checkboxes — reach the user: a card
        // with an "open in Paperclip" button where they complete the typed form.
        // Fall back to an inline link hint when the origin isn't configured.
        const absoluteLink = p.link && /^https?:\/\//i.test(p.link) ? p.link : null;
        const isInteraction = p.kind === "thread_interaction";
        const linkButton = absoluteLink
          ? {
              text: isInteraction ? "✅ 前往回覆 / Open in Paperclip" : "↗ 開啟 / Open in Paperclip",
              url: absoluteLink
            }
          : undefined;
        if (p.link && !absoluteLink) lines.push(`↗ Paperclip：${p.link}`);
        await postFormatted(ctx, config, { spaceName }, lines.join("\n\n"), undefined, linkButton);
        ctx.logger.info("Forwarded notification to Chat", { email, kind: p.kind, space: spaceName });
      } catch (err) {
        ctx.logger.error("Failed to forward notification to Chat", {
          error: err instanceof Error ? err.message : String(err)
        });
      }
    });

    // Render an agent-created interaction as an interactive Chat CARD in the
    // owner's DM. In the Workspace add-on model a button's action.function is the
    // full webhook URL (see resolveCardActionUrl / postInteractionCard) and the
    // click POSTs back to onWebhook. request_confirmation → Accept/Reject;
    // single-select ask_user_questions → one button per option. Anything we
    // can't button-render (multi-question, or no action URL configured) falls
    // back to an "open in Paperclip" LINK button using the server-provided
    // absolute issueUrl. Kinds handled here are NOT also link-notified by the
    // server (it skips request_confirmation + ask_user_questions) to avoid dupes.
    ctx.events.on("issue.thread_interaction_created", async (event) => {
      try {
        const p = (event.payload ?? {}) as {
          interactionId?: string;
          interactionKind?: string;
          interactionTitle?: string | null;
          interactionSummary?: string | null;
          issueUrl?: string | null;
          interactionPayload?: {
            title?: string | null;
            prompt?: string | null;
            submitLabel?: string | null;
            acceptLabel?: string | null;
            rejectLabel?: string | null;
            defaultSelectedOptionIds?: string[];
            options?: Array<{ id: string; label: string; description?: string | null }>;
            questions?: Array<{
              id: string;
              prompt: string;
              selectionMode?: string;
              options?: Array<{ id: string; label: string }>;
            }>;
            tasks?: Array<{ clientKey: string; title: string; description?: string | null }>;
          } | null;
        };
        const issueId = event.entityId;
        const agentId = event.actorId;
        if (!issueId || !p.interactionId || event.actorType !== "agent" || !agentId) return;
        const kind = p.interactionKind;
        const pl = p.interactionPayload ?? {};
        const common = { interactionId: p.interactionId, issueId };

        const config = await getConfig(ctx);
        const target = await resolveOwnerDmTarget(ctx, config, agentId, event.companyId);
        if (!target) return; // owner unpaired or has never DM'd the bot
        const space = target.spaceName;

        const actionUrl = await getCardActionUrl(ctx, config);
        let mode = "link";

        if (actionUrl && kind === "request_confirmation") {
          mode = "confirm";
          await postInteractionCard(ctx, config, space, {
            title: p.interactionTitle ?? "需要你確認 / Needs your confirmation",
            summary: p.interactionSummary ?? "",
            ...common
          });
        } else if (actionUrl && kind === "ask_user_questions" && (pl.questions?.length ?? 0) > 0) {
          mode = "questions";
          await postQuestionsFormCard(ctx, config, space, actionUrl, {
            title: p.interactionTitle ?? pl.title ?? "",
            submitLabel: pl.submitLabel ?? null,
            questions: pl.questions ?? [],
            ...common
          });
        } else if (actionUrl && kind === "request_checkbox_confirmation" && (pl.options?.length ?? 0) > 0) {
          mode = "checkbox";
          await postCheckboxCard(ctx, config, space, actionUrl, {
            title: p.interactionTitle ?? "請勾選 / Please select",
            prompt: pl.prompt ?? p.interactionSummary ?? "",
            options: pl.options ?? [],
            defaultSelectedOptionIds: pl.defaultSelectedOptionIds ?? [],
            acceptLabel: pl.acceptLabel ?? null,
            rejectLabel: pl.rejectLabel ?? null,
            ...common
          });
        } else if (actionUrl && kind === "suggest_tasks" && (pl.tasks?.length ?? 0) > 0) {
          mode = "tasks";
          await postSuggestTasksCard(ctx, config, space, actionUrl, {
            title: p.interactionTitle ?? "建議任務 / Suggested tasks",
            tasks: pl.tasks ?? [],
            ...common
          });
        } else {
          // Fallback: a card with an "open in Paperclip" LINK button (no action
          // URL yet, or an unrecognized/empty payload).
          const token = await getAccessToken(ctx, config);
          const lines = [p.interactionTitle ?? "需要你回覆 / Needs your input"];
          if (p.interactionSummary) lines.push(p.interactionSummary);
          const link = p.issueUrl && /^https?:\/\//i.test(p.issueUrl) ? p.issueUrl : null;
          await sendMessage((u, init) => ctx.http.fetch(u, init), token, {
            spaceName: space,
            text: lines.join("\n\n"),
            ...(link ? { linkButton: { text: "✅ 前往回覆 / Open in Paperclip", url: link } } : {})
          });
        }
        ctx.logger.info("Posted interaction card to Chat", { issueId, interactionId: p.interactionId, kind, mode });
      } catch (err) {
        ctx.logger.error("Failed to post interaction card to Chat", {
          error: err instanceof Error ? err.message : String(err)
        });
      }
    });
  },

  async onWebhook(input: PluginWebhookInput): Promise<void | PluginWebhookResponse> {
    const ctx = currentContext;
    if (!ctx) throw new Error("Plugin context not initialized");
    if (input.endpointKey !== WEBHOOK_KEY) {
      throw new Error(`Unsupported webhook endpoint "${input.endpointKey}"`);
    }

    const config = await getConfig(ctx);

    // Auto-learn this app's public endpoint URL from the inbound JWT `aud` so
    // interactive card buttons can POST back here without any manual config.
    await learnCardActionUrl(ctx, input.headers);

    // Authenticate the request as genuinely from Google Chat before acting on it.
    if (config.verifyInbound) {
      if (!config.senderServiceAccountEmail) {
        throw new Error("verifyInbound is on but no sender service account email is configured");
      }
      try {
        await verifyInboundRequest(input.headers, (url, init) => ctx.http.fetch(url, init), {
          expectedEmail: config.senderServiceAccountEmail,
          expectedAudience: config.expectedAudience || undefined
        });
      } catch (err) {
        ctx.logger.warn("Rejected unverified inbound webhook", {
          requestId: input.requestId,
          error: err instanceof Error ? err.message : String(err)
        });
        throw err;
      }
    }

    // Learn any GROUP room the bot is in — from a message there OR from being
    // added to it — so an agent can later post to it by name. DMs are learned
    // separately (by sender email) below and are skipped here. Best-effort: a
    // failure to learn a room must never block handling the event.
    try {
      const ref = extractSpaceRef(input.parsedBody);
      if (ref && ref.spaceType && ref.spaceType !== "DM") {
        if (ref.displayName) {
          await rememberSpace(ctx, { spaceName: ref.spaceName, displayName: ref.displayName });
        } else {
          const token = await getAccessToken(ctx, config);
          const fetchImpl = (url: string, init?: RequestInit) => ctx.http.fetch(url, init);
          await learnSpaceFromApi(ctx, fetchImpl, token, ref.spaceName);
        }
      }
    } catch (err) {
      ctx.logger.warn("Failed to learn Chat space", {
        error: err instanceof Error ? err.message : String(err)
      });
    }

    // Button clicks (CARD_CLICKED), parsed defensively across the classic +
    // Workspace-add-on shapes. NOTE: action-callback clicks are not delivered to
    // this app in the add-on event model, so these handlers are effectively
    // dormant here — kept for classic-Chat-app compatibility.
    const click = extractCardClick(input.parsedBody);
    if (click?.fn === NEW_CONVERSATION_FN) {
      // "＋開新對話": end the DM session so the next message opens a fresh task.
      if (click.spaceName) {
        await clearConversationIssue(ctx, conversationKey({ spaceType: "DM", spaceName: click.spaceName }));
      }
      ctx.logger.info("Reset DM conversation via button", { space: click.spaceName });
      return chatTextResponse("✅ 好的，下一則訊息會開一個新任務。/ New task — your next message starts a fresh one.");
    }
    if (click?.fn === RESUME_TASK_FN) {
      // "↩ Resume" on the /tasks card → re-point the DM to that task.
      const issueId = click.params.issueId;
      const email = click.email?.trim().toLowerCase();
      if (!issueId || !click.spaceName) {
        return chatTextResponse("抱歉，無法辨識這個任務。");
      }
      try {
        const assignment = email ? await getAssignment(ctx, email) : null;
        const companyId = assignment?.companyId ?? (await resolveCompanyId(ctx, config.companyId));
        const iss = await ctx.issues.get(issueId, companyId).catch(() => null);
        const rk = conversationKey({ spaceType: "DM", spaceName: click.spaceName });
        if (rk) {
          await setConversationIssue(ctx, rk, issueId, companyId);
          await rememberChatTarget(ctx, issueId, {
            spaceName: click.spaceName,
            companyId,
            senderEmail: email,
            spaceType: "DM"
          });
          await rememberRecentTask(ctx, click.spaceName, issueId);
        }
        const label = iss?.identifier ?? issueId.slice(0, 8);
        ctx.logger.info("Resumed task via Chat card", { issueId, space: click.spaceName });
        return chatTextResponse(`✅ 已切回 ${label}，接下來的訊息會繼續這個任務。/ Switched back — your next messages continue it.`);
      } catch (err) {
        ctx.logger.error("resume task via Chat failed", { error: err instanceof Error ? err.message : String(err) });
        return chatTextResponse("抱歉，切換任務時發生問題，請稍後再試。");
      }
    }
    if (click?.fn === INTERACTION_RESPOND_FN) {
      // Accept / Request-changes on an interaction card → resolve it in Paperclip
      // as the clicking user (attributed by their email).
      const { interactionId, issueId, decision } = click.params;
      const email = click.email?.trim().toLowerCase();
      if (!interactionId || !issueId || !email) {
        return chatTextResponse("抱歉，無法辨識這則互動，請到 Paperclip 完成。");
      }
      try {
        const assignment = await getAssignment(ctx, email);
        const companyId = assignment?.companyId ?? (await resolveCompanyId(ctx, config.companyId));
        await ctx.issues.respondInteraction({
          issueId,
          companyId,
          interactionId,
          decision: decision === "reject" ? "reject" : "accept",
          responderEmail: email
        });
        ctx.logger.info("Resolved interaction via Chat card", { issueId, interactionId, decision });
        return chatTextResponse(
          decision === "reject" ? "✳️ 已送出「需修改」，謝謝！" : "✅ 已確認，謝謝！"
        );
      } catch (err) {
        ctx.logger.error("respondInteraction from Chat failed", {
          error: err instanceof Error ? err.message : String(err)
        });
        return chatTextResponse("抱歉，處理你的回覆時發生問題，請到 Paperclip 完成。");
      }
    }
    if (click?.fn === INTERACTION_ANSWER_FN) {
      // An ask_user_questions option button → submit that answer.
      const { interactionId, issueId, questionId, optionId } = click.params;
      const email = click.email?.trim().toLowerCase();
      if (!interactionId || !issueId || !questionId || !optionId || !email) {
        return chatTextResponse("抱歉，無法辨識這則回覆，請到 Paperclip 完成。");
      }
      try {
        const assignment = await getAssignment(ctx, email);
        const companyId = assignment?.companyId ?? (await resolveCompanyId(ctx, config.companyId));
        await ctx.issues.respondInteraction({
          issueId,
          companyId,
          interactionId,
          decision: "answer",
          responderEmail: email,
          answers: [{ questionId, optionIds: [optionId] }]
        });
        ctx.logger.info("Answered question via Chat card", { issueId, interactionId, questionId, optionId });
        return chatTextResponse("✅ 已送出你的選擇，謝謝！");
      } catch (err) {
        ctx.logger.error("answer via Chat failed", {
          error: err instanceof Error ? err.message : String(err)
        });
        return chatTextResponse("抱歉，處理你的回覆時發生問題，請到 Paperclip 完成。");
      }
    }
    // FORM submits (multi-widget cards). The selected values arrive in
    // click.formInputs, keyed by the widget names we set when rendering.
    if (click?.fn === FORM_CHECKBOX_FN || click?.fn === FORM_QUESTIONS_FN || click?.fn === FORM_TASKS_FN) {
      const { interactionId, issueId, decision } = click.params;
      const email = click.email?.trim().toLowerCase();
      if (!interactionId || !issueId || !email) {
        return chatTextResponse("抱歉，無法辨識這則回覆，請到 Paperclip 完成。");
      }
      try {
        const assignment = await getAssignment(ctx, email);
        const companyId = assignment?.companyId ?? (await resolveCompanyId(ctx, config.companyId));
        if (decision === "reject") {
          await ctx.issues.respondInteraction({ issueId, companyId, interactionId, decision: "reject", responderEmail: email });
          return chatTextResponse("✳️ 已送出「需修改」，謝謝！");
        }
        if (click.fn === FORM_CHECKBOX_FN) {
          await ctx.issues.respondInteraction({
            issueId, companyId, interactionId, decision: "accept", responderEmail: email,
            selectedOptionIds: click.formInputs[CHECKBOX_FIELD] ?? []
          });
          return chatTextResponse("✅ 已送出你的選擇，謝謝！");
        }
        if (click.fn === FORM_TASKS_FN) {
          await ctx.issues.respondInteraction({
            issueId, companyId, interactionId, decision: "accept", responderEmail: email,
            selectedClientKeys: click.formInputs[TASKS_FIELD] ?? []
          });
          return chatTextResponse("✅ 已建立所選任務，謝謝！");
        }
        // FORM_QUESTIONS_FN: every q_<questionId> field → one answer.
        const answers = Object.entries(click.formInputs)
          .filter(([name]) => name.startsWith(QUESTION_FIELD_PREFIX))
          .map(([name, optionIds]) => ({ questionId: name.slice(QUESTION_FIELD_PREFIX.length), optionIds }));
        await ctx.issues.respondInteraction({ issueId, companyId, interactionId, decision: "answer", responderEmail: email, answers });
        ctx.logger.info("Submitted form via Chat card", { issueId, interactionId, fn: click.fn });
        return chatTextResponse("✅ 已送出你的回覆，謝謝！");
      } catch (err) {
        ctx.logger.error("form submit via Chat failed", {
          fn: click.fn,
          error: err instanceof Error ? err.message : String(err)
        });
        return chatTextResponse("抱歉，處理你的回覆時發生問題，請到 Paperclip 完成。");
      }
    }

    // ADDED_TO_SPACE / REMOVED_FROM_SPACE / other card events are acknowledged
    // (HTTP 200) without a reply.
    const inbound = extractInboundMessage(input.parsedBody);
    if (!inbound) {
      ctx.logger.info("Acknowledged non-message Chat event", { requestId: input.requestId });
      return;
    }


    // Idempotency: Google retries webhooks on timeout, and agent runs can be
    // slow. Mark the message seen BEFORE the slow relay so a retry is a no-op.
    if (inbound.messageName) {
      const seenKey = { scopeKind: "instance" as const, stateKey: `seen:${inbound.messageName}` };
      if (await ctx.state.get(seenKey)) {
        ctx.logger.info("Skipping duplicate message delivery", { messageName: inbound.messageName });
        return;
      }
      await ctx.state.set(seenKey, true);
    }

    // Learn how to reach this person later: a DM space we can post to by email.
    // Only from genuine DMs — a room's space isn't anyone's personal channel.
    if (inbound.senderEmail && inbound.spaceType === "DM") {
      await rememberDmTarget(ctx, inbound.senderEmail, {
        spaceName: inbound.spaceName,
        userName: inbound.senderUserName
      });
    }

    if (config.routingEnabled) {
      try {
        const ack = await routeToAgent(ctx, config, inbound);
        return chatTextResponse(ack);
      } catch (err) {
        ctx.logger.warn("Routing failed", {
          requestId: input.requestId,
          error: err instanceof Error ? err.message : String(err)
        });
        return chatTextResponse("抱歉，目前無法將您的訊息交給代理，請稍後再試。");
      }
    }

    // Echo fallback (routing disabled).
    const reply = config.echoMode ? `echo: ${inbound.text}` : inbound.text;
    ctx.logger.info("Echoed Chat message", {
      space: inbound.spaceName,
      sender: inbound.senderDisplayName,
      requestId: input.requestId
    });
    return chatTextResponse(reply);
  },

  async onHealth() {
    return {
      status: currentContext ? "ok" : "error",
      message: currentContext ? "Plugin worker is running" : "Worker not initialized"
    };
  }
});

export default plugin;
runWorker(plugin, import.meta.url);
