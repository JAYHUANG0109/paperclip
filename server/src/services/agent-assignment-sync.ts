/**
 * Reconciles the two places that record "which agent belongs to which person" —
 * PURE decision logic plus a thin DB-backed applier.
 *
 * There are two stores, and they are not the same shape:
 *
 *  1. `agent_memberships` — (companyId, userId, agentId). Many-to-many, keyed by
 *     *user id*. This is what `getVisibleAgentIdsForUser` reads, what scopes
 *     tasks, and what decides whose personal memory an agent may open. It is the
 *     SOURCE OF TRUTH.
 *
 *  2. The Google Chat plugin's `agent-assignments` state record — a JSON map
 *     keyed by *lowercased email*, holding at most ONE agent per person. It is
 *     the bot's ACL (only assigned senders get a real reply) and it backs the
 *     editable 代理指派 admin page.
 *
 * Both are written by hand today, so they drift. This module makes them
 * converge, in both directions, without either one being able to silently
 * destroy the other's data.
 *
 * ─── Why this is not just "overwrite the map from the DB" ───
 *
 * An assignment may name someone who has no Paperclip account: they have never
 * signed in, so there is no `user.id` to hang an `agent_memberships` row on. On
 * the live instance that is 7 of 43 entries. Projecting the DB over the map
 * would delete them and the bot would start turning those people away. So map
 * entries are only ever removed when this reconciler put them there
 * (`source === ASSIGNMENT_SYNC_SOURCE`) or when they point at an agent that no
 * longer exists. A hand-made entry for an account-less person is permanent.
 *
 * The same protection runs the other way, and the schema already promises it:
 * `agent_memberships.source` defaults to `"manual"` precisely so that a row
 * created by any other path is treated as hand-made. This reconciler deletes
 * only rows carrying its OWN source. A membership made in the Paperclip UI, or
 * claimed at login, is never removed by a Chat-side edit.
 *
 * ─── Ordering ───
 *
 * map → DB is computed BEFORE DB → map. An admin who has just typed a new
 * assignment on the 代理指派 page has a map entry and no membership yet; running
 * DB → map first would read that as "no membership, so drop it" and revert the
 * edit on the next sync. Inserting first, then projecting, makes the page's
 * edits durable — which is the whole point of keeping it editable.
 *
 * ─── One agent per person, in a many-to-many world ───
 *
 * A user may own several agents; the map holds one. When that happens the
 * reconciler keeps whatever the map already names (no churn) and reports the
 * rest in `unrepresented` rather than picking silently. The bot answers as one
 * agent; Paperclip still shows the person all of theirs.
 *
 * PURE core + unit tests here; DB wiring at the bottom, routes in
 * server/src/routes/agent-assignments.ts.
 */

import type { Db } from "@paperclipai/db";
import { agentMemberships, agents, authUsers, pluginState } from "@paperclipai/db";
import { eq } from "drizzle-orm";

/** Source tag for rows and entries this reconciler owns — and may delete. */
export const ASSIGNMENT_SYNC_SOURCE = "google_chat_assignment";

/** Default for anything created outside a reconciler. Never auto-deleted. */
export const MANUAL_SOURCE = "manual";

/** The plugin_state key holding the 代理指派 map. */
export const ASSIGNMENT_STATE_KEY = "agent-assignments";

/** Membership states that count as a live mapping. */
const LIVE_MEMBERSHIP_STATE = "joined";

export type MembershipRecord = {
  id: string;
  companyId: string;
  agentId: string;
  userId: string;
  source: string;
  state: string;
  /** Used only to break ties deterministically when a user owns several agents. */
  createdAt?: Date | string | null;
};

export type AssignmentRecord = {
  /** Original-case email as entered, for display. */
  email: string;
  agentId: string;
  agentName?: string;
  companyId: string;
  updatedAt: string;
  /**
   * Provenance. Absent means hand-made (the map predates this field), which is
   * the safe reading: hand-made entries are never auto-removed.
   */
  source?: string;
};

