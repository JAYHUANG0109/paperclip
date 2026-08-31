/**
 * Rename 領導團隊 → 園長團隊 and give it the founder's three ranks.
 *
 * The founder's model is 總園長 → 園長 → 主任 → 組長 → 組員 for the campuses and
 * 處長 → 各單位主管 → 組員 for HQ, so the leadership root's second level is the
 * RANK: 哈曉如 and 吳家秀 in 總園長, every other 園長／副園長 in 園長, and
 * 張廖心淑 in 處長. The rank is inserted at teams[1] — grouping reads teams[0]
 * as the folder and teams[1] as its sub-folder — and the campus tokens that
 * followed are kept, since visibility matches on any token.
 *
 * Skill and folder `sharing_teams` lists are rewritten too: 37 skills and 15
 * folders name 領導團隊, and leaving them would quietly revoke access. The
 * shared module also aliases the old name forward, so anything missed here
 * still resolves.
 *
 *   tsx scripts/migrate-leadership-team.ts             # dry-run
 *   tsx scripts/migrate-leadership-team.ts --apply
 */
import { agents, createDb, eq, sql } from "../packages/db/src/index.js";
import { loadConfig } from "../server/src/config.js";

const APPLY = process.argv.includes("--apply");
const OLD = "領導團隊";
const NEW = "園長團隊";
const RANKS = ["總園長", "園長", "處長"];

/** Rank by title, since that is what the founder's chart keys off. */
function rankFor(name: string, title: string | null): string | null {
  const t = `${name} ${title ?? ""}`;
  if (/總園長/.test(t)) return "總園長";
  if (/處長/.test(t)) return "處長";
  if (/園長/.test(t)) return "園長"; // covers 園長 and 副園長
  return null; // 創辦人 and the cross-campus comms agent have no rank
}

async function main() {
  const config = loadConfig();
  const db = createDb(process.env.DATABASE_URL?.trim() || config.databaseUrl
    || `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`);

  const rows = (await db.select().from(agents)).filter((a) => a.status !== "terminated");
  let moved = 0;
  for (const a of rows) {
    const md = (a.metadata && typeof a.metadata === "object" ? { ...(a.metadata as Record<string, unknown>) } : {});
    const teams = Array.isArray(md.teams) ? (md.teams as string[]).slice() : [];
    if (!teams.includes(OLD) && !teams.includes(NEW)) continue;

    const rest = teams.filter((t) => t !== OLD && t !== NEW);
    const rank = rankFor(a.name, a.title);
    // Drop a rank already present so re-running cannot stack duplicates.
    const withoutRank = rest.filter((t) => !RANKS.includes(t));
    const next = [NEW, ...(rank ? [rank] : []), ...withoutRank];
    if (next.join(" ") === teams.join(" ")) continue;

    moved += 1;
    console.log(`  - ${a.name}: [${teams.join(", ")}] -> [${next.join(", ")}]`);
    if (!APPLY) continue;
    md.teams = next;
    await db.update(agents).set({ metadata: md, updatedAt: new Date() }).where(eq(agents.id, a.id));
  }

  // Sharing lists: rewrite in place so a share keeps pointing at the same people.
  for (const table of ["company_skills", "folders", "company_skill_folders", "routines"]) {
    const res = (await db.execute(sql`
      select count(*)::int as n from ${sql.raw(table)} where ${OLD} = any(sharing_teams)
    `)) as unknown as Array<{ n: number }>;
    const n = res[0]?.n ?? 0;
    if (n === 0) continue;
    console.log(`  ${APPLY ? "rewriting" : "would rewrite"} ${n} ${table}.sharing_teams`);
    if (!APPLY) continue;
    // sharing_teams is text[], so swap the element rather than the rendered text.
    await db.execute(sql`
      update ${sql.raw(table)}
         set sharing_teams = array_replace(sharing_teams, ${OLD}, ${NEW})
       where ${OLD} = any(sharing_teams)
    `);
  }

  console.log(`\n${APPLY ? "moved" : "would move"} ${moved} agents into ${NEW}`);
  process.exit(0);
}

void main().catch((e) => { console.error(e); process.exit(1); });
