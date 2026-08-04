/**
 * Personal memory — DB is the source of truth, disk is a materialized copy.
 *
 * Every read and write goes through `personal-memory-access.ts`; this module
 * adds the I/O and one thing that primitive cannot express: resolving WHICH
 * user an agent-authenticated caller counts as.
 *
 * That resolution is the security-critical step. It reads `agent_memberships`
 * for the agent, and never looks at the request's actor. `requesterForAgent`
 * exists so no route has to remember that — a route that reaches for
 * `req.actor.userId` on an agent request has already lost.
 *
 * Materialization is one-way: DB → disk. An agent editing the files in its
 * workspace changes nothing, so it can never grant itself memory it was not
 * given, and a rebuilt workspace loses nothing.
 *
 * ─── The write path is a gate, not a passthrough ───
 *
 * `upsertPersonalMemory` is the only way anything is stored, and it enforces
 * what the agent prompt merely asks for: a closed set of categories, a screen
 * against secrets and against agents filing health, money or ID details about a
 * person, length ceilings, a rolling cap on new entries, and duplicate
 * detection. The rules themselves are pure and live in
 * @paperclipai/shared/memory-classification; this module supplies the DB the
 * duplicate and rate checks need.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { agentMemberships, userMemories, userMemorySettings } from "@paperclipai/db";
import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import {
  AGENT_MEMORY_MAX_CONTENT_CHARS,
  AGENT_MEMORY_MAX_DESCRIPTION_CHARS,
  AGENT_MEMORY_WRITES_PER_HOUR,
  MEMORY_CATEGORY_IDS,
  MEMORY_CATEGORY_LABELS,
  MEMORY_RECOVERY_WINDOW_DAYS,
  isReservedMemoryName,
  memoryStrength,
  normalizeMemoryCategory,
  normalizeMemoryForComparison,
  screenMemoryWrite,
  type MemoryCategory,
  type MemoryScreenClass,
  type MemoryStrength,
} from "@paperclipai/shared";
import { resolveUserMemoryDir } from "../home-paths.js";
import {
  canReadPersonalMemory,
  canWritePersonalMemory,
  readableMemoryOwnerIds,
  resolveAgentMappedUserId,
  type MemoryRequester,
} from "./personal-memory-access.js";

export type MemoryRecord = {
  id: string;
  companyId: string;
  userId: string;
  name: string;
  description: string;
  memoryType: string;
  content: string;
  source: string;
  filePath: string | null;
  isBinary: boolean;
  timesObserved: number;
  lastObservedAt: Date | null;
  createdByAgentId: string | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Live rows only.
 *
 * Deletion is soft (see `user_memories.deleted_at`), which means every query in
 * this module has to say so. One predicate rather than the same `isNull`
 * repeated inline: the failure mode of soft deletion is a single forgotten one,
 * which resurrects deleted memories in a single view and nowhere else — the
 * hardest kind of bug to notice. The recovery reader is the only caller that
 * omits it, and says why.
 *
 * A function, not a module-level constant. Evaluating a schema column at import
 * time makes this module unloadable for any test that mocks `@paperclipai/db`
 * partially, and it fails as an import error pointing at this line rather than
 * at the mock — an unhelpful trap to leave for whoever writes that test next.
 */
const liveMemory = () => isNull(userMemories.deletedAt);

/**
 * Why a write was refused, or the row it produced.
 *
 * A result type rather than `null`, because the four refusals mean genuinely
 * different things and the caller has to tell them apart: "you may not write
 * here" must stay indistinguishable from "no such owner", while "this looks
 * like a password" is something the writer should be told so it can fix it. An
 * agent that gets a bare failure learns nothing and tries again identically.
 */
export type MemoryWriteRefusal = {
  ok: false;
  reason: "forbidden" | "screened" | "too_long" | "rate_limited" | "capture_paused" | "reserved_name";
  message: string;
  screenClass?: MemoryScreenClass;
};

export type MemoryWriteResult =
  | { ok: true; memory: MemoryRecord; deduped: boolean }
  | MemoryWriteRefusal;

/**
 * Build the requester for an agent-authenticated caller.
 *
 * The acting user is deliberately not a parameter. An agent's memory follows
 * the agent's mapping, so a campus head driving a member's agent reaches the
 * member's memory and nothing else.
 */