export type AgentFacts = {
  id: string;
  name: string;
  companyId: string;
  status: string;
};

export type ReconcileInput = {
  memberships: readonly MembershipRecord[];
  /** Keyed by LOWERCASED email. */
  assignments: Readonly<Record<string, AssignmentRecord>>;
  emailByUserId: ReadonlyMap<string, string>;
  userIdByEmail: ReadonlyMap<string, string>;
  agentsById: ReadonlyMap<string, AgentFacts>;
  /** ISO timestamp stamped onto entries this run touches. */
  now: string;
};

export type MembershipInsert = {
  companyId: string;
  agentId: string;
  userId: string;
  source: string;
};

export type ReconcilePlan = {
  /** Entries to write into the map, keyed by lowercased email. */
  mapUpserts: AssignmentRecord[];
  /** Lowercased emails to drop from the map. */
  mapRemovals: { email: string; reason: string }[];
  /** Memberships to create because the 代理指派 page named them. */
  dbInserts: MembershipInsert[];
  /** Membership ids to delete — only ever rows this reconciler owns. */
  dbRemovals: { id: string; reason: string }[];
  /** Map entries for people with no Paperclip account. Preserved, not synced. */
  unresolvedEmails: string[];
  /** Extra agents a person owns that the single-agent map cannot express. */
  unrepresented: { email: string; agentIds: string[] }[];
};

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** An agent that can still answer: it exists and has not been terminated. */
function isLiveAgent(agent: AgentFacts | undefined): agent is AgentFacts {
  return !!agent && agent.status !== "terminated";
}

function tieBreak(a: MembershipRecord, b: MembershipRecord): number {
  const at = a.createdAt ? new Date(a.createdAt).getTime() : 0;
  const bt = b.createdAt ? new Date(b.createdAt).getTime() : 0;
  if (at !== bt) return at - bt;
  return a.agentId.localeCompare(b.agentId);
}

/**
 * Compute the changes that would make both stores agree. Pure: it reads the two
 * snapshots and returns a plan, touching nothing.
 */
