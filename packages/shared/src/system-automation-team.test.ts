import { describe, expect, it } from "vitest";
import {
  ALLOWED_NON_CAMPUS_TOP_TEAMS,
  isAllowedTopTeam,
  SYSTEM_AUTOMATION_TEAM,
} from "./team-tokens.js";

describe("系統自動化 default placement team", () => {
  it("is a valid teams[0], so the default placement survives enforceOrgPlacement", () => {
    expect(isAllowedTopTeam(SYSTEM_AUTOMATION_TEAM)).toBe(true);
  });

  // It must be a non-campus top team specifically: campus teams additionally
  // require a reportsTo, which an unowned infrastructure agent has no reason to
  // have. Placing the default anywhere else would make unowned agents unhireable.
  it("is a non-campus top team, so it needs no manager", () => {
    expect(ALLOWED_NON_CAMPUS_TOP_TEAMS).toContain(SYSTEM_AUTOMATION_TEAM);
  });

  it("matches the literal the rest of the platform keys off", () => {
    // e.g. services/onboarding.ts skips onboarding for teams including this value.
    expect(SYSTEM_AUTOMATION_TEAM).toBe("系統自動化");
  });
});