export async function requesterForAgent(
  db: Db,
  input: { companyId: string; agentId: string },
): Promise<MemoryRequester> {
  const rows = await db
    .select({ agentId: agentMemberships.agentId, userId: agentMemberships.userId, state: agentMemberships.state })
    .from(agentMemberships)
    .where(and(eq(agentMemberships.companyId, input.companyId), eq(agentMemberships.agentId, input.agentId)));

  return {
    kind: "agent",
    agentId: input.agentId,
    mappedUserId: resolveAgentMappedUserId(rows, input.agentId),
  };
}

/** List the memories this requester may read, newest first. */
export async function listPersonalMemories(
  db: Db,
  input: { companyId: string; requester: MemoryRequester; ownerUserId?: string },
): Promise<MemoryRecord[]> {
  const allowed = readableMemoryOwnerIds(input.requester);

  // `null` means unrestricted (an admin) and MUST be handled separately — an
  // empty array means "nothing", and conflating the two would turn an unmapped
  // agent into an admin.
  if (allowed !== null && allowed.length === 0) return [];

  const owners = allowed === null ? (input.ownerUserId ? [input.ownerUserId] : null) : allowed;
  if (owners && input.ownerUserId && !owners.includes(input.ownerUserId)) return [];

  const rows = await db
    .select()
    .from(userMemories)
    .where(
      owners
        ? and(eq(userMemories.companyId, input.companyId), inArray(userMemories.userId, owners), liveMemory())
        : and(eq(userMemories.companyId, input.companyId), liveMemory()),
    );

  return rows
    .filter((row) => canReadPersonalMemory({ ownerUserId: row.userId }, input.requester))
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()) as MemoryRecord[];
}

/**
 * Recently deleted memories, newest first.
 *
 * The one reader that deliberately looks past `deleted_at`, because showing the
 * owner what they removed — and letting them take it back — is the entire point
 * of soft deletion. Read-only to the owner and to admins under the same rule as
 * everything else; an agent asking for this gets its own deleted entries and
 * nothing more, which is harmless and occasionally useful (it can see that a
 * fact it keeps re-deriving was deliberately thrown away).
 */
export async function listDeletedPersonalMemories(
  db: Db,
  input: { companyId: string; requester: MemoryRequester; ownerUserId: string },
): Promise<MemoryRecord[]> {
  if (!canReadPersonalMemory({ ownerUserId: input.ownerUserId }, input.requester)) return [];

  const rows = (await db
    .select()
    .from(userMemories)
    .where(
      and(
        eq(userMemories.companyId, input.companyId),
        eq(userMemories.userId, input.ownerUserId),
        isNotNull(userMemories.deletedAt),
      ),
    )) as MemoryRecord[];

  return rows.sort((a, b) => (b.deletedAt?.getTime() ?? 0) - (a.deletedAt?.getTime() ?? 0));
}

/**
 * Rows an agent write is compared against for duplicates.
 *
 * Bounded to small non-binary entries: this is here to stop an agent filing the
 * same fact under `meeting-notes` and then `meeting-notes-2`, and a large
 * imported document is neither a candidate nor cheap to pull. Skipping the
 * check is always safe — it costs a duplicate row, not correctness.
 */
const DEDUPE_CANDIDATE_MAX_BYTES = 8192;

/**
 * Create, replace, or recognise a memory as one already held.
 *
 * The order of the gates is the design. Permission first, because nothing else
 * is worth computing for a caller who may not write. Then the limits and the
 * screen, which apply to what is being said. Then duplicates, which need to
 * know what is already stored. An agent that trips a gate gets told which one.
 */
