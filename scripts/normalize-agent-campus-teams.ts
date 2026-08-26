/**
 * Normalize `metadata.teams` campus tokens, and backfill the missing ones.
 *
 * Visibility matches on "any team in common" (doc/sa-org-chart.md), so a campus
 * written two ways silently breaks it: 哈哈Tracy carried `市政`/`黎明` while the
 * campus agents carried `01市政`/`05黎明`, and 家秀/雅雅 carried `北屯` against
 * `03北屯` — the 統籌總園長 could not see the campuses they coordinate.
 *
 * The PLAIN form wins. The numbered variants (`00總管理處`, `01市政`, …) look
 * canonical in a DB census, but the UI's vocabulary is the plain name: TEAM_EN,
 * CAMPUS_TEAMS, CAMPUS_DEPARTMENTS, CAMPUS_ORDER and DEPARTMENT_ROOM in
 * ui/src/lib/agent-teams.ts all key off it. A numbered token matches none of
 * them, so it is not recognized as a campus, gets no English label, and renders
 * as a literal "00總管理處" in the sidebar.
 *
 * Agents with no campus token get one derived from their title, which already
 * records it — `(仁美校 · 註冊組)` → `06仁美`. It is APPENDED, never made first:
 * the first team drives sidebar grouping, and reordering 42 agents would
 * reorganize the whole agent list as a side effect of a visibility fix.
 *
 * Titles that name no campus (跨校 roles, HQ agents with a bare title) are
 * reported and skipped rather than guessed at.
 *
 *   tsx scripts/normalize-agent-campus-teams.ts             # dry-run
 *   tsx scripts/normalize-agent-campus-teams.ts --apply
 */
import { agents, createDb, eq } from "../packages/db/src/index.js";
import { loadConfig } from "../server/src/config.js";

const APPLY = process.argv.includes("--apply");

/** Stray numbered spelling → canonical plain token. */
const CANONICAL: Record<string, string> = {
  "00總管理處": "總管理處",
  "01市政": "市政",
  "02西屯": "西屯",
  "03北屯": "北屯",
  "05黎明": "黎明",
  "06仁美": "仁美",
};

/** Campus named in a title → canonical token. */
const FROM_TITLE: Array<[RegExp, string]> = [
  [/仁美校/, "仁美"],
  [/市政校/, "市政"],
  [/西屯校/, "西屯"],
  [/黎明校/, "黎明"],
  [/北屯校/, "北屯"],
  [/總部|總管理處/, "總管理處"],
];

const CANONICAL_SET = new Set(Object.values(CANONICAL));
const isCampusToken = (t: string) => CANONICAL_SET.has(t) || t in CANONICAL;

async function main() {
  const config = loadConfig();
  const db = createDb(process.env.DATABASE_URL?.trim() || config.databaseUrl
    || `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`);

  const rows = (await db.select().from(agents)).filter((a) => a.status !== "terminated");
  const byId = new Map(rows.map((r) => [r.id, r]));
  const managerTeams = (m: (typeof rows)[number] | undefined) => {
    const md = m?.metadata as { teams?: unknown } | null;
    return Array.isArray(md?.teams) ? (md!.teams as string[]) : null;
  };
  let renamed = 0;
  let backfilled = 0;
  const skipped: string[] = [];

  for (const a of rows) {
    const md = (a.metadata && typeof a.metadata === "object" ? { ...(a.metadata as Record<string, unknown>) } : {});
    const teams = Array.isArray(md.teams) ? (md.teams as string[]).slice() : [];
    if (teams.length === 0) continue;

    const before = teams.join(", ");
    // 1. Canonicalize the spelling of any campus token already present.
    let changedHere = false;
    for (let i = 0; i < teams.length; i += 1) {
      const canonical = CANONICAL[teams[i]!];
      if (canonical && canonical !== teams[i]) { teams[i] = canonical; changedHere = true; }
    }
    if (changedHere) renamed += 1;

    // 2. Append a campus token if the agent has none.
    if (!teams.some(isCampusToken)) {
      // System agents have no campus and should not acquire one.
      if (teams.includes("系統自動化")) { continue; }
      const title = a.title ?? "";
      let campus = FROM_TITLE.find(([re]) => re.test(title))?.[1] ?? null;
      // 跨校巡輔 exists only at 仁美 (doc/sa-org-chart.md), so the team itself
      // names the campus even when the title does not.
      if (!campus && teams.includes("跨校巡輔")) campus = "仁美";
      // Otherwise inherit from the manager — but only when the manager belongs to
      // exactly one campus. A 統籌總園長 spans three, and picking one of those
      // would invent a placement rather than derive it.
      if (!campus) {
        const manager = a.reportsTo ? byId.get(a.reportsTo) : undefined;
        const managerCampuses = (managerTeams(manager) ?? []).filter(isCampusToken).map((t) => CANONICAL[t] ?? t);
        const unique = [...new Set(managerCampuses)];
        if (unique.length === 1) campus = unique[0]!;
      }
      if (!campus) { skipped.push(`${a.name} — no campus in title "${title}", manager is cross-campus or absent`); continue; }
      teams.push(campus);
      backfilled += 1;
      changedHere = true;
    }

    // Same token twice helps nobody; collapse while preserving order.
    const deduped = teams.filter((t, i) => teams.indexOf(t) === i);
    if (!changedHere && deduped.length === teams.length) continue;

    console.log(`  · ${a.name}\n      ${before}\n   -> ${deduped.join(", ")}`);
    if (!APPLY) continue;
    md.teams = deduped;
    await db.update(agents).set({ metadata: md, updatedAt: new Date() }).where(eq(agents.id, a.id));
  }

  console.log(`\n${APPLY ? "applied" : "would apply"}: ${renamed} respelled, ${backfilled} campus tokens added`);
  if (skipped.length) {
    console.log(`\nleft alone (${skipped.length}) — decide these by hand:`);
    for (const s of skipped) console.log(`  ! ${s}`);
  }
  process.exit(0);
}

void main().catch((e) => { console.error(e); process.exit(1); });
