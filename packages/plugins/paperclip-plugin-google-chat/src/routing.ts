import type { PluginContext } from "@paperclipai/plugin-sdk";

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
  const title = `[Google Chat]${who}: ${truncate(params.text.replace(/\s+/g, " "), 160)}`;
  const issue = await ctx.issues.create({
    companyId: params.companyId,
    title,
    description: params.text,
    assigneeAgentId: params.agentId
  });
  await ctx.issues.update(issue.id, { status: "todo" }, params.companyId);
  await rememberChatTarget(ctx, issue.id, params.target);
  // Best-effort nudge so the agent picks the task up promptly.
  try {
    await ctx.issues.requestWakeup(issue.id, params.companyId);
  } catch {
    /* scheduler will still pick up the todo issue */
  }
  return issue.id;
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