export function reconcileAgentAssignments(input: ReconcileInput): ReconcilePlan {
  const { memberships, assignments, emailByUserId, userIdByEmail, agentsById, now } = input;

  const plan: ReconcilePlan = {
    mapUpserts: [],
    mapRemovals: [],
    dbInserts: [],
    dbRemovals: [],
    unresolvedEmails: [],
    unrepresented: [],
  };

  // Memberships that can actually be projected: joined, live agent, and a user
  // we can name by email (the map's key). Anything else is left strictly alone.
  const live = memberships.filter(
    (m) => m.state === LIVE_MEMBERSHIP_STATE && isLiveAgent(agentsById.get(m.agentId)),
  );

  const membershipKey = (companyId: string, userId: string, agentId: string) =>
    `${companyId}|${userId}|${agentId}`;
  const existingKeys = new Set(live.map((m) => membershipKey(m.companyId, m.userId, m.agentId)));

  // ─── Pass 1: map → DB, and the promotion handshake ──────────────────────
  //
  // Runs first so a just-typed assignment becomes a membership before the
  // projection below decides what the map should say. See the ordering note in
  // the file header.
  //
  // An entry's provenance decides which store leads, and it changes exactly
  // once — the handshake that keeps this convergent:
  //
  //   hand-made (source absent or "manual")
  //       An admin typed it. Promote it to a membership, and stamp it as
  //       derived from that moment on. Never removed while it is hand-made,
  //       which is what makes an account-less person's entry permanent.
  //
  //   derived (source === ASSIGNMENT_SYNC_SOURCE)
  //       This reconciler wrote it from a membership. If that membership is
  //       gone, the entry goes too (pass 4) instead of being re-inserted.
  //
  // Without the stamp, every entry would stay hand-made forever and keep
  // re-creating its membership — so revoking access by deleting the membership
  // in Paperclip would silently never take effect.
  const promoted = new Set<string>();

  for (const [rawKey, entry] of Object.entries(assignments)) {
    const email = normalizeEmail(rawKey || entry.email || "");
    if (!email) continue;

    const agent = agentsById.get(entry.agentId);
    if (!isLiveAgent(agent)) {
      // Points at an agent that is gone or terminated. Dead either way, so this
      // is removed regardless of provenance — keeping it would only make the bot
      // route to nothing. Reported so the removal is never silent.
      plan.mapRemovals.push({
        email,
        reason: agent ? `agent ${entry.agentId} is terminated` : `agent ${entry.agentId} no longer exists`,
      });
      continue;
    }

    const userId = userIdByEmail.get(email);
    if (!userId) {
      // No Paperclip account — cannot become a membership, so it can never be
      // promoted, so it stays hand-made and is never removed. This is the
      // 7-of-43 case the file header describes.
      plan.unresolvedEmails.push(email);
      continue;
    }

    const derived = entry.source === ASSIGNMENT_SYNC_SOURCE;
    const key = membershipKey(entry.companyId, userId, entry.agentId);

    if (!existingKeys.has(key)) {
      if (derived) continue; // Membership revoked in Paperclip — let it go.
      plan.dbInserts.push({
        companyId: entry.companyId,
        agentId: entry.agentId,
        userId,
        source: ASSIGNMENT_SYNC_SOURCE,
      });
      existingKeys.add(key);
    }
    // Stamp on promotion AND when a hand entry already agrees with a
    // membership: either way the DB now backs it, so it is derived from here.
    if (!derived) promoted.add(email);
  }

  // Keyed so an entry that is both promoted here and refreshed by the
  // projection below yields ONE upsert, not two conflicting ones.
  const upserts = new Map<string, AssignmentRecord>();
  for (const email of promoted) {
    upserts.set(email, { ...assignments[email], updatedAt: now, source: ASSIGNMENT_SYNC_SOURCE });
  }

  // ─── Pass 2: memberships the page has retracted ─────────────────────────
  //
  // Computed BEFORE the projection below, not after: a membership this
  // reconciler created whose assignment has since been deleted is on its way
  // out, so projecting it back into the map would re-add the very entry the
  // admin just removed — and then delete the membership anyway, leaving the two
  // stores permanently disagreeing. Deciding removals first keeps the run
  // internally consistent.
  //
  // Only rows carrying this reconciler's own source are eligible. "manual" and
  // "claimed_on_login" rows are never retracted by a Chat-side edit; they get
  // projected back into the map instead.
  for (const m of live) {
    if (m.source !== ASSIGNMENT_SYNC_SOURCE) continue;
    const email = emailByUserId.get(m.userId);
    const entry = email ? assignments[normalizeEmail(email)] : undefined;
    if (!entry || entry.agentId !== m.agentId) {
      plan.dbRemovals.push({ id: m.id, reason: "assignment removed on the 代理指派 page" });
    }
  }
  const doomed = new Set(plan.dbRemovals.map((r) => r.id));

  // Treat pass-1 inserts as present, so the projection sees the post-insert
  // world; drop the retracted rows, so it does not see the pre-removal one.
  const projected: MembershipRecord[] = [
    ...live.filter((m) => !doomed.has(m.id)),
    ...plan.dbInserts.map((i) => ({
      id: `pending:${i.companyId}|${i.userId}|${i.agentId}`,
      companyId: i.companyId,
      agentId: i.agentId,
      userId: i.userId,
      source: i.source,
      state: LIVE_MEMBERSHIP_STATE,
      createdAt: now,
    })),
  ];

  // ─── Pass 3: DB → map ───────────────────────────────────────────────────
  const byUser = new Map<string, MembershipRecord[]>();
  for (const m of projected) {
    const list = byUser.get(m.userId);
    if (list) list.push(m);
    else byUser.set(m.userId, [m]);
  }

  const removedEmails = new Set(plan.mapRemovals.map((r) => r.email));
  const keptEmails = new Set<string>();

  for (const [userId, rows] of byUser) {
    const email = emailByUserId.get(userId);
    if (!email) continue; // Cannot key the map without an email — leave it be.
    const normalized = normalizeEmail(email);
    if (removedEmails.has(normalized)) continue; // Already dropped above.

    const sorted = [...rows].sort(tieBreak);
    const current = assignments[normalized];

    // Keep whatever the map already names if the person really owns it — this
    // is what stops a multi-agent owner from flip-flopping between syncs.
    const chosen = sorted.find((m) => m.agentId === current?.agentId) ?? sorted[0];
    keptEmails.add(normalized);

    if (sorted.length > 1) {
      plan.unrepresented.push({
        email: normalized,
        agentIds: sorted.filter((m) => m.agentId !== chosen.agentId).map((m) => m.agentId),
      });
    }

    const agent = agentsById.get(chosen.agentId);
    if (!agent) continue; // Filtered above; defensive.

    const needsWrite =
      !current ||
      current.agentId !== chosen.agentId ||
      current.companyId !== chosen.companyId ||
      current.agentName !== agent.name;

    if (needsWrite) {
      upserts.set(normalized, {
        // Preserve the original-case email an admin typed, when we have one.
        email: current?.email ?? email,
        agentId: chosen.agentId,
        agentName: agent.name,
        companyId: chosen.companyId,
        updatedAt: now,
        source: ASSIGNMENT_SYNC_SOURCE,
      });
    }
  }

  // ─── Pass 4: map entries whose membership went away ─────────────────────
  //
  // Mirrors pass 2 on the other side: only entries this reconciler created are
  // eligible. A hand-made entry (source absent or "manual") is never removed,
  // which is what makes an assignment for an account-less person permanent.
  const unresolved = new Set(plan.unresolvedEmails);
  for (const [rawKey, entry] of Object.entries(assignments)) {
    const email = normalizeEmail(rawKey || entry.email || "");
    if (!email || removedEmails.has(email) || keptEmails.has(email)) continue;
    // A derived entry whose user account has since been deleted is left alone:
    // its membership is unreachable, so removing the entry would break the bot
    // for that person with no way to reason about whether that is intended.
    if (unresolved.has(email)) continue;
    if (entry.source === ASSIGNMENT_SYNC_SOURCE) {
      plan.mapRemovals.push({ email, reason: "membership removed in Paperclip" });
    }
  }

  // A removal always wins over an upsert for the same email — the entry points
  // at a dead agent, so re-stamping it would only resurrect a broken route.
  for (const removal of plan.mapRemovals) upserts.delete(removal.email);
  plan.mapUpserts = [...upserts.values()];

  return plan;
}

