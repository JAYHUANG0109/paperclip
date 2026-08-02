/**
 * Distillation — the pass that makes capture a mechanism instead of a request.
 *
 * ─── The problem this exists to solve ───
 *
 * Every agent's prompt asks it to save what it learns about the person it works
 * for. That is a request. An agent deep in a task has one goal, memory is not
 * it, and the honest position was: whether anything gets written can only be
 * discovered by watching the page for a week. Screening, categories and limits
 * bound what CAN be stored; none of them cause a write to happen.
 *
 * So the write stops depending on an agent noticing. Once enough work has
 * accumulated, this creates a real task, assigned to that person's own agent,
 * whose entire content is "read what you have done since last time and decide
 * what is worth remembering". Tasks get done — that is the one thing this
 * platform reliably guarantees — so capture inherits that guarantee.
 *
 * ─── Why batched, and not after every run ───
 *
 * Two reasons, and the first is the interesting one.
 *
 * Repetition is the signal (this is the idea Perplexity's memory is built on,
 * and the one worth copying). A single run cannot see repetition: everything in
 * it happened once. Looking across a dozen runs is the first vantage point from
 * which "they keep asking for this" is even visible, so batching is not a cost
 * saving that happens to work — it is the only window where the judgement can
 * be made at all.
 *
 * The second reason is ordinary: one distillation task per run would double
 * every agent's workload to reread what it just did.
 *
 * ─── Why a task, and not a direct write ───
 *
 * The same reason seeding is a task (see memory-seed.ts). The write gate stays
 * the only way in, so nothing here can bypass the categories, the screen or the
 * limits; and distillation is a judgement, which is what agents are for.
 *
 * ─── What it hands the agent ───
 *
 * The work itself, and what is already remembered. That second half is what
 * makes this a reconciliation rather than an append: with the current memory in
 * front of it, an agent can add, revise, confirm, or decide nothing changed —
 * which is how a memory store stays small and true instead of growing forever.
 * The prompt names all four outcomes explicitly, because an agent shown only
 * new material will always find something to add.
 *
 * ─── Whose memory ───
 *
 * The agent's MAPPED user, from `agent_memberships`, exactly as everywhere else
 * in personal memory. Nobody triggers this, so there is no acting user to
 * confuse it with.
 */

import { and, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentMemberships,
  agents,
  heartbeatRuns,
  issueComments,
  issues,
  projects,
  userMemories,
} from "@paperclipai/db";
import { MEMORY_CATEGORY_IDS, memoryStrength } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { issueService } from "./issues.js";
import { getMemorySettings } from "./personal-memory.js";

/** Marks the tasks this pass creates, so it can recognise its own work. */
export const MEMORY_DISTILLATION_ORIGIN_KIND = "memory_distillation";

/**
 * Runs that must finish before a distillation is worth asking for.
 *
 * Low enough that a normally busy person gets one every day or two; high enough
 * that a single afternoon of work does not trigger one. The floor matters more
 * than the exact number: below it there is no repetition to see, and the agent
 * would be reading one task's worth of history and inventing a pattern from it.
 */
export const DEFAULT_MIN_RUNS_BEFORE_DISTILLATION = 8;

/**
 * Minimum gap between distillations for the same person.
 *
 * A burst of fifty runs in an hour is one working session, not six things worth
 * remembering. This is the backstop that turns run count into elapsed work.
 */
export const DEFAULT_MIN_DISTILLATION_INTERVAL_MS = 20 * 60 * 60 * 1000;

/** How much history goes in the brief. Enough to see a pattern, small enough to read. */
const MAX_ISSUES_IN_BRIEF = 40;
const MAX_COMMENTS_IN_BRIEF = 30;
const MAX_COMMENT_CHARS = 400;
/** Candidate agents examined per sweep, so one tick stays bounded. */
const MAX_CANDIDATES_PER_SWEEP = 200;

type EnqueueWakeup = (
  agentId: string,
  opts?: {
    source?: "timer" | "assignment" | "on_demand" | "automation";
    triggerDetail?: "manual" | "ping" | "callback" | "system";
    reason?: string | null;
    payload?: Record<string, unknown> | null;
    requestedByActorType?: "user" | "agent" | "system";
    requestedByActorId?: string | null;
    contextSnapshot?: Record<string, unknown>;
  },
) => Promise<unknown | null>;

export type MemoryDistillationThresholds = {
  minRuns: number;
  minIntervalMs: number;
};