export async function upsertPersonalMemory(
  db: Db,
  input: {
    companyId: string;
    ownerUserId: string;
    requester: MemoryRequester;
    name: string;
    description?: string;
    memoryType?: string;
    content: string;
    source?: string;
    filePath?: string | null;
    isBinary?: boolean;
    createdByAgentId?: string | null;
    /** The fact's own date (e.g. from an imported "[2024-11-28] - …"), used to
     *  seed recency so old imported facts read cold rather than hot. */
    observedAt?: Date | null;
    /** Groups entries from one import/paste action for batch history. */
    importBatchId?: string | null;
  },
): Promise<MemoryWriteResult> {
  if (!canWritePersonalMemory({ ownerUserId: input.ownerUserId }, input.requester)) {
    return { ok: false, reason: "forbidden", message: "Memory not found" };
  }

  // A memory is addressed as /memories/{name}, so a name that collides with a
  // sibling endpoint is refused here rather than left to route-registration
  // order to resolve. Applies to everyone: the clash is structural, not a
  // question of who is writing.
  if (isReservedMemoryName(input.name)) {
    return {
      ok: false,
      reason: "reserved_name",
      message: `"${input.name}" is reserved by the memory API and cannot be used as a name. Pick a more specific slug.`,
    };
  }

  // Who is REALLY writing, from the authenticated requester — never from the
  // body. The whole screen is asymmetric between agents and owners, so a body
  // field that could claim to be the owner would be the way around it.
  const authoredBy = input.requester.kind === "agent" ? "agent" : "user";
  const isBinary = input.isBinary ?? false;
  const content = input.content;
  const description = input.description ?? "";

  if (authoredBy === "agent" && !isBinary) {
    if (content.length > AGENT_MEMORY_MAX_CONTENT_CHARS) {
      return {
        ok: false,
        reason: "too_long",
        message: `Memory is ${content.length} characters; the limit for an agent is ${AGENT_MEMORY_MAX_CONTENT_CHARS}. Store the durable fact, not the transcript that led to it.`,
      };
    }
    if (description.length > AGENT_MEMORY_MAX_DESCRIPTION_CHARS) {
      return {
        ok: false,
        reason: "too_long",
        message: `Description is ${description.length} characters; the limit is ${AGENT_MEMORY_MAX_DESCRIPTION_CHARS}. It is a one-line summary used to judge relevance.`,
      };
    }
  }

  // The owner's switch, checked before anything is inspected. Paused means
  // agents stop writing entirely — not that their writes are screened harder —
  // so an agent gets one clear answer instead of a per-write judgement it has
  // to keep re-testing. The owner is unaffected: pausing is about what gets
  // inferred about you, not about your own notes.
  if (authoredBy === "agent" && !(await memoryCaptureEnabled(db, input.companyId, input.ownerUserId))) {
    return {
      ok: false,
      reason: "capture_paused",
      message:
        "This person has paused memory capture, so agents may not save anything for them right now. Do not retry; carry on with the task.",
    };
  }

  const verdict = screenMemoryWrite({ content, description, name: input.name, authoredBy, isBinary });
  if (!verdict.allowed) {
    return {
      ok: false,
      reason: "screened",
      screenClass: verdict.screenClass,
      message: `Refused: this ${verdict.reason}`,
    };
  }

  const existing = await findMemoryByName(db, input);

  if (authoredBy === "agent" && !existing) {
    // Only creations are rate limited. An agent revising a fact it already
    // holds is the behaviour we want; it is the stream of NEW entries that
    // turns a memory into a log.
    const recent = await countRecentAgentMemories(db, input);
    if (recent >= AGENT_MEMORY_WRITES_PER_HOUR) {
      return {
        ok: false,
        reason: "rate_limited",
        message: `This user's agents have already saved ${recent} new memories in the past hour, which is the limit. Revise an existing entry by reusing its name instead of adding another.`,
      };
    }

    // Same fact, different slug — recognise it rather than storing it twice.
    const duplicate = await findMemoryByContent(db, { ...input, content });
    if (duplicate) {
      const observed = await recordObservation(db, duplicate.id);
      return { ok: true, memory: observed ?? duplicate, deduped: true };
    }
  }

  const now = new Date();
  const values = {
    companyId: input.companyId,
    userId: input.ownerUserId,
    name: input.name,
    description,
    // One place decides what a category is; a caller cannot invent one.
    memoryType: normalizeMemoryCategory(input.memoryType),
    content,
    source: input.source ?? "manual",
    filePath: input.filePath ?? null,
    isBinary,
    byteSize: Buffer.byteLength(content, isBinary ? "base64" : "utf8"),
    sha256: createHash("sha256").update(content).digest("hex"),
    createdByAgentId: input.createdByAgentId ?? null,
    importBatchId: input.importBatchId ?? null,
    // Recency date: the imported fact's own date if given, else "now" for an
    // agent observation, else null (a freshly-typed note has no prior date).
    lastObservedAt: input.observedAt ?? (authoredBy === "agent" ? now : null),
    updatedAt: now,
  };

  const [row] = await db
    .insert(userMemories)
    .values(values)
    .onConflictDoUpdate({
      target: [userMemories.companyId, userMemories.userId, userMemories.name],
      // The unique index is partial (live rows only), so the predicate has to be
      // restated here for Postgres to infer it. Without `targetWhere` this is an
      // "no unique constraint matching" error at runtime — and only once a row
      // exists, which is exactly the case a happy-path test misses.
      targetWhere: isNull(userMemories.deletedAt),
      set: {
        description: values.description,
        memoryType: values.memoryType,
        content: values.content,
        source: values.source,
        filePath: values.filePath,
        isBinary: values.isBinary,
        byteSize: values.byteSize,
        sha256: values.sha256,
        // An agent arriving at the same fact again is a confirmation and counts;
        // the owner editing their own words is a correction and does not.
        ...(authoredBy === "agent"
          ? {
              timesObserved: sql`${userMemories.timesObserved} + 1`,
              lastObservedAt: now,
            }
          : {}),
        // Re-importing (same name) must refresh recency + batch, so a re-paste
        // actually updates dates/history instead of silently keeping the old ones.
        ...(input.observedAt ? { lastObservedAt: input.observedAt } : {}),
        ...(input.importBatchId ? { importBatchId: input.importBatchId } : {}),
        updatedAt: values.updatedAt,
      },
    })
    .returning();

  if (!row) return { ok: false, reason: "forbidden", message: "Memory not found" };
  return { ok: true, memory: row as MemoryRecord, deduped: false };
}

