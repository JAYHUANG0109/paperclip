/**
 * Seeding memory from work already done.
 *
 * Automatic capture only ever looks forward: an agent saves what THIS run
 * taught it, so a person who has been using the platform for months starts from
 * an empty page and waits for their history to be re-learned one task at a
 * time. This module supplies the backward half — a digest of what a user and
 * their agents have actually worked on, compact enough to reason over.
 *
 * ─── It digests; it does not decide ───
 *
 * Nothing here writes a memory. It produces a brief that a person's OWN agent
 * is then asked to distil, on a normal run, through the normal API. That is
 * deliberate:
 *
 *   • The write gate stays the only way in. A backfill that inserted rows
 *     directly would bypass the category rules, the screen, and the limits —
 *     precisely the enforcement the rest of this feature exists to provide.
 *
 *   • Distillation is a judgement ("what about this history will still matter
 *     next month?"), and the agent is the thing that makes judgements. A SQL
 *     aggregate can tell you someone closed 40 tasks in the Taipei project; it
 *     cannot tell you they always want the client copied on the final render.
 *
 *   • Provenance stays honest. Entries land labelled `agent`, attributed, and
 *     deletable, exactly like every other captured memory.
 *
 * ─── Whose history ───
 *
 * The owner's, and their mapped agents'. Resolved from `agent_memberships` the
 * same way the rest of personal memory resolves it, so a campus head asking for
 * a member's digest gets the member's work, not their own. The caller's
 * identity decides IF they may ask; it never decides WHOSE history is read.
 */

import type { Db } from "@paperclipai/db";
import { agentMemberships, agents, issues, projects } from "@paperclipai/db";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";

/** How many tasks to read. Enough to see a pattern, small enough to reason over. */
const SEED_ISSUE_LIMIT = 200;
/** How many recent titles to quote verbatim in the brief. */
const SEED_RECENT_TITLES = 40;

export type MemorySeedDigest = {
  userId: string;
  /** Agents mapped to this user, whose work counts as theirs. */
  agentNames: string[];
  totalIssues: number;
  completedIssues: number;
  /** Busiest projects first. */
  projectCounts: Array<{ name: string; count: number }>;
  /** Most recent activity first; the raw material for distillation. */
  recentTitles: Array<{ title: string; status: string; project: string | null; updatedAt: Date }>;
  earliest: Date | null;
  latest: Date | null;
};

/** Agents whose work counts as this user's, from the same table memory uses. */
async function mappedAgentIds(
  db: Db,
  input: { companyId: string; userId: string },
): Promise<string[]> {
  const rows = await db
    .select({ agentId: agentMemberships.agentId })
    .from(agentMemberships)
    .where(
      and(
        eq(agentMemberships.companyId, input.companyId),
        eq(agentMemberships.userId, input.userId),
        eq(agentMemberships.state, "joined"),
      ),
    );
  return [...new Set(rows.map((row) => row.agentId).filter(Boolean))] as string[];
}

/**
 * Read what this user and their agents have worked on.
 *
 * Returns an empty digest rather than throwing when there is no history — a new
 * user asking to seed their memory should be told there is nothing to seed, not
 * shown an error.
 */
