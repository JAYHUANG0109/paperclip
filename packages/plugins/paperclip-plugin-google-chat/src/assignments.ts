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
  /**
   * Provenance, owned by the Paperclip-side reconciler
   * (server/src/services/agent-assignment-sync.ts).
   *
   * Absent means an admin typed this here and no `agent_memberships` row backs
   * it yet; the reconciler promotes it to one and then stamps it as its own.
   * That stamp is what lets a membership deleted in Paperclip actually revoke
   * access instead of being re-created from this map forever.
   *
   * `setAssignment` deliberately does not carry it over: an admin editing a row
   * on the 代理指派 page is re-asserting intent, so the entry goes back to being
   * hand-made and is promoted again on the next reconcile.
   */
  source?: string;
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

/** Reverse of getAssignment: the person paired to a given agent. Used to DM an
 *  agent's owner when their agent replies to them in the Paperclip UI (a
 *  conversation that never touched Chat, so it has no remembered space). */
export async function getAssignmentByAgentId(
  ctx: PluginContext,
  agentId: string
): Promise<AgentAssignment | null> {
  if (!agentId) return null;
  const map = await loadMap(ctx);
  return Object.values(map).find((a) => a.agentId === agentId) ?? null;
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