/** The owner's entry under this exact slug, if there is one. */
async function findMemoryByName(
  db: Db,
  input: { companyId: string; ownerUserId: string; name: string },
): Promise<MemoryRecord | null> {
  const [row] = await db
    .select()
    .from(userMemories)
    .where(
      and(
        eq(userMemories.companyId, input.companyId),
        eq(userMemories.userId, input.ownerUserId),
        eq(userMemories.name, input.name),
        liveMemory(),
      ),
    )
    .limit(1);
  return (row as MemoryRecord) ?? null;
}

/** An entry already saying this, under any slug. Compared after normalization. */
async function findMemoryByContent(
  db: Db,
  input: { companyId: string; ownerUserId: string; content: string },
): Promise<MemoryRecord | null> {
  const target = normalizeMemoryForComparison(input.content);
  if (!target) return null;

  const rows = (await db
    .select()
    .from(userMemories)
    .where(
      and(
        eq(userMemories.companyId, input.companyId),
        eq(userMemories.userId, input.ownerUserId),
        eq(userMemories.isBinary, false),
        lt(userMemories.byteSize, DEDUPE_CANDIDATE_MAX_BYTES),
        // A deleted memory is not a duplicate. If the owner threw a fact away
        // and an agent concludes it again, that is a new write they can judge
        // afresh — folding it into the tombstone would leave the agent thinking
        // it saved something that nobody can see.
        liveMemory(),
      ),
    )) as MemoryRecord[];

  return rows.find((row) => normalizeMemoryForComparison(row.content) === target) ?? null;
}

/** Count this owner's agent-written memories created in the last hour. */
async function countRecentAgentMemories(
  db: Db,
  input: { companyId: string; ownerUserId: string },
): Promise<number> {
  const since = new Date(Date.now() - 60 * 60 * 1000);
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(userMemories)
    .where(
      and(
        eq(userMemories.companyId, input.companyId),
        eq(userMemories.userId, input.ownerUserId),
        eq(userMemories.source, "agent"),
        gte(userMemories.createdAt, since),
        // Deleting a bad entry should give the hour's budget back, otherwise
        // clearing up after an agent silences it for the rest of the hour.
        liveMemory(),
      ),
    );
  return Number(row?.count ?? 0);
}

// ---------------------------------------------------------------------------
// The owner's switches
// ---------------------------------------------------------------------------

export type MemorySettings = { captureEnabled: boolean };

/**
 * Read a user's switches.
 *
 * A missing row means enabled. Capture is on by default and a person who has
 * never opened their Memory page must not need a row to exist before their
 * agents can remember anything.
 */
export async function getMemorySettings(
  db: Db,
  input: { companyId: string; userId: string },
): Promise<MemorySettings> {
  const [row] = await db
    .select({ captureEnabled: userMemorySettings.captureEnabled })
    .from(userMemorySettings)
    .where(
      and(eq(userMemorySettings.companyId, input.companyId), eq(userMemorySettings.userId, input.userId)),
    )
    .limit(1);
  return { captureEnabled: row?.captureEnabled ?? true };
}

async function memoryCaptureEnabled(db: Db, companyId: string, userId: string): Promise<boolean> {
  return (await getMemorySettings(db, { companyId, userId })).captureEnabled;
}