export async function buildMemorySeedDigest(
  db: Db,
  input: { companyId: string; userId: string },
): Promise<MemorySeedDigest> {
  const agentIds = await mappedAgentIds(db, input);

  const agentRows = agentIds.length
    ? await db
      .select({ name: agents.name })
      .from(agents)
      .where(and(eq(agents.companyId, input.companyId), inArray(agents.id, agentIds)))
    : [];

  const claims = [
    eq(issues.assigneeUserId, input.userId),
    eq(issues.createdByUserId, input.userId),
    ...(agentIds.length ? [inArray(issues.assigneeAgentId, agentIds)] : []),
  ];

  const rows = (await db
    .select({
      title: issues.title,
      status: issues.status,
      updatedAt: issues.updatedAt,
      projectName: projects.name,
    })
    .from(issues)
    .leftJoin(projects, eq(projects.id, issues.projectId))
    .where(
      and(
        eq(issues.companyId, input.companyId),
        isNull(issues.hiddenAt),
        // Routine machinery is not work anyone remembers doing.
        isNull(issues.harnessKind),
        or(...claims),
      ),
    )
    .orderBy(desc(issues.updatedAt))
    .limit(SEED_ISSUE_LIMIT)) as Array<{
      title: string;
      status: string;
      updatedAt: Date;
      projectName: string | null;
    }>;

  const projectCounts = new Map<string, number>();
  let completedIssues = 0;
  let earliest: Date | null = null;
  let latest: Date | null = null;

  for (const row of rows) {
    if (row.projectName) projectCounts.set(row.projectName, (projectCounts.get(row.projectName) ?? 0) + 1);
    if (row.status === "done") completedIssues += 1;
    if (!earliest || row.updatedAt < earliest) earliest = row.updatedAt;
    if (!latest || row.updatedAt > latest) latest = row.updatedAt;
  }

  return {
    userId: input.userId,
    agentNames: agentRows.map((row) => row.name).filter(Boolean) as string[],
    totalIssues: rows.length,
    completedIssues,
    projectCounts: [...projectCounts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    recentTitles: rows.slice(0, SEED_RECENT_TITLES).map((row) => ({
      title: row.title,
      status: row.status,
      project: row.projectName,
      updatedAt: row.updatedAt,
    })),
    earliest,
    latest,
  };
}

/**
 * The task an agent is given to turn a digest into memories.
 *
 * Written as an instruction to the agent rather than as data, because that is
 * what it is. It restates the rules the API enforces so a refusal is something
 * the agent anticipates rather than discovers — and it is explicit that finding
 * nothing worth saving is a valid outcome. A seeding task that feels obliged to
 * produce ten memories will invent ten memories.
 */
export function renderMemorySeedTask(digest: MemorySeedDigest): { title: string; description: string } {
  const lines: string[] = [];

  lines.push(
    "Review the work below and save what will still matter next time you work with this person.",
    "",
    "This is a one-off catch-up: memory has been capturing new facts as you go, but everything that happened before that was never recorded. Read the history, decide what is durable, and write it down.",
    "",
    "## What to look for",
    "",
    "- Patterns, not events. A task you did once is not a memory; a thing they always want done a certain way is.",
    "- The projects and areas they actually work in, and who they work with.",
    "- Standing constraints — deadlines that recur, formats they need, tools they use, the language they write in.",
    "- Anything you can tell you have already had to re-derive more than once.",
    "",
    "## What not to save",
    "",
    "- A summary of this list. The tasks are already on the board; repeating them here is a log, not a memory.",
    "- Anything about OTHER people.",
    "- Anything you are guessing at. Fewer, surer entries beat a full page of inferences.",
    "- Secrets, or their health, financial or identity details. The API refuses these and will tell you so.",
    "",
    `Save each one with PUT /api/companies/{companyId}/users/${digest.userId}/memories/{name} using a short kebab-case slug and a \`memoryType\` of preference, profile, project, feedback or reference. Reuse a slug to revise rather than adding a near-duplicate.`,
    "",
    "If nothing here is worth remembering, say so and save nothing. That is a real answer.",
    "",
    "## The history",
    "",
  );

  if (digest.agentNames.length) {
    lines.push(`Agents working for this person: ${digest.agentNames.join(", ")}`, "");
  }

  lines.push(
    `${digest.totalIssues} tasks, ${digest.completedIssues} completed.`,
    digest.earliest && digest.latest
      ? `Spanning ${digest.earliest.toISOString().slice(0, 10)} to ${digest.latest.toISOString().slice(0, 10)}.`
      : "",
    "",
  );

  if (digest.projectCounts.length) {
    lines.push("### Projects", "");
    for (const project of digest.projectCounts) {
      lines.push(`- ${project.name} — ${project.count} task(s)`);
    }
    lines.push("");
  }

  if (digest.recentTitles.length) {
    lines.push("### Recent tasks", "");
    for (const task of digest.recentTitles) {
      const project = task.project ? ` [${task.project}]` : "";
      lines.push(`- ${task.title}${project} (${task.status})`);
    }
    lines.push("");
  }

  return {
    title: "Catch up on memory from past work",
    description: lines.filter((line, index, all) => !(line === "" && all[index - 1] === "")).join("\n"),
  };
}

/** Whether there is enough history to be worth asking an agent to read. */
export function seedIsWorthwhile(digest: MemorySeedDigest): boolean {
  return digest.totalIssues > 0;
}

/** Count of this owner's rows, used to warn before seeding over an existing memory. */
export async function countExistingMemories(
  db: Db,
  input: { companyId: string; userId: string },
): Promise<number> {
  const { userMemories } = await import("@paperclipai/db");
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(userMemories)
    .where(and(eq(userMemories.companyId, input.companyId), eq(userMemories.userId, input.userId)));
  return Number(row?.count ?? 0);
}
