import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type {
  PluginContext,
  PluginWebhookInput,
  PluginWebhookResponse,
  ToolResult
} from "@paperclipai/plugin-sdk";
import { DEFAULT_CONFIG, SEND_DM_TOOL, WEBHOOK_KEY } from "./manifest.js";
import {
  type AccessToken,
  mintAccessToken,
  parseServiceAccountKey
} from "./google-auth.js";
import { extractInboundMessage, type InboundMessage, sendMessage, splitFirstImage } from "./chat.js";
import { rememberDmTarget, resolveDmSpace } from "./dm.js";
import {
  type AgentAssignment,
  getAssignment,
  listAssignments,
  removeAssignment,
  setAssignment
} from "./assignments.js";
import { formatForChat } from "./format.js";
import { commentSignature, orderedForwardable } from "./mirror.js";
import { listConversationEntries, listSenders, recordConversation } from "./conversations.js";
import { verifyInboundRequest } from "./verify.js";
import {
  appendToConversation,
  conversationKey,
  dispatchToAgent,
  getChatTarget,
  getConversationIssue,
  getLastUserMessage,
  rememberChatTarget,
  rememberLastUserMessage,
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
  routingEnabled: boolean;
  companyId: string;
  defaultAgentUrlKey: string;
  gateUnassigned: boolean;
  unassignedMessage: string;
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
  markdown: string
): Promise<void> {
  const token = await getAccessToken(ctx, config);
  const fetchImpl = (url: string, init?: RequestInit) => ctx.http.fetch(url, init);
  // Pull any image markdown out first: Chat can't render it as text, so it
  // goes out as a cardsV2 image widget after the formatted text chunks.
  const { text: body, imageUrl, imageAltText } = splitFirstImage(markdown);
  for (const chunk of formatForChat(body)) {
    if (chunk.trim().length === 0) continue;
    await sendMessage(fetchImpl, token, {
      spaceName: target.spaceName,
      threadName: target.threadName,
      text: chunk
    });
  }
  if (imageUrl) {
    await sendMessage(fetchImpl, token, {
      spaceName: target.spaceName,
      threadName: target.threadName,
      imageUrl,
      imageAltText
    });
  }
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
    senderEmail: inbound.senderEmail
  };
  // Each Chat message is its own task (issue) so questions run in PARALLEL and a
  // long-lived issue never gets stuck "done" and then ignored on re-wake.
  // Continuity applies only to space THREADS: a reply inside an existing thread
  // continues that thread's issue. DMs are flat (no per-message threads), so
  // every DM message starts a fresh task — a new question is simply a new message.
  const convKey =
    inbound.spaceType === "DM"
      ? null
      : conversationKey({
          spaceType: inbound.spaceType,
          spaceName: inbound.spaceName,
          threadName: inbound.threadName
        });
  const existingIssueId = convKey ? await getConversationIssue(ctx, convKey) : null;
  if (existingIssueId) {
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
        text: commentBody
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
        const target = await getChatTarget(ctx, issueId);
        if (!target) return; // not a Chat-originated issue

        const config = await getConfig(ctx);
        const comments = await ctx.issues.listComments(issueId, target.companyId);
        const delivered = await getDelivered(ctx, issueId);
        // Label the reply with the question it answers, so parallel
        // conversations are easy to match. Applied once per delivery round.
        const lastUserMsg = await getLastUserMessage(ctx, issueId);
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
          await postFormatted(ctx, config, target, body);
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
  },

  async onWebhook(input: PluginWebhookInput): Promise<void | PluginWebhookResponse> {
    const ctx = currentContext;
    if (!ctx) throw new Error("Plugin context not initialized");
    if (input.endpointKey !== WEBHOOK_KEY) {
      throw new Error(`Unsupported webhook endpoint "${input.endpointKey}"`);
    }

    const config = await getConfig(ctx);

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

    // ADDED_TO_SPACE / REMOVED_FROM_SPACE / CARD_CLICKED are acknowledged
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
