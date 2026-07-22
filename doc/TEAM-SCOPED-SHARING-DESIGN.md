# Campus × department team selector + scoped sharing — design for review

**Goal:** let a user share a skill (or scope a folder / policy) to a *specific*
campus-department, e.g. **北屯's 教學組** — not just "北屯 (whole campus)" or
"教學組 (every campus)". Replace the flat OR chip list with an intuitive
cascading **校區 › 部門** picker.

> STATUS: design for Jay's review. **No build until approved** — this changes
> access matching, so it ships with tests + a review, not a silent tweak.

## Today (why it can't express the intersection)
- Team membership is a flat array `metadata.teams = [校區, 部門]`.
- Sharing stores `sharingTeams: string[]`; access = **OR**:
  `sharingTeams.some(t => viewerTeams.has(t))`
  (`server/src/services/company-skills.ts:3109` skills, `:6872` folders/policies;
  `viewerTeams` = union of the user's agents' team strings via `getUserTeams`).
- So `北屯` matches the whole campus, `教學組` matches that dept in every campus;
  there is **no token** for "北屯 AND 教學組".

## Design — scoped tokens (backward compatible)
Keep `sharingTeams: string[]`; introduce one new token shape. **No schema change.**

| Token | Means | Match rule |
|---|---|---|
| `北屯` | whole campus | `viewerTeams.has("北屯")` (unchanged) |
| `幼教學組` | that dept, all campuses | `viewerTeams.has("幼教學組")` (unchanged) |
| `北屯／幼教學組` | **one campus's one dept** | `viewerTeams.has("北屯") && viewerTeams.has("幼教學組")` |

A shared helper does the matching:
```ts
// "／" (full-width) separates campus／department in a scoped token.
export function teamTokenMatches(token: string, viewerTeams: Set<string>): boolean {
  const i = token.indexOf("／");
  if (i < 0) return viewerTeams.has(token);            // plain token → today's behavior
  const campus = token.slice(0, i), dept = token.slice(i + 1);
  return viewerTeams.has(campus) && viewerTeams.has(dept);
}
```
Both match sites become `sharingTeams.some(t => teamTokenMatches(t, viewerTeams))`.
**Existing shares keep working** (they're all plain tokens).

## UI — cascading 校區 › 部門 picker
A reusable `<TeamScopePicker>` replacing the flat chips in: the skill **upload**
dialog (分享給團隊) and the folder **create/edit** dialogs
(`ui/src/pages/CompanySkills.tsx`).

```
▸ 北屯            ☐ 整個北屯          → token 北屯
    ☐ 幼教學組  ☐ 外師教學組  …      → token 北屯／幼教學組
▸ 總部            ☐ 整個總部
    ☐ 數位資訊部  ☐ 人才發展部  …
▸ 跨校 / 全部
    ☐ 領導團隊  ☐ 系統自動化         → token 領導團隊
    ☐ 幼教學組（所有校區）           → token 幼教學組
```
- **整個校區** checkbox → plain campus token.
- a **department under a campus** → scoped `校區／部門` token.
- **跨校/全部** section → plain department / cross-campus-group tokens.
- Selected tokens shown as removable chips (labeled `北屯 · 幼教學組`), localized
  via `localizeTeamName` (both halves).

### Picker options source
A static **campus → departments catalog** (from `doc/sa-campus-roster.md`) so you
can target a valid combo even before that team has any agent. Cross-campus groups
(`領導團隊`, `系統自動化`) and the campus-agnostic department list come from the
same catalog. (Alternative: derive only combos that currently have agents —
rejected: can't pre-share to an empty team.)

## Touch points
1. `ui/src/lib/agent-teams.ts` — add `teamTokenMatches` (mirror server), the
   campus→department catalog, and a `formatScopedTeam` label helper.
2. `packages/shared` (or a shared util) — `teamTokenMatches` so client + server
   agree; server imports the same rule.
3. `server/src/services/company-skills.ts` — swap the two `.some(has)` sites for
   `teamTokenMatches`. (Also the agent-equip-by-team path if it filters by team.)
4. `ui/src/pages/CompanySkills.tsx` — new `<TeamScopePicker>` in upload + folder
   dialogs; store the emitted tokens in `sharingTeams`.

## Edge cases / notes
- A user with **agents in two campuses**: `getUserTeams` unions both, so a scoped
  token could match across different agents (rare). Acceptable for v1; note it.
- Token cap stays 50; scoped tokens count the same.
- Privileged viewers (owner/admin, IT-dept sharers) unaffected.

## Rollout / safety
Backward compatible (plain tokens unchanged). Ships with unit tests for
`teamTokenMatches` (plain OR, scoped AND, non-match) + the picker. Verify
(typecheck + tests) before deploy; you review before it goes live, per the
access-control rule.
