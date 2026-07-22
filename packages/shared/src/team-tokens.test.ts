import { describe, expect, it } from "vitest";
import { anyTeamTokenMatches, makeScopedTeamToken, parseTeamToken, teamTokenMatches } from "./team-tokens.js";

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
