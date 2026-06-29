import { agents, pluginState, authUsers, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";

/**
 * Per-user Asana task digest. PRODUCED by each user's own agent in its scheduled
 * heartbeat (weekly Mon 08:00 + daily 08:15), using THAT user's Asana token —
 * the agent is the user's delegate, so no central server ever touches another
 * user's token. STORED on the agent as `metadata.asanaDigest`. The dashboard
 * only READS it here (no token use at read time), keeping us inside the
 * "a token is only used by its own user's delegate" rule.
 */
export interface AsanaDigestTask {
  gid: string;
  name: string;
  dueOn: string | null;
  priority: string | null;
  projectName: string | null;
  permalinkUrl: string | null;
  completed: boolean;
  /** Short description preview (truncated). Optional/additive; null when absent. */
  notes: string | null;
}

export interface AsanaDigest {
  generatedAt: string;
  daily: AsanaDigestTask[];
  weekly: AsanaDigestTask[];
  /** True when this is seeded sample data, shown until the first real run. */
  sample?: boolean;
}

/**
 * Resolve which agent(s) belong to a user, by email — the SAME link the login
 * flow uses (autoProvisionAssignedAgents): the Google Chat "Assignments" map
 * (email → agent) plus any agent tagged with adapterConfig.assignedUserEmail.
 */
async function resolveAgentIdsForEmail(db: Db, email: string): Promise<Set<string>> {
  const wanted = new Set<string>();
  const e = email.trim().toLowerCase();
  if (!e) return wanted;
  try {
    const rows = await db.select().from(pluginState).where(eq(pluginState.stateKey, "agent-assignments"));
    for (const row of rows) {
      const map = (row.valueJson as Record<string, { agentId?: string }>) ?? {};
      const entry = map[e];
      if (entry?.agentId) wanted.add(entry.agentId);
    }
  } catch {
    /* assignments are optional */
  }
  const all = await db.select().from(agents);
  for (const a of all) {
    const cfg = a.adapterConfig as { assignedUserEmail?: string } | null;
    if (cfg?.assignedUserEmail?.trim().toLowerCase() === e) wanted.add(a.id);
  }
  return wanted;
}

function sanitizeTask(raw: unknown): AsanaDigestTask | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  if (typeof t.gid !== "string" || typeof t.name !== "string") return null;
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
  const notesRaw = str(t.notes);
  return {
    gid: t.gid,
    name: t.name,
    dueOn: str(t.dueOn),
    priority: str(t.priority),
    projectName: str(t.projectName),
    permalinkUrl: str(t.permalinkUrl),
    completed: t.completed === true,
    // Keep the stored digest small — a short preview is enough; full text lives in Asana.
    notes: notesRaw ? notesRaw.trim().slice(0, 280) : null,
  };
}

/**
 * Persist a digest onto the agent's metadata. Called by the agent itself (its
 * heartbeat) after pulling Asana with the user's token — the only writer. Input
 * is sanitized so a misbehaving run can't store arbitrary metadata.
 */
export async function writeAsanaDigestForAgent(
  db: Db,
  companyId: string,
  agentId: string,
  body: unknown,
): Promise<AsanaDigest> {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const daily = Array.isArray(b.daily) ? b.daily.map(sanitizeTask).filter((x): x is AsanaDigestTask => !!x) : [];
  const weekly = Array.isArray(b.weekly) ? b.weekly.map(sanitizeTask).filter((x): x is AsanaDigestTask => !!x) : [];
  const digest: AsanaDigest = {
    generatedAt: typeof b.generatedAt === "string" ? b.generatedAt : new Date().toISOString(),
    daily,
    weekly,
    ...(b.sample === true ? { sample: true } : {}),
  };
  const row = (await db.select().from(agents).where(eq(agents.id, agentId)))[0];
  const md = row?.metadata && typeof row.metadata === "object" ? { ...(row.metadata as Record<string, unknown>) } : {};
  md.asanaDigest = digest;
  await db.update(agents).set({ metadata: md, updatedAt: new Date() }).where(eq(agents.id, agentId));
  return digest;
}

/** Resolve the caller's OWN agent in a company (first match), by email. */
export async function resolveOwnAgentId(db: Db, companyId: string, email: string | null): Promise<string | null> {
  if (!email) return null;
  const wanted = await resolveAgentIdsForEmail(db, email);
  if (wanted.size === 0) return null;
  const rows = await db.select().from(agents).where(eq(agents.companyId, companyId));
  for (const a of rows) if (wanted.has(a.id)) return a.id;
  return null;
}

/**
 * Optimistically flip a task's `completed` flag in the agent's stored digest so
 * the dashboard reflects a check-off immediately. The agent's next real digest
 * refresh (after it actually completes the task in Asana via its own token)
 * reconciles this — if the Asana write didn't happen, the flag reverts.
 */
export async function setDigestTaskCompleted(
  db: Db,
  agentId: string,
  gid: string,
  completed: boolean,
): Promise<AsanaDigest | null> {
  const row = (await db.select().from(agents).where(eq(agents.id, agentId)))[0];
  const md = row?.metadata && typeof row.metadata === "object" ? { ...(row.metadata as Record<string, unknown>) } : null;
  if (!md) return null;
  const digest = md.asanaDigest as AsanaDigest | undefined;
  if (!digest) return null;
  const apply = (list: AsanaDigestTask[]) =>
    (Array.isArray(list) ? list : []).map((t) => (t.gid === gid ? { ...t, completed } : t));
  const next: AsanaDigest = { ...digest, daily: apply(digest.daily), weekly: apply(digest.weekly) };
  md.asanaDigest = next;
  await db.update(agents).set({ metadata: md, updatedAt: new Date() }).where(eq(agents.id, agentId));
  return next;
}

/** Look up a user's email from their auth user id. */
export async function emailForUserId(db: Db, userId: string | null | undefined): Promise<string | null> {
  if (!userId) return null;
  const row = (await db.select().from(authUsers).where(eq(authUsers.id, userId)))[0];
  return row?.email?.trim().toLowerCase() ?? null;
}

/**
 * Read the stored Asana digest for the user's own agent in this company.
 * Returns null when the user has no mapped agent or no digest has been produced
 * yet (the dashboard shows an empty state until the first scheduled run).
 */
export async function getAsanaDigestForUser(
  db: Db,
  companyId: string,
  email: string | null,
): Promise<AsanaDigest | null> {
  if (!email) return null;
  const wanted = await resolveAgentIdsForEmail(db, email);
  if (wanted.size === 0) return null;
  const rows = await db.select().from(agents).where(eq(agents.companyId, companyId));
  for (const a of rows) {
    if (!wanted.has(a.id)) continue;
    const md = a.metadata as Record<string, unknown> | null;
    const digest = md && typeof md === "object" ? (md.asanaDigest as AsanaDigest | undefined) : undefined;
    if (digest && Array.isArray(digest.daily) && Array.isArray(digest.weekly)) return digest;
  }
  return null;
}