/** True when the plan would change nothing — useful for skipping writes. */
export function isNoopPlan(plan: ReconcilePlan): boolean {
  return (
    plan.mapUpserts.length === 0 &&
    plan.mapRemovals.length === 0 &&
    plan.dbInserts.length === 0 &&
    plan.dbRemovals.length === 0
  );
}

/** Apply a plan to an assignment map, returning a new map. Pure. */
export function applyPlanToAssignments(
  assignments: Readonly<Record<string, AssignmentRecord>>,
  plan: ReconcilePlan,
): Record<string, AssignmentRecord> {
  const next: Record<string, AssignmentRecord> = { ...assignments };
  for (const removal of plan.mapRemovals) delete next[removal.email];
  for (const upsert of plan.mapUpserts) next[normalizeEmail(upsert.email)] = upsert;
  return next;
}

// ---------------------------------------------------------------------------
// DB wiring
// ---------------------------------------------------------------------------

export type SyncOptions = {
  /** Limit the run to one company. Omit to reconcile the whole instance. */
  companyId?: string;
  /** Compute the plan and report it without writing anything. */
  dryRun?: boolean;
};

export type SyncResult = ReconcilePlan & {
  applied: boolean;
  /** Assignment-map rows scanned; the map is instance-scoped, not per company. */
  assignmentCount: number;
  membershipCount: number;
};

