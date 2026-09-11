/**
 * Equip every agent a skill is already SHARED with — the backfill for
 * "shared = equipped".
 *
 * Sharing only ever controlled visibility; what an agent loads is its own
 * `adapter_config.paperclipSkillSync.desiredSkills`, written by /skills/sync or
 * /skills/distribute. The routes now equip the sharing audience automatically,
 * but skills shared BEFORE that change are still installed nowhere: as of
 * 2026-09-11, 17 of the founder's 29 team/company-shared skills reached zero
 * agents, because she creates them over MCP and nothing called distribute.
 *
 * Reconciles each skill to its FULL audience, not just the all-or-nothing case:
 * a skill shared to six teams but equipped on two agents gets the other four.
 * Add-only and idempotent — it never unequips, because nothing here can tell an
 * auto-equip apart from a deliberate one.
 *
 * Audience mirrors resolveEquipTargets in server/src/routes/company-skills.ts:
 *   company → every agent      team → agents matching any sharing token
 *   private → skipped (its audience is access members, not a team)
 *
 *   tsx scripts/backfill-skill-equip-from-sharing.ts                      # dry-run, founder only
 *   tsx scripts/backfill-skill-equip-from-sharing.ts --apply
 *   tsx scripts/backfill-skill-equip-from-sharing.ts --all --apply        # every creator
 *   tsx scripts/backfill-skill-equip-from-sharing.ts --creator a@b.com
 */
// Relative imports: scripts/ is outside the pnpm workspaces, so the package
// names do not resolve here (the other migration scripts do the same).
import { teamTokenMatches } from "../packages/shared/src/index.js";
import {
  readPaperclipSkillSyncPreference,
  writePaperclipSkillSyncPreference,
} from "../packages/adapter-utils/src/server-utils.js";
import { agents, companySkills, createDb, eq, sql } from "../packages/db/src/index.js";
import { loadConfig } from "../server/src/config.js";

const APPLY = process.argv.includes("--apply");
const ALL_CREATORS = process.argv.includes("--all");
const creatorArgIndex = process.argv.indexOf("--creator");
const CREATOR_EMAIL = creatorArgIndex >= 0
  ? process.argv[creatorArgIndex + 1] ?? ""
  : "tang@seasonart.org";

function teamsOf(metadata: unknown): string[] {
  const md = metadata as Record<string, unknown> | null;
  if (!md) return [];
  if (Array.isArray(md.teams)) {
    return md.teams.filter((t): t is string => typeof t === "string" && t.trim().length > 0);
  }
  if (typeof md.team === "string" && md.team.trim()) return [md.team.trim()];
  return [];
}

async function main() {
  const config = loadConfig();
  const db = createDb(process.env.DATABASE_URL?.trim() || config.databaseUrl
    || `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`);

  const roster = (await db.select().from(agents)).filter((a) => a.status !== "terminated");
  const teamsByAgent = new Map(roster.map((a) => [a.id, new Set(teamsOf(a.metadata))]));

  const skills = await db.select().from(companySkills);
  const creatorEmails = new Map<string, string>();
  const userRows = (await db.execute(sql`select id, email from "user"`)) as unknown as
    Array<{ id: string; email: string | null }>;
  for (const u of userRows) if (u.email) creatorEmails.set(u.id, u.email);

  // One in-memory view of each agent's desired keys, so a skill equipped in this
  // run is visible to the next one and the counts stay honest.
  const desiredByAgent = new Map<string, Set<string>>();
  for (const a of roster) {
    const pref = readPaperclipSkillSyncPreference((a.adapterConfig ?? {}) as Record<string, unknown>);
    desiredByAgent.set(a.id, new Set(pref.desiredSkillEntries.map((e) => e.key)));
  }
  const toAdd = new Map<string, string[]>(); // agentId -> skill keys

  let considered = 0;
  for (const skill of skills) {
    const scope = skill.sharingScope ?? "company";
    if (scope !== "team" && scope !== "company") continue;
    if (!ALL_CREATORS) {
      const email = skill.createdByUserId ? creatorEmails.get(skill.createdByUserId) : null;
      if (email !== CREATOR_EMAIL) continue;
    }
    const tokens = (skill.sharingTeams ?? []) as string[];
    if (scope === "team" && tokens.length === 0) continue;

    const audience = scope === "company"
      ? roster.map((a) => a.id)
      : roster
        .filter((a) => tokens.some((t) => teamTokenMatches(t, teamsByAgent.get(a.id) ?? new Set())))
        .map((a) => a.id);

    const missing = audience.filter((id) => !desiredByAgent.get(id)?.has(skill.key));
    considered += 1;
    if (missing.length === 0) continue;
    console.log(`  ${skill.name}  [${scope}${scope === "team" ? `: ${tokens.join("、")}` : ""}]`);
    console.log(`      audience ${audience.length}, missing ${missing.length}`);
    for (const id of missing) {
      desiredByAgent.get(id)?.add(skill.key);
      const list = toAdd.get(id);
      if (list) list.push(skill.key);
      else toAdd.set(id, [skill.key]);
    }
  }

  const agentCount = toAdd.size;
  const equipCount = [...toAdd.values()].reduce((n, l) => n + l.length, 0);
  console.log(`\n${considered} shared skills considered (${ALL_CREATORS ? "all creators" : CREATOR_EMAIL})`);
  console.log(`${APPLY ? "equipping" : "would equip"} ${equipCount} skill/agent pairs across ${agentCount} agents\n`);

  if (!APPLY) {
    console.log("DRY RUN — re-run with --apply");
    process.exit(0);
  }

  // One write per agent rather than per skill: the whole point of the failure
  // this fixes is a half-applied list, and a single write per agent cannot leave
  // one.
  for (const [agentId, keys] of toAdd) {
    const agent = roster.find((a) => a.id === agentId);
    if (!agent) continue;
    const config = (agent.adapterConfig ?? {}) as Record<string, unknown>;
    const pref = readPaperclipSkillSyncPreference(config);
    const have = new Set(pref.desiredSkillEntries.map((e) => e.key));
    const additions = keys.filter((k) => !have.has(k)).map((key) => ({ key, versionId: null }));
    if (additions.length === 0) continue;
    const nextConfig = writePaperclipSkillSyncPreference(config, [
      ...pref.desiredSkillEntries,
      ...additions,
    ]);
    await db.update(agents).set({ adapterConfig: nextConfig, updatedAt: new Date() })
      .where(eq(agents.id, agentId));
    console.log(`  + ${agent.name}: ${additions.length} skills`);
  }

  console.log("\nAPPLIED — agents pick the skills up on their next heartbeat.");
  process.exit(0);
}

void main().catch((e) => { console.error(e); process.exit(1); });