export type DistillationDigest = {
  userId: string;
  agentId: string;
  agentName: string;
  since: Date | null;
  runsSince: number;
  /** Work touched in the window, most recent first. */
  issues: Array<{ title: string; status: string; project: string | null }>;
  /**
   * What the OWNER said, verbatim.
   *
   * The richest source there is. Preferences are almost never stated as
   * preferences — they arrive as "next time put the client on the render" in a
   * comment on one task, and the only way to notice it is a standing rule is to
   * see it beside the four other times they said something like it.
   */
  ownerComments: Array<{ body: string; issueTitle: string; at: Date }>;
  /** What is already remembered, so this is a reconciliation and not an append. */
  existingMemories: Array<{ name: string; memoryType: string; description: string; timesObserved: number }>;
};

/** Never let one long comment crowd out the rest of the evidence. */
function truncate(text: string, max: number): string {
  const clean = text.trim().replace(/\s+/g, " ");
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

/**
 * The brief.
 *
 * Written as an instruction, because that is what it is. Three things it does
 * deliberately:
 *
 *   • Names all four outcomes (add / revise / confirm / nothing). An agent shown
 *     only new material and asked what to save will always find something.
 *   • Puts the existing memory in front of the new material, so revising is the
 *     obvious move and a near-duplicate is visibly a near-duplicate.
 *   • Restates the limits the API enforces, so a refusal is something the agent
 *     anticipated rather than something it discovers and retries into.
 */
export function renderDistillationTask(digest: DistillationDigest): { title: string; description: string } {
  const lines: string[] = [];

  lines.push(
    `Review what you have done for this person since ${digest.since ? digest.since.toISOString().slice(0, 10) : "you started"} and update what you remember about them.`,
    "",
    "This is the regular memory pass. You have run "
      + `${digest.runsSince} time(s) since the last one. Read the evidence below, compare it to what you already remember, and make memory match reality.`,
    "",
    "## What to do",
    "",
    "For each thing you notice, exactly one of these:",
    "",
    "- **Add** it, if it is durable and not already remembered.",
    "- **Revise** an existing entry, by reusing its exact name — this is how you correct something that has changed.",
    "- **Confirm** it, by re-saving the same fact. That is not a duplicate; it raises the entry's confidence, and repetition is what separates a standing preference from a passing remark.",
    "- **Nothing.** If this stretch of work taught you nothing durable, save nothing and say so. That is the expected outcome most of the time, and a pass that invents three memories to look productive makes this whole feature worse.",
    "",
    "Delete an entry (DELETE the same URL) only if you now know it is wrong. Deletes are recoverable for 30 days, so an honest correction is safe — but do not tidy.",
    "",
    "## What counts as durable",
    "",
    "- A preference they have now expressed more than once.",
    "- How work actually flows here — the cadence, the tools, the route a thing takes to get approved.",
    "- What they own and what they are asked for by name.",
    "- Constraints that will still be true next month.",
    "",
    "## What does not",
    "",
    "- What happened. The tasks are on the board already; repeating them is a log, not a memory.",
    "- Anything about OTHER people.",
    "- Anything you are guessing at. One sure entry beats five inferences.",
    "- Secrets, or their health, financial or identity details. The API refuses these and will tell you why.",
    "",
    `Save with PUT /api/companies/{companyId}/users/${digest.userId}/memories/{name} — a short kebab-case slug, and a \`memoryType\` of ${MEMORY_CATEGORY_IDS.join(", ")}. Keep each entry under 1500 characters and add no more than 10 new ones.`,
    "",
  );

  lines.push("## What you already remember", "");
  if (digest.existingMemories.length === 0) {
    lines.push("Nothing yet. This is the first pass.", "");
  } else {
    for (const memory of digest.existingMemories) {
      const strength = memoryStrength(memory.timesObserved);
      lines.push(`- \`${memory.name}\` [${memory.memoryType}, ${strength}] — ${memory.description}`);
    }
    lines.push("");
  }

  if (digest.ownerComments.length) {
    lines.push(
      "## What they said",
      "",
      "Their own words, most recent first. This is the best evidence you have — read it for what they keep asking for, not for what happened.",
      "",
    );
    for (const comment of digest.ownerComments) {
      lines.push(`- On "${comment.issueTitle}": ${truncate(comment.body, MAX_COMMENT_CHARS)}`);
    }
    lines.push("");
  }

  if (digest.issues.length) {
    lines.push("## What you worked on", "");
    for (const issue of digest.issues) {
      const project = issue.project ? ` [${issue.project}]` : "";
      lines.push(`- ${issue.title}${project} (${issue.status})`);
    }
    lines.push("");
  }

  return {
    title: "Update what you remember about your user",
    description: lines.filter((line, index, all) => !(line === "" && all[index - 1] === "")).join("\n"),
  };
}

export function memoryDistillationService(db: Db, deps?: { enqueueWakeup?: EnqueueWakeup }) {
  const issuesSvc = issueService(db);

  /**
   * The last distillation task for this person, whatever its status.
   *
   * Both facts matter and come from the same row: when the window starts, and
   * whether the previous one is still open. Stacking distillations would be the
   * worst possible failure here — a backlog of "remember things" tasks that
   * nobody does and that pushes real work down the queue.
   */
  async function lastDistillation(companyId: string, userId: string) {
    const [row] = await db
      .select({ id: issues.id, status: issues.status, createdAt: issues.createdAt })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, MEMORY_DISTILLATION_ORIGIN_KIND),
          eq(issues.originId, userId),
        ),
      )
      .orderBy(desc(issues.createdAt))
      .limit(1);
    return row ?? null;
  }

  /** Terminal runs for this agent since the window opened. */
  async function countRunsSince(companyId: string, agentId: string, since: Date | null): Promise<number> {
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.agentId, agentId),
          eq(heartbeatRuns.status, "succeeded"),
          since ? gt(heartbeatRuns.finishedAt, since) : sql`${heartbeatRuns.finishedAt} is not null`,
        ),
      );
    return Number(row?.count ?? 0);
  }

  async function buildDigest(input: {
    companyId: string;
    userId: string;
    agentId: string;
    agentName: string;
    since: Date | null;
    runsSince: number;
  }): Promise<DistillationDigest> {
    const { companyId, userId, agentId, since } = input;

    const touchedIssues = (await db
      .select({
        id: issues.id,
        title: issues.title,
        status: issues.status,
        projectName: projects.name,
      })
      .from(issues)
      .leftJoin(projects, eq(projects.id, issues.projectId))
      .where(
        and(
          eq(issues.companyId, companyId),
          isNull(issues.hiddenAt),
          // Machinery is not work anyone remembers doing — and distillation
          // tasks are machinery, so this also stops the pass reading itself.
          isNull(issues.harnessKind),
          sql`${issues.originKind} <> ${MEMORY_DISTILLATION_ORIGIN_KIND}`,
          or(
            eq(issues.assigneeAgentId, agentId),
            eq(issues.assigneeUserId, userId),
            eq(issues.createdByUserId, userId),
          ),
          since ? gt(issues.updatedAt, since) : undefined,
        ),
      )
      .orderBy(desc(issues.updatedAt))
      .limit(MAX_ISSUES_IN_BRIEF)) as Array<{
        id: string;
        title: string;
        status: string;
        projectName: string | null;
      }>;

    const titleById = new Map(touchedIssues.map((issue) => [issue.id, issue.title]));

    // The owner's own words, scoped to the work above. Restricting to these
    // issues keeps the query cheap and keeps the evidence relevant; a comment on
    // something this agent never touched is not evidence about this agent's work.
    const ownerComments = touchedIssues.length
      ? ((await db
        .select({ body: issueComments.body, issueId: issueComments.issueId, createdAt: issueComments.createdAt })
        .from(issueComments)
        .where(
          and(
            eq(issueComments.authorUserId, userId),
            inArray(issueComments.issueId, touchedIssues.map((issue) => issue.id)),
            since ? gt(issueComments.createdAt, since) : undefined,
          ),
        )
        .orderBy(desc(issueComments.createdAt))
        .limit(MAX_COMMENTS_IN_BRIEF)) as Array<{ body: string; issueId: string; createdAt: Date }>)
      : [];

    const existingMemories = (await db
      .select({
        name: userMemories.name,
        memoryType: userMemories.memoryType,
        description: userMemories.description,
        timesObserved: userMemories.timesObserved,
      })
      .from(userMemories)
      .where(
        and(
          eq(userMemories.companyId, companyId),
          eq(userMemories.userId, userId),
          eq(userMemories.isBinary, false),
          isNull(userMemories.deletedAt),
        ),
      )
      .orderBy(desc(userMemories.timesObserved))) as DistillationDigest["existingMemories"];

    return {
      userId,
      agentId,
      agentName: input.agentName,
      since,
      runsSince: input.runsSince,
      issues: touchedIssues.map((issue) => ({
        title: issue.title,
        status: issue.status,
        project: issue.projectName,
      })),
      ownerComments: ownerComments
        .filter((comment) => comment.body.trim().length > 0)
        .map((comment) => ({
          body: comment.body,
          issueTitle: titleById.get(comment.issueId) ?? "a task",
          at: comment.createdAt,
        })),
      existingMemories,
    };
  }

  /**
   * Whether there is anything to distil.
   *
   * Runs alone are not enough. An agent that ran twenty times on machinery and
   * never spoke to its user has nothing to learn about them, and a task asking
   * it to find something would be answered by inventing something.
   */
  function digestIsWorthDistilling(digest: DistillationDigest): boolean {
    return digest.issues.length > 0 || digest.ownerComments.length > 0;
  }

  /**
   * Create distillation tasks for everyone who has accumulated enough work.
   *
   * Never throws for one candidate's sake — a person whose digest fails to build
   * must not stop everyone else's from being written.
   */
  async function reconcileMemoryDistillations(opts?: {
    now?: Date;
    companyId?: string;
    thresholds?: Partial<MemoryDistillationThresholds>;
  }) {
    const now = opts?.now ?? new Date();
    const thresholds: MemoryDistillationThresholds = {
      minRuns: opts?.thresholds?.minRuns ?? DEFAULT_MIN_RUNS_BEFORE_DISTILLATION,
      minIntervalMs: opts?.thresholds?.minIntervalMs ?? DEFAULT_MIN_DISTILLATION_INTERVAL_MS,
    };

    const result = {
      scanned: 0,
      created: 0,
      openAlready: 0,
      tooSoon: 0,
      notEnoughRuns: 0,
      nothingToLearn: 0,
      capturePaused: 0,
      failed: 0,
      issueIds: [] as string[],
    };

    // The same table personal memory resolves ownership from, so an agent gets
    // distilled for exactly the user whose memory it can write.
    const candidates = (await db
      .select({
        companyId: agentMemberships.companyId,
        agentId: agentMemberships.agentId,
        userId: agentMemberships.userId,
        agentName: agents.name,
      })
      .from(agentMemberships)
      .innerJoin(agents, eq(agents.id, agentMemberships.agentId))
      .where(
        and(
          eq(agentMemberships.state, "joined"),
          opts?.companyId ? eq(agentMemberships.companyId, opts.companyId) : undefined,
        ),
      )
      .limit(MAX_CANDIDATES_PER_SWEEP)) as Array<{
        companyId: string;
        agentId: string;
        userId: string;
        agentName: string;
      }>;

    for (const candidate of candidates) {
      result.scanned += 1;
      try {
        // Paused means paused. Writes are already refused at the gate, so
        // creating the task anyway would only produce work that cannot land.
        if (!(await getMemorySettings(db, { companyId: candidate.companyId, userId: candidate.userId })).captureEnabled) {
          result.capturePaused += 1;
          continue;
        }

        const previous = await lastDistillation(candidate.companyId, candidate.userId);
        if (previous && !["done", "cancelled"].includes(previous.status)) {
          result.openAlready += 1;
          continue;
        }
        if (previous && now.getTime() - previous.createdAt.getTime() < thresholds.minIntervalMs) {
          result.tooSoon += 1;
          continue;
        }

        const since = previous?.createdAt ?? null;
        const runsSince = await countRunsSince(candidate.companyId, candidate.agentId, since);
        if (runsSince < thresholds.minRuns) {
          result.notEnoughRuns += 1;
          continue;
        }

        const digest = await buildDigest({ ...candidate, since, runsSince });
        if (!digestIsWorthDistilling(digest)) {
          result.nothingToLearn += 1;
          continue;
        }

        const task = renderDistillationTask(digest);
        const created = await issuesSvc.create(candidate.companyId, {
          title: task.title,
          description: task.description,
          status: "todo",
          // Below real work on purpose. Memory is valuable and never urgent;
          // one that outranks a deadline has misunderstood its own importance.
          priority: "low",
          assigneeAgentId: candidate.agentId,
          originKind: MEMORY_DISTILLATION_ORIGIN_KIND,
          originId: candidate.userId,
          originFingerprint: `memory-distillation:${candidate.userId}:${now.toISOString().slice(0, 10)}`,
        });

        result.created += 1;
        result.issueIds.push(created.id);

        if (deps?.enqueueWakeup) {
          await deps.enqueueWakeup(candidate.agentId, {
            source: "assignment",
            triggerDetail: "system",
            reason: "issue_assigned",
            requestedByActorType: "system",
            requestedByActorId: "memory_distillation",
            payload: { issueId: created.id },
            contextSnapshot: {
              issueId: created.id,
              taskId: created.id,
              wakeReason: "issue_assigned",
              source: MEMORY_DISTILLATION_ORIGIN_KIND,
            },
          });
        }
      } catch (err) {
        result.failed += 1;
        logger.warn(
          { err, companyId: candidate.companyId, agentId: candidate.agentId },
          "memory distillation skipped a candidate",
        );
      }
    }

    return result;
  }

  return { reconcileMemoryDistillations, renderDistillationTask, buildDigest, digestIsWorthDistilling };
}
