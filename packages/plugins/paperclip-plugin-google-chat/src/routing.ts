import type { PluginContext } from "@paperclipai/plugin-sdk";
import { recordConversation } from "./conversations.js";

/**
 * Redact credentials a user might paste in chat (Asana Personal Access Tokens)
 * so they never persist on highly-visible / monitoring surfaces (issue titles,
 * the Chat Logs view, last-message context). Returns whether a secret was found
 * so callers can route the raw value to the single, transient capture channel
 * (the new issue's description, which the agent self-destructs after storing).
 */
const SECRET_PATTERNS: RegExp[] = [
  /2\/\d{8,}\/\d{8,}:[0-9a-f]{16,}/g, // Asana PAT: 2/<userGid>/<appGid>:<hex>
];
export function redactSecrets(input: string): { text: string; hadSecret: boolean } {
  let hadSecret = false;
  let text = input ?? "";
  for (const re of SECRET_PATTERNS) {
    if (re.test(text)) {
      hadSecret = true;
      text = text.replace(re, "[已遮蔽的權杖 / redacted token]");
    }
  }
  return { text, hadSecret };
}

/**
 * Where to deliver an agent's reply once it's ready. Stored in plugin state
 * keyed by the issue id, so the issue.updated handler can route the agent's
 * comment back to the right Google Chat space/thread.
 */
export interface ChatTarget {
  spaceName: string;
  threadName?: string;
  companyId: string;
  senderEmail: string;
}

/**
 * Resolve which company to route into. Uses the configured companyId if set;
 * otherwise, if the instance has exactly one company, uses that.
 */
export async function resolveCompanyId(
  ctx: PluginContext,
  configuredCompanyId: string
): Promise<string> {
  if (configuredCompanyId) return configuredCompanyId;
  const companies = await ctx.companies.list();
  if (companies.length === 1) return companies[0].id;
  throw new Error(
    `Cannot resolve company: ${companies.length} companies exist; set "companyId" in config`
  );
}

/**
 * Resolve the agent to route to. v1: a single default agent identified by its
 * urlKey (or name). Falls back to the only agent if exactly one exists.
 */
export async function resolveAgentId(
  ctx: PluginContext,
  companyId: string,
  defaultAgentUrlKey: string
): Promise<string> {
  const agents = await ctx.agents.list({ companyId });
  if (defaultAgentUrlKey) {
    const wanted = defaultAgentUrlKey.trim().toLowerCase();
    const match = agents.find(
      (a) => a.urlKey?.toLowerCase() === wanted || a.name?.toLowerCase() === wanted
    );
    if (!match) {
      throw new Error(`No agent matching "${defaultAgentUrlKey}" in company ${companyId}`);
    }
    return match.id;
  }
  if (agents.length === 1) return agents[0].id;
  throw new Error(
    `Cannot resolve agent: ${agents.length} agents exist; set "defaultAgentUrlKey" in config`
  );
}

function targetKey(issueId: string) {
  return { scopeKind: "instance" as const, stateKey: `chat-task:${issueId}` };
}

export async function rememberChatTarget(
  ctx: PluginContext,
  issueId: string,
  target: ChatTarget
): Promise<void> {
  await ctx.state.set(targetKey(issueId), target);
}

export async function getChatTarget(
  ctx: PluginContext,
  issueId: string
): Promise<ChatTarget | null> {
  return (await ctx.state.get(targetKey(issueId))) as ChatTarget | null;
}

export async function clearChatTarget(ctx: PluginContext, issueId: string): Promise<void> {
  await ctx.state.delete(targetKey(issueId));
}

/**
 * Hand a chat message to an agent as a Paperclip issue (the proven relay path):
 * create the issue assigned to the agent, mark it ready, and remember where to
 * deliver the reply. The agent's answer comes back later as an issue comment,
 * surfaced via the issue.updated event.
 */
