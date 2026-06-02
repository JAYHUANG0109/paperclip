import type { PluginContext } from "@paperclipai/plugin-sdk";

/**
 * Maps a person (by their Google Chat / Workspace email) to the Paperclip agent
 * that answers them. This is the access-control list for the bot: only people
 * with an assignment get a real response; everyone else is told to contact IT.
 *
 * Stored as a single instance-scoped state record keyed by lowercased email.
 */
export interface AgentAssignment {
  /** Original-case email as entered, for display. */
  email: string;
  /** Paperclip agent id that handles this person's messages. */
  agentId: string;
  /** Agent display name, cached for the admin UI. */
  agentName?: string;
  /** Company the agent belongs to. */
  companyId: string;
  /** ISO timestamp of the last change. */
  updatedAt: string;
}

const STATE_KEY = { scopeKind: "instance" as const, stateKey: "agent-assignments" };

function normalize(email: string): string {
  return email.trim().toLowerCase();
}

async function loadMap(ctx: PluginContext): Promise<Record<string, AgentAssignment>> {
  return ((await ctx.state.get(STATE_KEY)) as Record<string, AgentAssignment> | null) ?? {};
}

export async function listAssignments(ctx: PluginContext): Promise<AgentAssignment[]> {
  const map = await loadMap(ctx);
  return Object.values(map).sort((a, b) => a.email.localeCompare(b.email));
}

export async function getAssignment(
  ctx: PluginContext,
  email: string
): Promise<AgentAssignment | null> {
  if (!email) return null;
  const map = await loadMap(ctx);
  return map[normalize(email)] ?? null;
}

export async function setAssignment(
  ctx: PluginContext,
  assignment: AgentAssignment
): Promise<void> {
  const map = await loadMap(ctx);
  map[normalize(assignment.email)] = assignment;
  await ctx.state.set(STATE_KEY, map);
}

export async function removeAssignment(ctx: PluginContext, email: string): Promise<void> {
  const map = await loadMap(ctx);
  delete map[normalize(email)];
  await ctx.state.set(STATE_KEY, map);
}
