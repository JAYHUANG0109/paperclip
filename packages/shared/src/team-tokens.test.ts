import { describe, expect, it } from "vitest";
import {
  anyTeamTokenMatches,
  canonicalTeamName,
  isAllowedTopTeam,
  isCanonicalCampus,
  makeScopedTeamToken,
  normalizeCampusToken,
  parseTeamToken,
  teamTokenMatches,
} from "./team-tokens.js";

describe("campus normalization + validation (org-placement guardrail)", () => {
  it("strips a trailing 校 only when the base is a real campus", () => {
    expect(normalizeCampusToken("北屯校")).toBe("北屯"); // the observed stranding typo
    expect(normalizeCampusToken("西屯校")).toBe("西屯");
    expect(normalizeCampusToken("  北屯校 ")).toBe("北屯"); // trims first
    expect(normalizeCampusToken("北屯")).toBe("北屯"); // already canonical
    expect(normalizeCampusToken("分校")).toBe("分校"); // base "分" not a campus → untouched
    expect(normalizeCampusToken("校")).toBe("校"); // too short → untouched
  });

  it("recognizes the six real campuses", () => {
    for (const c of ["仁美", "市政", "西屯", "黎明", "北屯", "總管理處"]) {
      expect(isCanonicalCampus(c)).toBe(true);
    }
    expect(isCanonicalCampus("北屯校")).toBe(false);
    expect(isCanonicalCampus("領導團隊")).toBe(false);
  });

  it("allows campuses + leadership/system as top team, rejects others", () => {
    expect(isAllowedTopTeam("西屯")).toBe(true);
    expect(isAllowedTopTeam("領導團隊")).toBe(true);
    expect(isAllowedTopTeam("系統自動化")).toBe(true);
    expect(isAllowedTopTeam("北屯校")).toBe(false); // must be normalized first
    expect(isAllowedTopTeam("幼教學組")).toBe(false); // a department is not a valid top
  });
});

describe("team tokens", () => {
  it("parses plain vs scoped tokens", () => {
    expect(parseTeamToken("北屯")).toEqual({ scoped: false, campus: "北屯", department: null });
    expect(parseTeamToken("北屯／幼教學組")).toEqual({ scoped: true, campus: "北屯", department: "幼教學組" });
  });

  it("makeScopedTeamToken round-trips", () => {
    const tok = makeScopedTeamToken("北屯", "幼教學組");
    expect(tok).toBe("北屯／幼教學組");
    expect(parseTeamToken(tok)).toMatchObject({ scoped: true, campus: "北屯", department: "幼教學組" });
  });

  const beitunTeaching = new Set(["北屯", "幼教學組"]);
  const xitunTeaching = new Set(["西屯", "幼教學組"]);
  const beitunReg = new Set(["北屯", "註冊組"]);

  it("plain campus token matches anyone in that campus (OR, unchanged)", () => {
    expect(teamTokenMatches("北屯", beitunTeaching)).toBe(true);
    expect(teamTokenMatches("北屯", beitunReg)).toBe(true);
    expect(teamTokenMatches("北屯", xitunTeaching)).toBe(false);
  });

  it("plain department token matches that dept across every campus (OR, unchanged)", () => {
    expect(teamTokenMatches("幼教學組", beitunTeaching)).toBe(true);
    expect(teamTokenMatches("幼教學組", xitunTeaching)).toBe(true);
    expect(teamTokenMatches("幼教學組", beitunReg)).toBe(false);
  });

  it("scoped token matches ONLY that campus's that department (AND)", () => {
    expect(teamTokenMatches("北屯／幼教學組", beitunTeaching)).toBe(true);
    expect(teamTokenMatches("北屯／幼教學組", xitunTeaching)).toBe(false); // right dept, wrong campus
    expect(teamTokenMatches("北屯／幼教學組", beitunReg)).toBe(false); // right campus, wrong dept
  });

  it("scoped token with a missing half never matches", () => {
    expect(teamTokenMatches("北屯／", beitunTeaching)).toBe(false);
  });

  it("anyTeamTokenMatches ORs across the sharing list", () => {
    expect(anyTeamTokenMatches(["西屯", "北屯／幼教學組"], beitunTeaching)).toBe(true);
    expect(anyTeamTokenMatches(["西屯", "北屯／註冊組"], beitunTeaching)).toBe(false);
    expect(anyTeamTokenMatches([], beitunTeaching)).toBe(false);
  });

  it("accepts an array of team names too", () => {
    expect(teamTokenMatches("北屯／幼教學組", ["北屯", "幼教學組"])).toBe(true);
  });
});

describe("領導團隊 → 園長團隊 rename", () => {
  // 37 skills and 15 folders named 領導團隊 when the rename landed. Dropping the
  // old name would have silently revoked access rather than failing loudly, so
  // both spellings must resolve to the same people in both directions.
  it("matches an old share against a new team set", () => {
    expect(teamTokenMatches("領導團隊", ["園長團隊", "總園長", "仁美"])).toBe(true);
  });

  it("matches a new share against an old team set", () => {
    expect(teamTokenMatches("園長團隊", ["領導團隊", "仁美"])).toBe(true);
  });

  it("accepts either spelling as teams[0]", () => {
    expect(isAllowedTopTeam("園長團隊")).toBe(true);
    expect(isAllowedTopTeam("領導團隊")).toBe(true);
  });

  it("normalizes the old name forward", () => {
    expect(normalizeCampusToken("領導團隊")).toBe("園長團隊");
    expect(canonicalTeamName("領導團隊")).toBe("園長團隊");
  });

  it("does not make unrelated teams match each other", () => {
    expect(teamTokenMatches("園長團隊", ["系統自動化"])).toBe(false);
    expect(teamTokenMatches("總園長", ["園長"])).toBe(false);
  });
});