/**
 * Set a user's switches.
 *
 * Gated on WRITE, not read: an admin may read someone's memory but pausing
 * their agents' capture is a decision about how that person works, and it
 * belongs to them. `canWritePersonalMemory` already draws that line.
 */
export async function setMemorySettings(
  db: Db,
  input: {
    companyId: string;
    ownerUserId: string;
    requester: MemoryRequester;
    captureEnabled: boolean;
  },
): Promise<MemorySettings | null> {
  if (!canWritePersonalMemory({ ownerUserId: input.ownerUserId }, input.requester)) return null;
  // An agent turning its own leash off would defeat the switch entirely.
  if (input.requester.kind !== "user") return null;

  const [row] = await db
    .insert(userMemorySettings)
    .values({
      companyId: input.companyId,
      userId: input.ownerUserId,
      captureEnabled: input.captureEnabled,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [userMemorySettings.companyId, userMemorySettings.userId],
      set: { captureEnabled: input.captureEnabled, updatedAt: new Date() },
    })
    .returning({ captureEnabled: userMemorySettings.captureEnabled });

  return { captureEnabled: row?.captureEnabled ?? input.captureEnabled };
}

/** Note that an agent arrived at a stored fact again. */
async function recordObservation(db: Db, id: string): Promise<MemoryRecord | null> {
  const [row] = await db
    .update(userMemories)
    .set({ timesObserved: sql`${userMemories.timesObserved} + 1`, lastObservedAt: new Date() })
    .where(eq(userMemories.id, id))
    .returning();
  return (row as MemoryRecord) ?? null;
}

/**
 * A glance at whether memory is actually working.
 *
 * The reason this exists: capture used to be a line in a prompt, and the only
 * way to know whether agents were writing anything was to watch the page for a
 * few days and form an impression. Two numbers answer it — how many entries
 * agents have contributed, and when the last one landed.
 */
export type MemoryStats = {
  total: number;
  bySource: Record<string, number>;
  byType: Record<string, number>;
  /** Repetition made countable: how many entries are noted / confirmed / core. */
  byStrength: Record<MemoryStrength, number>;
  agentWrites: number;
  lastAgentWriteAt: Date | null;
  /** Recoverable tombstones, so the recovery view can announce itself. */
  deleted: number;
  captureEnabled: boolean;
};

export async function personalMemoryStats(
  db: Db,
  input: { companyId: string; ownerUserId: string; requester: MemoryRequester },
): Promise<MemoryStats | null> {
  if (!canReadPersonalMemory({ ownerUserId: input.ownerUserId }, input.requester)) return null;

  const rows = (await db
    .select({
      source: userMemories.source,
      memoryType: userMemories.memoryType,
      timesObserved: userMemories.timesObserved,
      createdAt: userMemories.createdAt,
      lastObservedAt: userMemories.lastObservedAt,
      deletedAt: userMemories.deletedAt,
    })
    .from(userMemories)
    .where(
      and(eq(userMemories.companyId, input.companyId), eq(userMemories.userId, input.ownerUserId)),
    )) as Array<{
      source: string;
      memoryType: string;
      timesObserved: number;
      createdAt: Date;
      lastObservedAt: Date | null;
      deletedAt: Date | null;
    }>;

  const bySource: Record<string, number> = {};
  const byType: Record<string, number> = {};
  const byStrength: Record<MemoryStrength, number> = { noted: 0, confirmed: 0, core: 0 };
  let lastAgentWriteAt: Date | null = null;
  let deleted = 0;
  let total = 0;

  for (const row of rows) {
    // Tombstones are counted, not summarised: a deleted memory is not part of
    // "what this person's memory holds", it is part of what they can get back.
    if (row.deletedAt) {
      deleted += 1;
      continue;
    }
    total += 1;
    bySource[row.source] = (bySource[row.source] ?? 0) + 1;
    const type = normalizeMemoryCategory(row.memoryType);
    byType[type] = (byType[type] ?? 0) + 1;
    byStrength[memoryStrength(row.timesObserved)] += 1;
    if (row.source === "agent") {
      // The later of "written" and "confirmed" — an agent re-observing an old
      // entry is just as much a sign that capture is alive as a new one.
      for (const stamp of [row.createdAt, row.lastObservedAt]) {
        if (stamp && (!lastAgentWriteAt || stamp > lastAgentWriteAt)) lastAgentWriteAt = stamp;
      }
    }
  }

  return {
    total,
    bySource,
    byType,
    byStrength,
    agentWrites: bySource.agent ?? 0,
    lastAgentWriteAt,
    deleted,
    captureEnabled: (await getMemorySettings(db, { companyId: input.companyId, userId: input.ownerUserId }))
      .captureEnabled,
  };
}

