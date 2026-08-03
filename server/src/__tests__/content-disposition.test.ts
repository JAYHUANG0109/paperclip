import { describe, expect, it } from "vitest";
import { validateHeaderValue } from "node:http";
import { contentDispositionHeader } from "../http/content-disposition.js";

/**
 * The header that broke every thumbnail on the decisions page.
 *
 * HTTP header values are latin1. Filenames on this deployment are usually
 * Chinese, and handing one straight to `res.setHeader` makes Node throw
 * ERR_INVALID_CHAR — a 500 on a download, and a silently broken `<img>` with no
 * clue anywhere in the UI. Three call sites had it wrong while a fourth had the
 * fix written out inline beside it.
 *
 * So the load-bearing assertion here is not the format: it is that Node ACCEPTS
 * the value. A format test would have passed on the old code too.
 */

/**
 * Node's OWN validator — the same check `res.setHeader` runs, and the thing that
 * used to throw ERR_INVALID_CHAR. Asserting against anything else would be
 * asserting against my own idea of the rule rather than the rule.
 */
function setsWithoutThrowing(value: string): boolean {
  try {
    validateHeaderValue("Content-Disposition", value);
    return true;
  } catch {
    return false;
  }
}

describe("contentDispositionHeader", () => {
  // The exact filename from the live data that produced the 500s.
  it("accepts a Chinese filename that used to throw", () => {
    const value = contentDispositionHeader("inline", "截圖 2026-06-16 晚上11.15.34.png");

    expect(setsWithoutThrowing(value)).toBe(true);
  });

  it("is settable for every awkward name, not just the one we saw", () => {
    const names = [
      "截圖 2026-06-16 晚上11.15.34.png",
      "報告(最終版).pdf",
      'quote"inside.png',
      "emoji-🎓-name.png",
      "line\nbreak.png",
      "Ünïcödé.txt",
      "  ",
      "",
    ];

    for (const name of names) {
      expect(setsWithoutThrowing(contentDispositionHeader("attachment", name))).toBe(true);
    }
  });

  /**
   * Both halves are needed. The ASCII fallback alone would download every CJK
   * file as "________.png"; `filename*` alone is ignored by older clients.
   */
  it("carries the real name in filename* and a safe one in filename", () => {
    const value = contentDispositionHeader("inline", "截圖.png");

    expect(value).toContain('filename="__.png"');
    expect(value).toContain("filename*=UTF-8''");
    expect(value).toContain(encodeURIComponent("截圖.png"));
  });

  /**
   * An ASCII name needs no `filename*` — the plain parameter already carries it.
   * Adding one anyway would have changed the header on every existing download
   * to fix a case those downloads never had.
   */
  it("leaves an ASCII name exactly as it was, with no extension parameter", () => {
    const value = contentDispositionHeader("attachment", "quarterly-report.pdf");

    expect(value).toBe('attachment; filename="quarterly-report.pdf"');
  });

  /**
   * A quote inside a quoted-string is how a header gets split, and `'` would end
   * the RFC 5987 ext-value early. Neither may survive into the output.
   */
  it("neutralises characters that could break the header apart", () => {
    const value = contentDispositionHeader("inline", 'a"b\r\nc\'d.png');

    expect(value.slice(value.indexOf('filename="'), value.indexOf("filename*"))).not.toContain('"b');
    expect(value).not.toMatch(/[\r\n]/);
    expect(value.split("filename*=UTF-8''")[1]).not.toContain("'");
  });

  it("falls back to a usable name when there is nothing to work with", () => {
    for (const empty of ["", "   ", null, undefined]) {
      const value = contentDispositionHeader("attachment", empty);
      expect(value).toContain('filename="file"');
      expect(setsWithoutThrowing(value)).toBe(true);
    }
  });

  it("honours the disposition it was given", () => {
    expect(contentDispositionHeader("inline", "a.png")).toMatch(/^inline;/);
    expect(contentDispositionHeader("attachment", "a.png")).toMatch(/^attachment;/);
  });
});