/**
 * Read both stores, reconcile, and (unless `dryRun`) write the result back.
 *
 * The assignment map lives in `plugin_state` under an instance scope, so it is
 * read and written whole. Membership writes are scoped to the plan.
 */
export async function syncAgentAssignments(db: Db, options: SyncOptions = {}): Promise<SyncResult> {
  const { companyId, dryRun = false } = options;

  const [membershipRows, stateRows, userRows, agentRows] = await Promise.all([
    companyId
      ? db.select().from(agentMemberships).where(eq(agentMemberships.companyId, companyId))
      : db.select().from(agentMemberships),
    db.select().from(pluginState).where(eq(pluginState.stateKey, ASSIGNMENT_STATE_KEY)),
    db.select({ id: authUsers.id, email: authUsers.email }).from(authUsers),
    db.select().from(agents),
  ]);

  // There is one map per installed plugin holding this key; in practice that is
  // the Google Chat plugin alone. Reconcile each independently so a second
  // installation cannot clobber the first.
  const emailByUserId = new Map<string, string>();
  const userIdByEmail = new Map<string, string>();
  for (const u of userRows) {
    const email = u.email?.trim().toLowerCase();
    if (!email) continue;
    emailByUserId.set(u.id, email);
    userIdByEmail.set(email, u.id);
  }

  const agentsById = new Map<string, AgentFacts>(
    agentRows.map((a) => [a.id, { id: a.id, name: a.name, companyId: a.companyId, status: a.status }]),
  );

  const memberships: MembershipRecord[] = membershipRows.map((m) => ({
    id: m.id,
    companyId: m.companyId,
    agentId: m.agentId,
    userId: m.userId,
    source: m.source,
    state: m.state,
    createdAt: m.createdAt,
  }));

  const merged: ReconcilePlan = {
    mapUpserts: [],
    mapRemovals: [],
    dbInserts: [],
    dbRemovals: [],
    unresolvedEmails: [],
    unrepresented: [],
  };
  let assignmentCount = 0;

  for (const row of stateRows) {
    const assignments = (row.valueJson as Record<string, AssignmentRecord> | null) ?? {};
    // When scoped to one company, ignore entries belonging to other companies —
    // otherwise a company-scoped run would delete their memberships as "not in
    // the map" using a membership list it never loaded.
    const scoped = companyId
      ? Object.fromEntries(Object.entries(assignments).filter(([, v]) => v?.companyId === companyId))
      : assignments;
    assignmentCount += Object.keys(scoped).length;

    const plan = reconcileAgentAssignments({
      memberships,
      assignments: scoped,
      emailByUserId,
      userIdByEmail,
      agentsById,
      now: new Date().toISOString(),
    });

    merged.mapUpserts.push(...plan.mapUpserts);
    merged.mapRemovals.push(...plan.mapRemovals);
    merged.dbInserts.push(...plan.dbInserts);
    merged.dbRemovals.push(...plan.dbRemovals);
    merged.unresolvedEmails.push(...plan.unresolvedEmails);
    merged.unrepresented.push(...plan.unrepresented);

    if (dryRun || isNoopPlan(plan)) continue;

    // Re-merge into the FULL map, not the scoped view, so a company-scoped run
    // leaves other companies' entries in place.
    const nextMap = applyPlanToAssignments(assignments, plan);
    await db
      .update(pluginState)
      .set({ valueJson: nextMap, updatedAt: new Date() })
      .where(eq(pluginState.id, row.id));
  }

  if (!dryRun) {
    for (const insert of merged.dbInserts) {
      await db
        .insert(agentMemberships)
        .values({ ...insert, state: "joined" })
        .onConflictDoNothing();
    }
    for (const removal of merged.dbRemovals) {
      await db.delete(agentMemberships).where(eq(agentMemberships.id, removal.id));
    }
  }

  return {
    ...merged,
    applied: !dryRun,
    assignmentCount,
    membershipCount: memberships.length,
  };
}