/**
 * Delete a memory.
 *
 * Soft by default: the row is tombstoned and stops being read, materialized or
 * deduplicated against immediately, but stays recoverable for
 * `MEMORY_RECOVERY_WINDOW_DAYS`. `purge: true` is the owner saying they meant
 * it — used by the recovery view's "delete forever", and by the expiry sweep.
 *
 * Returns false when the requester may not write, which the routes turn into
 * the same 404 as "no such memory".
 */
export async function deletePersonalMemory(
  db: Db,
  input: {
    companyId: string;
    ownerUserId: string;
    requester: MemoryRequester;
    name: string;
    purge?: boolean;
  },
): Promise<boolean> {
  if (!canWritePersonalMemory({ ownerUserId: input.ownerUserId }, input.requester)) return false;

  const owns = and(
    eq(userMemories.companyId, input.companyId),
    eq(userMemories.userId, input.ownerUserId),
    eq(userMemories.name, input.name),
  );

  if (input.purge) {
    /**
     * Purge the TOMBSTONES under this name, or the live row if there are none.
     *
     * A slug can hold both at once — save `foo`, delete it, save `foo` again —
     * and "delete forever" is only offered from the recovery view, where the
     * thing being purged is a tombstone. Deleting by name alone would take the
     * live entry with it: the owner clears an old copy and silently loses the
     * current one. So the tombstones go first, and the live row is only reached
     * when there is nothing else the caller could have meant.
     */
    const purgedTombstones = await db
      .delete(userMemories)
      .where(and(owns, isNotNull(userMemories.deletedAt)))
      .returning({ id: userMemories.id });
    if (purgedTombstones.length === 0) {
      await db.delete(userMemories).where(and(owns, liveMemory()));
    }
    return true;
  }

  // Only live rows: a second delete of an already-tombstoned memory must not
  // restart its recovery window, or a UI that retries would keep it alive.
  await db.update(userMemories).set({ deletedAt: new Date() }).where(and(owns, liveMemory()));
  return true;
}

/** One import/paste action, for the batch-history view. */
export type ImportBatch = {
  batchId: string;
  count: number;
  source: string;
  createdAt: Date;
  sample: string;
};

/** List this owner's live import batches, newest first. */
export async function listImportBatches(
  db: Db,
  input: { companyId: string; ownerUserId: string; requester: MemoryRequester },
): Promise<ImportBatch[]> {
  if (!canReadPersonalMemory({ ownerUserId: input.ownerUserId }, input.requester)) return [];
  const rows = await db
    .select({
      batchId: userMemories.importBatchId,
      count: sql<number>`count(*)::int`,
      createdAt: sql<Date>`min(${userMemories.createdAt})`,
      source: sql<string>`min(${userMemories.source})`,
      sample: sql<string>`min(${userMemories.content})`,
    })
    .from(userMemories)
    .where(and(
      eq(userMemories.companyId, input.companyId),
      eq(userMemories.userId, input.ownerUserId),
      isNotNull(userMemories.importBatchId),
      liveMemory(),
    ))
    .groupBy(userMemories.importBatchId)
    .orderBy(desc(sql`min(${userMemories.createdAt})`));
  return rows
    .filter((r): r is typeof r & { batchId: string } => Boolean(r.batchId))
    .map((r) => ({ batchId: r.batchId, count: r.count, source: r.source, createdAt: r.createdAt, sample: (r.sample ?? "").slice(0, 120) }));
}

/** Soft-delete every live memory in the given batches. Returns how many. */
export async function deleteImportBatches(
  db: Db,
  input: { companyId: string; ownerUserId: string; requester: MemoryRequester; batchIds: string[] },
): Promise<number> {
  if (!canWritePersonalMemory({ ownerUserId: input.ownerUserId }, input.requester)) return 0;
  if (input.batchIds.length === 0) return 0;
  const res = await db
    .update(userMemories)
    .set({ deletedAt: new Date() })
    .where(and(
      eq(userMemories.companyId, input.companyId),
      eq(userMemories.userId, input.ownerUserId),
      inArray(userMemories.importBatchId, input.batchIds),
      liveMemory(),
    ))
    .returning({ id: userMemories.id });
  return res.length;
}

