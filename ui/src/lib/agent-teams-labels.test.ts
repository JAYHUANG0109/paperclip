import { describe, expect, it } from "vitest";
import {
  CAMPUS_TEAMS,
  CAMPUS_DEPARTMENTS,
  CROSS_CAMPUS_GROUPS,
  localizeTeamName,
} from "./agent-teams";

// A team with no English label falls back to its raw Chinese name, so it renders
// as Chinese inside an otherwise English sidebar. That is how 幼教教學組 sat
// untranslated next to a translated "ESL Teaching" — nothing failed, it just
// looked broken. Anything the app treats as a known team must have a label.
describe("team labels", () => {
  const known = [
    ...CAMPUS_TEAMS,
    ...Object.values(CAMPUS_DEPARTMENTS).flat(),
    ...CROSS_CAMPUS_GROUPS,
  ];

  it("gives every known team an English label", () => {
    const untranslated = [...new Set(known)]
      .filter((team) => localizeTeamName(team, "en") === team)
      .sort();
    expect(untranslated, "add these to TEAM_EN in agent-teams.ts").toEqual([]);
  });

  it("leaves names alone under zh", () => {
    expect(localizeTeamName("總管理處", "zh-TW")).toBe("總管理處");
  });

  // The numbered spellings were a data-side stray: the UI's whole vocabulary —
  // TEAM_EN, CAMPUS_TEAMS, CAMPUS_DEPARTMENTS, DEPARTMENT_ROOM — keys off the
  // plain name, so a token like "00總管理處" is not recognized as a campus and
  // renders with its number visible.
  it("treats the plain campus name as canonical", () => {
    expect(CAMPUS_TEAMS.has("總管理處")).toBe(true);
    expect(CAMPUS_TEAMS.has("00總管理處")).toBe(false);
    expect(localizeTeamName("總管理處", "en")).toBe("General Administration");
  });
});
