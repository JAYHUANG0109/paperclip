// Team sharing tokens. A share target (skill / folder / policy `sharingTeams`)
// is a list of these tokens; access is granted if ANY token matches the
// viewer's / agent's team set.
//
//   "北屯"            → whole campus            → match if teams has "北屯"
//   "幼教學組"         → that dept, all campuses → match if teams has "幼教學組"
//   "北屯／幼教學組"    → one campus's one dept   → match if teams has BOTH
//
// The full-width slash "／" (U+FF0F) separates campus／department in a scoped
// token — chosen over "/" so it never collides with a literal team name.
// Plain (unscoped) tokens keep the original OR behavior, so every pre-existing
// share is unaffected.

export const SCOPED_TEAM_SEPARATOR = "／";

// The six real campuses — the canonical top level of the team hierarchy
// (`metadata.teams[0]`). Keep in sync with doc/sa-org-chart.md and the UI's
// CAMPUS_TEAMS (ui/src/lib/agent-teams.ts).
export const CANONICAL_CAMPUSES = ["仁美", "市政", "西屯", "黎明", "北屯", "總管理處"] as const;

// The leadership groups. 園長團隊 was disbanded on 2026-09-11 (owner's call) and
// its ranks became independent TOP-level groups, level with 幼教主管／ESL主管:
// the founder alone in 創辦人, 哈曉如 and 吳家秀 in 總園長, and every other
// 園長／副園長 plus 張廖心淑 (處長) merged into 園長 & 處長.
export const FOUNDER_TEAM = "創辦人";
export const HEAD_PRINCIPAL_TEAM = "總園長";
export const PRINCIPAL_TEAM = "園長 & 處長";

/**
 * Every group that counts as leadership, for the permission checks that used to
 * key off the single 園長團隊 token.
 *
 * The disbanded name is NOT aliased forward: it was one group becoming three, so
 * any single successor would be wrong for two thirds of the people. Sharing
 * lists that named it were expanded to all three by
 * scripts/migrate-org-groups-2026-09.ts instead.
 */
export const LEADERSHIP_TEAMS = [FOUNDER_TEAM, HEAD_PRINCIPAL_TEAM, PRINCIPAL_TEAM] as const;

/** @deprecated The group is disbanded; kept so old data still reads as leadership. */
export const LEGACY_LEADERSHIP_TEAMS = ["園長團隊", "領導團隊"] as const;

// Renames. Old tokens survive in skill/folder sharing lists and in anything
// typed before a rename, so they are normalized forward rather than rejected —
// dropping them would silently revoke access.
//   領導團隊  → 園長團隊 on 2026-09-01 (that group is now disbanded, see above)
//   幼教教學組 → 幼教主管 and ESL教學組 → ESL主管 on 2026-09-11: the top-level
//   group is the supervisor layer; the 幼教教學／幼教行政／ESL教學／ESL行政
//   sub-teams under it are unchanged.
const LEGACY_TOP_TEAM_ALIASES: Readonly<Record<string, string>> = {
  // Both disbanded leadership names collapse onto the later of the two, so a
  // stale token has ONE spelling everywhere. Neither resolves to a successor
  // group: that was a 1→3 split (see LEADERSHIP_TEAMS), and picking one would
  // be wrong for two thirds of the people.
  "領導團隊": "園長團隊",
  "幼教教學組": "幼教主管",
  "ESL教學組": "ESL主管",
};

/** The current name for a team, following any rename. Unknown names pass through. */
export function canonicalTeamName(name: string): string {
  return LEGACY_TOP_TEAM_ALIASES[name] ?? name;
}

// Non-campus values legitimately allowed as `teams[0]`: the three leadership
// groups and infrastructure/system agents. These are the only top-team values
// that don't require a campus or a manager. The disbanded 園長團隊 stays listed
// so a stale payload is normalized rather than rejected outright.
export const ALLOWED_NON_CAMPUS_TOP_TEAMS = [
  ...LEADERSHIP_TEAMS,
  ...LEGACY_LEADERSHIP_TEAMS,
  "系統自動化",
] as const;

/**
 * Where an agent belongs when it is nobody's: no team given and no owner email,
 * so it is infrastructure rather than a person's agent. Filing these here keeps
 * 未分組 ("ungrouped") empty, which is what makes an agent showing up there a
 * real signal that something was mis-created rather than routine noise.
 */
export const SYSTEM_AUTOMATION_TEAM = "系統自動化";

const CANONICAL_CAMPUS_SET: ReadonlySet<string> = new Set(CANONICAL_CAMPUSES);

/** True if `s` is one of the six real campuses. */
export function isCanonicalCampus(s: string): boolean {
  return CANONICAL_CAMPUS_SET.has(s);
}

/**
 * Normalize a campus token: trim, and drop a trailing "校" when the base is a
 * real campus (e.g. "北屯校" → "北屯", "西屯校" → "西屯"). Anything else is
 * returned trimmed but otherwise untouched, so department tokens and unknown
 * values pass through unchanged.
 */
export function normalizeCampusToken(raw: string): string {
  const t = (raw ?? "").trim();
  const alias = canonicalTeamName(t);
  if (alias !== t) return alias;
  if (t.length > 1 && t.endsWith("校")) {
    const base = t.slice(0, -1);
    if (CANONICAL_CAMPUS_SET.has(base)) return base;
  }
  return t;
}

/** True if `top` is a valid `teams[0]`: a real campus or an allowed root/infra team. */
export function isAllowedTopTeam(top: string): boolean {
  const t = canonicalTeamName(top);
  return CANONICAL_CAMPUS_SET.has(t) || (ALLOWED_NON_CAMPUS_TOP_TEAMS as readonly string[]).includes(t);
}

export interface ParsedTeamToken {
  scoped: boolean;
  campus: string;
  department: string | null;
}

/** Split a token into its campus / department parts (department null if plain). */
export function parseTeamToken(token: string): ParsedTeamToken {
  const i = token.indexOf(SCOPED_TEAM_SEPARATOR);
  if (i < 0) return { scoped: false, campus: token, department: null };
  return {
    scoped: true,
    campus: token.slice(0, i),
    department: token.slice(i + SCOPED_TEAM_SEPARATOR.length),
  };
}

/** Build a scoped token from a campus + department. */
export function makeScopedTeamToken(campus: string, department: string): string {
  return `${campus}${SCOPED_TEAM_SEPARATOR}${department}`;
}

/**
 * Does one sharing token match a team set? Plain token → membership (OR, the
 * original behavior). Scoped `校區／部門` → the set must contain BOTH halves.
 * Accepts a Set or array of team names.
 */
export function teamTokenMatches(token: string, teams: Set<string> | Iterable<string>): boolean {
  // A team set written before the 領導團隊 → 園長團隊 rename must still match a
  // share written after it, and vice versa, so both sides are compared on the
  // canonical name rather than the literal one.
  const set = new Set<string>();
  for (const t of teams) set.add(canonicalTeamName(t));
  const has = (name: string) => set.has(canonicalTeamName(name));
  const parsed = parseTeamToken(token);
  if (!parsed.scoped) return has(parsed.campus);
  return has(parsed.campus) && !!parsed.department && has(parsed.department);
}

/** True if ANY of the sharing tokens matches the team set. */
export function anyTeamTokenMatches(tokens: readonly string[], teams: Set<string> | Iterable<string>): boolean {
  const set = teams instanceof Set ? teams : new Set(teams);
  return tokens.some((t) => teamTokenMatches(t, set));
}