export async function dispatchToAgent(
  ctx: PluginContext,
  params: {
    companyId: string;
    agentId: string;
    text: string;
    senderDisplayName?: string;
    target: ChatTarget;
  }
): Promise<string> {
  const who = params.senderDisplayName ? ` from ${params.senderDisplayName}` : "";
  // Never let a pasted token reach the (highly visible) title. If a secret is
  // present, keep the raw value ONLY in the description as a one-time capture
  // channel and tell the agent to store it then wipe the description.
  const safe = redactSecrets(params.text);
  const title = `[Google Chat]${who}: ${truncate(safe.text.replace(/\s+/g, " "), 160)}`;
  const description = safe.hadSecret
    ? `${params.text}\n\n---\n⚠️ 本訊息含使用者提供的 Asana 權杖(明文)。請**立刻**:\n` +
      `1) 用此權杖呼叫 POST /api/companies/${params.companyId}/connections/asana 以安全儲存並接線(見 .claude/asana-instructions-zh.md);\n` +
      `2) 成功後**立即**把本議題描述改成「已安全儲存 Asana 權杖」以移除明文,並標記 done;\n` +
      `3) 提醒使用者到 Asana 撤銷剛貼出的權杖。`
    : params.text;
  const issue = await ctx.issues.create({
    companyId: params.companyId,
    title,
    description,
    assigneeAgentId: params.agentId
  });
  await ctx.issues.update(issue.id, { status: "todo" }, params.companyId);
  await rememberChatTarget(ctx, issue.id, params.target);
  // Index this turn for the manager-facing Chat Logs view. Best-effort: a state
  // hiccup here must never block delivering the message to the agent.
  try {
    await recordConversation(ctx, {
      email: params.target.senderEmail,
      displayName: params.senderDisplayName,
      issueId: issue.id,
      text: safe.text, // never store a token in the monitoring/Chat Logs view
      at: new Date().toISOString()
    });
  } catch {
    /* logging view is non-critical; ignore */
  }
  // Best-effort nudge so the agent picks the task up promptly.
  try {
    await ctx.issues.requestWakeup(issue.id, params.companyId);
  } catch {
    /* scheduler will still pick up the todo issue */
  }
  return issue.id;
}

// ---------------------------------------------------------------------------
// Conversation continuity — map a Chat conversation to ONE ongoing issue so the
// agent remembers the back-and-forth. A DM is a single continuous conversation
// (keyed by space); a space groups by THREAD, so each thread is an independent
// parallel conversation (like having several Claude chats open at once).
// ---------------------------------------------------------------------------

/** Stable key for the conversation a message belongs to. */
export function conversationKey(p: {
  spaceType?: string;
  spaceName: string;
  threadName?: string;
}): string {
  if (p.spaceType === "DM") return `dm:${p.spaceName}`;
  return `thread:${p.threadName || p.spaceName}`;
}

function convStateKey(convKey: string) {
  return { scopeKind: "instance" as const, stateKey: `conv:${convKey}` };
}

export async function getConversationIssue(
  ctx: PluginContext,
  convKey: string
): Promise<string | null> {
  const rec = (await ctx.state.get(convStateKey(convKey))) as { issueId?: string } | null;
  return rec?.issueId ?? null;
}

export async function setConversationIssue(
  ctx: PluginContext,
  convKey: string,
  issueId: string,
  companyId: string
): Promise<void> {
  await ctx.state.set(convStateKey(convKey), { issueId, companyId });
}

function lastMsgKey(issueId: string) {
  return { scopeKind: "instance" as const, stateKey: `lastmsg:${issueId}` };
}

/** Remember the latest user message on an issue — used to label the reply. */
export async function rememberLastUserMessage(
  ctx: PluginContext,
  issueId: string,
  text: string
): Promise<void> {
  await ctx.state.set(lastMsgKey(issueId), text);
}

export async function getLastUserMessage(
  ctx: PluginContext,
  issueId: string
): Promise<string | null> {
  return (await ctx.state.get(lastMsgKey(issueId))) as string | null;
}

/**
 * Append a follow-up message to an existing conversation's issue as a comment,
 * then re-wake the agent so it responds with full thread context. Returns the
 * new comment id (so the caller can mark it delivered and avoid echoing it).
 */
export async function appendToConversation(
  ctx: PluginContext,
  params: { issueId: string; companyId: string; text: string }
): Promise<string> {
  const comment = await ctx.issues.createComment(params.issueId, params.text, params.companyId);
  await ctx.issues.update(params.issueId, { status: "todo" }, params.companyId);
  try {
    await ctx.issues.requestWakeup(params.issueId, params.companyId);
  } catch {
    /* scheduler will still pick up the todo issue */
  }
  return comment.id ?? "";
}

/** Pick the agent's most recent comment body as the human-facing reply. */
export function latestAgentReply(
  comments: Array<{ authorType?: string; body?: string; createdAt?: string | Date }>
): string | null {
  const agentComments = comments.filter((c) => c.authorType === "agent" && c.body);
  const pool = agentComments.length > 0 ? agentComments : comments.filter((c) => c.body);
  if (pool.length === 0) return null;
  const latest = pool.reduce((a, b) =>
    new Date(a.createdAt ?? 0) >= new Date(b.createdAt ?? 0) ? a : b
  );
  return latest.body ?? null;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