/**
 * Take a deleted memory back.
 *
 * Refuses when a live memory already holds the slug rather than overwriting it
 * or silently renaming: both of those lose something the owner can see, and the
 * honest answer ("something else is called that now") is one they can act on.
 */
export type MemoryRestoreResult =
  | { ok: true; memory: MemoryRecord }
  | { ok: false; reason: "forbidden" | "not_found" | "name_taken"; message: string };

export async function restorePersonalMemory(
  db: Db,
  input: { companyId: string; ownerUserId: string; requester: MemoryRequester; name: string },
): Promise<MemoryRestoreResult> {
  if (!canWritePersonalMemory({ ownerUserId: input.ownerUserId }, input.requester)) {
    return { ok: false, reason: "forbidden", message: "Memory not found" };
  }

  const live = await findMemoryByName(db, input);
  if (live) {
    return {
      ok: false,
      reason: "name_taken",
      message: `A memory called "${input.name}" already exists. Rename or delete it first, then restore this one.`,
    };
  }

  /**
   * Restore exactly ONE tombstone — the newest.
   *
   * A slug can have several. The unique index only covers live rows, so
   * save `foo` → delete → save `foo` again → delete leaves two tombstones under
   * the same name, which is correct and is what makes re-saving a deleted fact
   * work at all. Restoring by name alone would clear `deleted_at` on both and
   * immediately violate that index; restoring the newest is also the one the
   * owner is looking at, since the recovery view is ordered by deletion time.
   */
  const [newest] = await db
    .select({ id: userMemories.id })
    .from(userMemories)
    .where(
      and(
        eq(userMemories.companyId, input.companyId),
        eq(userMemories.userId, input.ownerUserId),
        eq(userMemories.name, input.name),
        isNotNull(userMemories.deletedAt),
      ),
    )
    .orderBy(desc(userMemories.deletedAt))
    .limit(1);

  if (!newest) return { ok: false, reason: "not_found", message: "Memory not found" };

  const [row] = await db
    .update(userMemories)
    .set({ deletedAt: null, updatedAt: new Date() })
    .where(eq(userMemories.id, newest.id))
    .returning();

  if (!row) return { ok: false, reason: "not_found", message: "Memory not found" };
  return { ok: true, memory: row as MemoryRecord };
}

/**
 * Drop tombstones past the recovery window.
 *
 * Runs on the periodic sweep. Without it "soft delete" quietly means "never
 * delete", and a person who cleared something sensitive off their page would
 * find it still in the database a year later — which is not what deleting
 * looked like when they clicked it.
 */
export async function purgeExpiredMemories(
  db: Db,
  options?: { now?: Date },
): Promise<{ purged: number }> {
  const cutoff = new Date(
    (options?.now ?? new Date()).getTime() - MEMORY_RECOVERY_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );
  const rows = await db
    .delete(userMemories)
    .where(and(isNotNull(userMemories.deletedAt), lt(userMemories.deletedAt, cutoff)))
    .returning({ id: userMemories.id });
  return { purged: rows.length };
}

// ---------------------------------------------------------------------------
// Materialization (DB → disk)
// ---------------------------------------------------------------------------

/**
 * Confine a stored relative path to the owner's memory directory.
 *
 * `file_path` is preserved verbatim on import so a folder round-trips, which
 * means it is attacker-influenced text that this module hands to the
 * filesystem. Anything that escapes the directory — `../`, an absolute path, a
 * Windows drive, a NUL — is rejected rather than sanitized, because a path that
 * tried to escape is not a path whose corrected form should be trusted.
 *
 * Returns null when the path is unusable; callers fall back to `<name>.md`.
 */
export function safeMemoryRelativePath(rawPath: string | null | undefined): string | null {
  if (!rawPath) return null;
  const candidate = rawPath.trim();
  if (!candidate) return null;
  if (candidate.includes("\0")) return null;
  if (path.isAbsolute(candidate)) return null;
  if (/^[a-zA-Z]:/.test(candidate)) return null; // Windows drive-relative

  const normalized = path.normalize(candidate).replace(/\\/g, "/");
  if (normalized.startsWith("../") || normalized === ".." || normalized.startsWith("/")) return null;
  if (normalized.split("/").some((segment) => segment === "..")) return null;
  if (normalized === "." || normalized === "") return null;
  return normalized;
}

