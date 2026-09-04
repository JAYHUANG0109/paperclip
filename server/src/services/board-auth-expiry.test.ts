import { describe, expect, it } from "vitest";
import {
  BOARD_API_KEY_TTL_MS,
  boardApiKeyExpiresAt,
  resolveBoardApiKeyExpiry,
} from "./board-auth.js";

describe("resolveBoardApiKeyExpiry", () => {
  it("defaults to no expiry", () => {
    // Regression guard: a 30-day default locked the founder out of the API on
    // 2026-09-03 with an undiagnosable 401. Revocation is the control now, so a
    // key must not age out unless someone explicitly asks for a TTL.
    expect(resolveBoardApiKeyExpiry()).toBeNull();
    expect(resolveBoardApiKeyExpiry(undefined)).toBeNull();
    expect(resolveBoardApiKeyExpiry(null)).toBeNull();
  });

  it("honours an explicitly requested expiry", () => {
    const when = new Date("2026-12-31T00:00:00.000Z");
    expect(resolveBoardApiKeyExpiry(when)).toBe(when);
  });

  it("still offers the 30-day TTL helper for callers that want one", () => {
    const now = Date.UTC(2026, 8, 5, 0, 0, 0);
    expect(boardApiKeyExpiresAt(now).getTime()).toBe(now + BOARD_API_KEY_TTL_MS);
  });
});
