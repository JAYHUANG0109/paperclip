// @vitest-environment node

// The third i18n gap. locale-validation compares en.json to zh-TW.json;
// locale-coverage compares the code's t() keys to both files. Neither can see a
// string that never goes through t() at all — a bare literal in JSX renders the
// same text to every user, in whichever language it was typed.
//
// That is the state the UI is in: this fork authors in Traditional Chinese, so
// English users meet Chinese labels mid-page (新增同仁代理人 sitting under "Add a
// new agent"), while zh-TW users meet untranslated English elsewhere.
//
// Fixing all of it at once is not realistic, so this is a RATCHET: the files
// listed in BASELINE are the known-untranslated ones, and the test fails if a
// NEW file joins them. When you translate one, delete it from the list — the
// test also fails on a stale entry, so the list can only shrink.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const UI_SRC = path.resolve(__dirname, "..");
const CJK = /[㐀-䶿一-鿿豈-﫿]/;

/**
 * Files with user-visible CJK literals as of 2026-08-27. Shrink this list; never
 * grow it. Run with UPDATE_I18N_BASELINE=1 to see the current set printed.
 */
const BASELINE = new Set<string>([
  "components/AgentConfigForm.tsx",
  "components/FounderDigestSection.tsx",
  "components/LivingOfficeFloor.tsx",
  "components/MyScheduleSection.tsx",
  "components/NewIssueDialog.tsx",
  "components/ProjectCustomFieldsManager.tsx",
  "components/ProjectMembersPanel.tsx",
  "components/SidebarAccountMenu.tsx",
  "pages/VirtualOffice.tsx",
]);

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "locales") sourceFiles(full, acc);
    } else if (entry.name.endsWith(".tsx") && !entry.name.includes(".test.")) {
      acc.push(full);
    }
  }
  return acc;
}

/** Drop comments and template literals so prose in code notes is not flagged. */
function strip(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
    .replace(/`(?:[^`\\]|\\[\s\S])*`/g, "``");
}

/**
 * Any CJK string literal the code carries itself, rather than looking up. That
 * deliberately includes labels held in a lookup table and read into JSX later —
 * narrowing this to JSX text nodes missed all but two files, because most of the
 * untranslated UI keeps its Chinese in const maps.
 *
 * Two things are not translation bugs and are excluded: a string handed to t()
 * as its defaultValue (that IS the translation path), and a file marked
 * `i18n-exempt` — for content written FOR an agent rather than shown to a user,
 * like the request body the new-colleague form composes.
 */
function hardcodedCjk(source: string): string[] {
  if (/i18n-exempt/.test(source)) return [];
  const stripped = strip(source);
  const hits: string[] = [];
  for (const m of stripped.matchAll(/(?:"([^"\n]*)"|'([^'\n]*)')/g)) {
    const text = (m[1] ?? m[2] ?? "").trim();
    if (!text || !CJK.test(text)) continue;
    // defaultValue: "…" is the sanctioned fallback, not a hardcoded string.
    const before = stripped.slice(Math.max(0, m.index! - 24), m.index!);
    if (/defaultValue\s*:\s*$/.test(before)) continue;
    hits.push(text);
  }
  return hits;
}

describe("hardcoded user-visible strings", () => {
  const offenders = new Map<string, string[]>();
  for (const file of sourceFiles(UI_SRC)) {
    const hits = hardcodedCjk(fs.readFileSync(file, "utf8"));
    if (hits.length > 0) offenders.set(path.relative(UI_SRC, file), hits);
  }

  if (process.env.UPDATE_I18N_BASELINE) {
    // eslint-disable-next-line no-console
    console.log([...offenders.keys()].sort().map((f) => `  "${f}",`).join("\n"));
  }

  it("adds no new untranslated file", () => {
    const added = [...offenders.keys()].filter((f) => !BASELINE.has(f)).sort();
    expect(
      added,
      `These render CJK text directly instead of going through t():\n` +
        added.map((f) => `  ${f}: ${offenders.get(f)!.slice(0, 3).join(" / ")}`).join("\n"),
    ).toEqual([]);
  });

  it("keeps the baseline honest — remove a file once it is translated", () => {
    const stale = [...BASELINE].filter((f) => !offenders.has(f)).sort();
    expect(stale, "already translated; delete from BASELINE").toEqual([]);
  });
});
