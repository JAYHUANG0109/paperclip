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
  const set = teams instanceof Set ? teams : new Set(teams);
  const parsed = parseTeamToken(token);
  if (!parsed.scoped) return set.has(parsed.campus);
  return set.has(parsed.campus) && !!parsed.department && set.has(parsed.department);
}

/** True if ANY of the sharing tokens matches the team set. */
export function anyTeamTokenMatches(tokens: readonly string[], teams: Set<string> | Iterable<string>): boolean {
  const set = teams instanceof Set ? teams : new Set(teams);
  return tokens.some((t) => teamTokenMatches(t, set));
}
