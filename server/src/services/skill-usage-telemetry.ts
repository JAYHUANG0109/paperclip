import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentMemberships, companySkills, skillUsageEvents } from "@paperclipai/db";
import { leaderboardService } from "./leaderboard.js";
import { getRunLogStore } from "./run-log-store.js";
import { logger } from "../middleware/logger.js";

// Mirror of company-skills' runtime-name derivation so we can map an invoked
// skill (as it appears in the transcript) back to its company_skills row. Keep
// these IN SYNC with server/src/services/company-skills.ts.
function hashSkillValue(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 10);
}
function buildSkillRuntimeName(key: string, slug: string): string {
  if (key.startsWith("paperclipai/paperclip/")) return slug;
  return `${slug}--${hashSkillValue(key)}`;
}

/**
 * Parse a run transcript (NDJSON of `{ts,stream,chunk}` where each chunk is a
 * stringified adapter event) and count real skill invocations. A skill use is a
 * `tool_use` block with name "Skill" whose input names the skill at its runtime
 * name, e.g. `{ "skill": "paperclip-distill--0f6e9a5a65" }`. Returns runtimeName → count.
 */
export function extractSkillInvocations(content: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const chunk = (rec as { chunk?: unknown } | null)?.chunk;
    if (typeof chunk !== "string") continue;
    let ev: unknown;
    try {
      ev = JSON.parse(chunk);
    } catch {
      continue;
    }
    const event = ev as { type?: unknown; message?: { content?: unknown } } | null;
    if (!event || event.type !== "assistant") continue;
    const blocks = event.message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (!block || typeof block !== "object") continue;
      const b = block as { type?: unknown; name?: unknown; input?: { skill?: unknown } };
      if (b.type !== "tool_use" || b.name !== "Skill") continue;
      const skill = b.input?.skill;
      if (typeof skill === "string" && skill.trim()) {
        counts.set(skill, (counts.get(skill) ?? 0) + 1);
      }
    }
  }
  return counts;
}

export function skillUsageTelemetry(db: Db) {
  const leaderboard = leaderboardService(db);
  const runLogStore = getRunLogStore();

  /**
   * After a run finishes, record real per-skill usage from its transcript into
   * the leaderboard. Idempotent per (run, skill) via skill_usage_events, so it's
   * safe to call more than once for the same run. Never throws — telemetry must
   * not affect the run lifecycle.
   */
  async function recordRunSkillUsage(input: {
    runId: string;
    companyId: string;
    agentId: string;
    logStore: string | null;
    logRef: string | null;
    sizeBytes?: number | null;
    finishedAt?: Date | null;
  }): Promise<void> {
    const { runId, companyId, agentId, logStore, logRef } = input;
    if (!logStore || !logRef || logStore !== "local_file") return;
    try {
      // Read the whole transcript in one shot (bytes known from finalize) so a
      // chunk boundary can't split a multibyte char or a JSON line.
      const limitBytes = input.sizeBytes && input.sizeBytes > 0 ? input.sizeBytes + 1024 : 16_000_000;
      const { content } = await runLogStore.read({ store: logStore as "local_file", logRef }, { offset: 0, limitBytes });
      const invocations = extractSkillInvocations(content);
      if (invocations.size === 0) return;

      const skills = await db
        .select({ id: companySkills.id, key: companySkills.key, slug: companySkills.slug })
        .from(companySkills)
        .where(eq(companySkills.companyId, companyId));
      const skillIdByRuntime = new Map<string, string>();
      for (const s of skills) skillIdByRuntime.set(buildSkillRuntimeName(s.key, s.slug), s.id);

      // Attribute usage to the agent's human owner so beneficiaries / team-bonus
      // count distinct PEOPLE (the leaderboard's unique key is per usedByUserId).
      let usedByUserId: string | null = null;
      const [membership] = await db
        .select({ userId: agentMemberships.userId })
        .from(agentMemberships)
        .where(and(eq(agentMemberships.agentId, agentId), eq(agentMemberships.state, "joined")))
        .limit(1);
      usedByUserId = membership?.userId ?? null;

      const periodMonth = (input.finishedAt ?? new Date()).toISOString().slice(0, 7);

      for (const [runtimeName, count] of invocations) {
        const skillId = skillIdByRuntime.get(runtimeName);
        if (!skillId) continue; // an invoked skill that isn't a tracked company skill (e.g. a built-in)
        // Ledger insert is the idempotency gate: only credit usage if this is the
        // first time we've recorded this (run, skill).
        const inserted = await db
          .insert(skillUsageEvents)
          .values({ companyId, skillId, runId, usedByUserId, usedByAgentId: agentId, invocations: count, periodMonth })
          .onConflictDoNothing({ target: [skillUsageEvents.runId, skillUsageEvents.skillId] })
          .returning({ id: skillUsageEvents.id });
        if (inserted.length === 0) continue;
        // Only roll into company_skill_usage when attributable to a human. A NULL
        // usedByUserId never dedupes in the unique index (Postgres treats NULLs as
        // distinct), so it would create unbounded rows + skew distinct-user counts.
        // The skill_usage_events ledger above already captures the raw usage.
        if (usedByUserId) {
          await leaderboard.recordUsage(companyId, skillId, periodMonth, usedByUserId, agentId, count);
        }
      }
    } catch (err) {
      logger.warn({ err, runId }, "skill usage telemetry failed");
    }
  }

  return { recordRunSkillUsage };
}
