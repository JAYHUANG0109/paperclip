import { describe, expect, it } from "vitest";
import { isValidAsanaPat } from "./agent-connections.js";

// Shape only — never a real credential in a fixture.
const SYNTHETIC_PAT = `2/${"1".repeat(16)}/${"2".repeat(16)}:${"a".repeat(32)}`;

describe("isValidAsanaPat", () => {
  it("accepts a personal access token shape", () => {
    expect(isValidAsanaPat(SYNTHETIC_PAT)).toBe(true);
  });

  it("tolerates surrounding whitespace, which pasting reliably adds", () => {
    expect(isValidAsanaPat(`  ${SYNTHETIC_PAT}\n`)).toBe(true);
  });

  it("rejects anything that is not a PAT", () => {
    for (const bad of ["", "not-a-token", "1/123/456:abc", "2/12/34:zz"]) {
      expect(isValidAsanaPat(bad)).toBe(false);
    }
  });
});
