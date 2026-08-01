import { describe, expect, it } from "vitest";
import {
  PROVISIONAL_TITLE_FALLBACK,
  PROVISIONAL_TITLE_MAX_CHARS,
  deriveProvisionalIssueTitle,
} from "./provisional-issue-title.js";

describe("deriveProvisionalIssueTitle", () => {
  it("uses the first meaningful line", () => {
    expect(deriveProvisionalIssueTitle("Fix the login redirect\n\nMore detail here.")).toBe(
      "Fix the login redirect",
    );
  });

  it("skips leading blank lines", () => {
    expect(deriveProvisionalIssueTitle("\n\n  \nActually start here")).toBe("Actually start here");
  });

  it("takes the first sentence out of a long opening line", () => {
    const description =
      "Fix the redirect. Then also audit every other callback path for the same mistake.";
    expect(deriveProvisionalIssueTitle(description)).toBe("Fix the redirect.");
  });

  it("strips markdown decoration", () => {
    expect(deriveProvisionalIssueTitle("## **Ship** the `memory` page")).toBe(
      "Ship the memory page",
    );
    expect(deriveProvisionalIssueTitle("- [ ] Review the PR")).toBe("Review the PR");
    expect(deriveProvisionalIssueTitle("1. Deploy to live")).toBe("Deploy to live");
  });

  it("keeps link text and drops the target", () => {
    expect(deriveProvisionalIssueTitle("See [the plan](https://example.com/x) first")).toBe(
      "See the plan first",
    );
  });

  // CJK has no spaces to break on, so the word-boundary logic must not return
  // an empty string for Chinese input.
  it("truncates Chinese text without losing it", () => {
    const description = "請幫我把這個任務的標題自動產生出來".repeat(10);
    const title = deriveProvisionalIssueTitle(description);

    expect(title.length).toBeLessThanOrEqual(PROVISIONAL_TITLE_MAX_CHARS + 1); // +1 for the ellipsis
    expect(title.startsWith("請幫我把這個任務")).toBe(true);
  });

  it("breaks on a word boundary for long prose", () => {
    const description = `${"alpha bravo charlie delta echo foxtrot golf hotel india juliet ".repeat(3)}`;
    const title = deriveProvisionalIssueTitle(description);

    expect(title.length).toBeLessThanOrEqual(PROVISIONAL_TITLE_MAX_CHARS + 1);
    expect(title.endsWith("…")).toBe(true);
    expect(title).not.toContain("  ");
  });

  // The column is NOT NULL and a blank title would render as an empty row.
  it("falls back rather than returning an empty title", () => {
    expect(deriveProvisionalIssueTitle("")).toBe(PROVISIONAL_TITLE_FALLBACK);
    expect(deriveProvisionalIssueTitle(null)).toBe(PROVISIONAL_TITLE_FALLBACK);
    expect(deriveProvisionalIssueTitle(undefined)).toBe(PROVISIONAL_TITLE_FALLBACK);
    expect(deriveProvisionalIssueTitle("   \n\n  ")).toBe(PROVISIONAL_TITLE_FALLBACK);
    expect(deriveProvisionalIssueTitle("![screenshot](a.png)")).toBe(PROVISIONAL_TITLE_FALLBACK);
  });

  it("normalizes CRLF", () => {
    expect(deriveProvisionalIssueTitle("First line\r\nSecond line")).toBe("First line");
  });
});