/** Filesystem-safe file name for a memory that has no import path. */
function fallbackFileName(name: string): string {
  const cleaned = name.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${cleaned || "memory"}.md`;
}

/** Render one memory as the markdown file an agent reads. */
export function renderMemoryFile(memory: Pick<MemoryRecord, "name" | "description" | "memoryType" | "content">): string {
  return [
    "---",
    `name: ${memory.name}`,
    `description: ${memory.description}`,
    "metadata:",
    `  type: ${memory.memoryType}`,
    "---",
    "",
    memory.content.endsWith("\n") ? memory.content : `${memory.content}\n`,
  ].join("\n");
}

export type MaterializeResult = {
  dir: string;
  written: string[];
  skipped: Array<{ name: string; reason: string }>;
};

/**
 * Write a user's memories to their directory.
 *
 * One-way by design: nothing on disk is read back into the DB, so an agent
 * editing these files cannot grant itself memory. Stale files from deleted
 * memories are removed so the directory always matches the DB exactly.
 */
export async function materializeUserMemory(
  db: Db,
  input: { companyId: string; userId: string },
): Promise<MaterializeResult> {
  const dir = resolveUserMemoryDir(input);
  const rows = (await db
    .select()
    .from(userMemories)
    .where(
      // Deleted memories stop reaching agents the moment they are deleted, not
      // when the recovery window closes. Recoverable is a promise to the owner,
      // not a grace period for the readers.
      and(eq(userMemories.companyId, input.companyId), eq(userMemories.userId, input.userId), liveMemory()),
    )) as MemoryRecord[];

  await fs.mkdir(dir, { recursive: true });

  const written: string[] = [];
  const skipped: MaterializeResult["skipped"] = [];
  /** Index lines grouped by category, so the reader can skip whole sections. */
  const indexByCategory = new Map<string, string[]>();

  for (const row of rows) {
    const relative = safeMemoryRelativePath(row.filePath) ?? fallbackFileName(row.name);
    const target = path.resolve(dir, relative);
    // Belt and braces: even after validation, refuse anything that did not land
    // inside the directory. A symlinked segment or an exotic normalization can
    // still surprise you, and this check costs nothing.
    if (target !== dir && !target.startsWith(dir + path.sep)) {
      skipped.push({ name: row.name, reason: `path escapes the memory directory: ${row.filePath}` });
      continue;
    }

    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(
      target,
      row.isBinary ? Buffer.from(row.content, "base64") : renderMemoryFile(row),
    );
    written.push(relative);
    if (!row.isBinary) {
      const category = normalizeMemoryCategory(row.memoryType);
      const seen = row.timesObserved > 1 ? ` (seen ${row.timesObserved}×)` : "";
      const lines = indexByCategory.get(category) ?? [];
      lines.push(`- [${row.name}](${relative}) — ${row.description}${seen}`);
      indexByCategory.set(category, lines);
    }
  }

  await fs.writeFile(path.join(dir, "MEMORY.md"), renderMemoryIndex(indexByCategory));

  await pruneStaleMemoryFiles(dir, new Set([...written, "MEMORY.md"]));
  return { dir, written, skipped };
}

/**
 * The index an agent reads before opening anything.
 *
 * Grouped by category rather than flat: the instruction is to read the index
 * and open only what is needed, which is only actionable if the index says what
 * kind of thing each entry is. Categories keep a stable order — a file that
 * reshuffles itself as entries are added reads as churn in every diff.
 */
function renderMemoryIndex(byCategory: Map<string, string[]>): string {
  const ordered = [
    ...MEMORY_CATEGORY_IDS.filter((id) => byCategory.has(id)),
    // Anything a future category adds, so nothing silently vanishes from the index.
    ...[...byCategory.keys()].filter((id) => !(MEMORY_CATEGORY_IDS as readonly string[]).includes(id)).sort(),
  ];

  const sections = ordered.map((category) => {
    const label = MEMORY_CATEGORY_LABELS[category as MemoryCategory] ?? category;
    return `## ${label}\n\n${(byCategory.get(category) ?? []).sort().join("\n")}\n`;
  });

  return `# Memory\n\n${sections.join("\n")}`;
}

/** Remove files the DB no longer knows about, so disk mirrors the DB exactly. */
async function pruneStaleMemoryFiles(dir: string, keep: Set<string>): Promise<void> {
  const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const parent = (entry as unknown as { parentPath?: string; path?: string }).parentPath ?? entry.path ?? dir;
    const relative = path.relative(dir, path.join(parent, entry.name)).split(path.sep).join("/");
    if (!keep.has(relative)) {
      await fs.rm(path.join(dir, relative), { force: true });
    }
  }
}
