// @vitest-environment node

// Guards the gap that locale-validation.test.ts structurally cannot see.
//
// That test compares en.json and zh-TW.json against EACH OTHER, so both files
// staying in perfect sync (6183 keys each) reads as healthy. It never checks
// either file against the keys the code actually asks for. A `t("some.key", {
// defaultValue: "..." })` whose key is in NEITHER file silently renders its
// hardcoded fallback — and because this fork authors UI in Traditional Chinese
// first, that fallback is usually Chinese, so English users saw Chinese.
//
// That is exactly how the agent-detail tabs shipped as "運作方式" and "專案" in an
// otherwise English UI: 165 keys were missing from both files, 123 of them with
// Chinese fallbacks. Nothing failed, because nothing compared code to locales.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import en from "./locales/en.json";
import zhTW from "./locales/zh-TW.json";

const UI_SRC = path.resolve(__dirname, "..");

/** Every dotted leaf path in a locale file. */
function flattenKeys(value: unknown, prefix = "", out = new Set<string>()): Set<string> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      flattenKeys(v, prefix ? `${prefix}.${k}` : k, out);
    }
  } else if (prefix) {
    out.add(prefix);
  }
  return out;
}

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip the locale JSON itself; skip nothing else, so new areas are covered
      // automatically as the app grows.
      if (entry.name !== "locales") sourceFiles(full, acc);
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

// t("some.key", { ... }) — the options object is found by brace depth, not by a
// naive [^}]*? scan.
//
// That naive form is wrong in a way that silently corrupts data: an option value
// may itself be a t() call with its own defaultValue, e.g.
//
//   t("runLedger.denial.unauthorizedBody", {
//     name: label ?? t("runLedger.denial.thatUser", { defaultValue: "that user" }),
//     defaultValue: "This run stopped because {{name}} …",
//   })
//
// There is no `}` between the outer `{` and the INNER defaultValue, so the scan
// walks straight into the nested call and pairs the OUTER key with the INNER
// text. Doing exactly that wrote "that user" over two real user-facing messages,
// and hid the nested keys entirely — the extractor never emitted them, so this
// test could not report them missing either.
const T_CALL_OPEN = /\bt\(\s*["'`]([\w.\-]+)["'`]\s*,\s*\{/g;
const DEFAULT_VALUE = /defaultValue:\s*(["'])((?:\\.|(?!\1).)*)\1/;

/** Every (key, defaultValue) pair in a source file, nesting-aware. */
function extractPairs(src: string): Array<{ key: string; defaultValue: string; index: number }> {
  const out: Array<{ key: string; defaultValue: string; index: number }> = [];
  for (const open of src.matchAll(T_CALL_OPEN)) {
    const key = open[1]!;
    // Walk to the matching close brace of this options object.
    let depth = 1;
    let i = open.index + open[0].length;
    const start = i;
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
      i += 1;
    }
    const block = src.slice(start, i - 1);
    // The defaultValue belonging to THIS call is the one at depth 0 of its block.
    let d = 0;
    let cursor = 0;
    while (cursor < block.length) {
      const ch = block[cursor];
      if (ch === "{") { d += 1; cursor += 1; continue; }
      if (ch === "}") { d -= 1; cursor += 1; continue; }
      if (d === 0 && block.startsWith("defaultValue:", cursor)) {
        const m = DEFAULT_VALUE.exec(block.slice(cursor));
        if (m) { out.push({ key, defaultValue: m[2]!, index: open.index }); break; }
      }
      cursor += 1;
    }
  }
  return out;
}

const CJK = /[㐀-䶿一-鿿　-〿＀-￯]/;

interface Usage {
  key: string;
  defaultValue: string;
  where: string;
}

function collectUsages(): Usage[] {
  const usages: Usage[] = [];
  for (const file of sourceFiles(UI_SRC)) {
    const src = fs.readFileSync(file, "utf8");
    for (const pair of extractPairs(src)) {
      const line = src.slice(0, pair.index).split("\n").length;
      usages.push({
        key: pair.key,
        defaultValue: pair.defaultValue,
        where: `${path.relative(UI_SRC, file)}:${line}`,
      });
    }
  }
  return usages;
}

const usages = collectUsages();
const enKeys = flattenKeys(en);
const zhKeys = flattenKeys(zhTW);

describe("locale coverage (code → locale files)", () => {
  it("finds t() calls to check, so a broken scanner cannot pass vacuously", () => {
    // If a refactor changes how translations are called, this test must fail
    // loudly rather than silently checking nothing.
    expect(usages.length).toBeGreaterThan(1500);
  });

  it("has every translated key present in en.json", () => {
    const missing = usages
      .filter((u) => !enKeys.has(u.key))
      .map((u) => `${u.where}  ${u.key}  (renders: "${u.defaultValue.slice(0, 40)}")`);
    expect(missing, `keys used in code but absent from en.json:\n${missing.join("\n")}`).toEqual([]);
  });

  it("has every translated key present in zh-TW.json", () => {
    const missing = usages
      .filter((u) => !zhKeys.has(u.key))
      .map((u) => `${u.where}  ${u.key}  (renders: "${u.defaultValue.slice(0, 40)}")`);
    expect(missing, `keys used in code but absent from zh-TW.json:\n${missing.join("\n")}`).toEqual([]);
  });

  it("never lets a Chinese fallback stand in for a missing English string", () => {
    // The specific failure that shipped: an English-locale user reading Chinese.
    // Redundant with the en.json check above by construction, but it names the
    // user-visible symptom so a future regression is diagnosed in one read.
    const chineseLeaks = usages
      .filter((u) => CJK.test(u.defaultValue) && !enKeys.has(u.key))
      .map((u) => `${u.where}  ${u.key}  "${u.defaultValue.slice(0, 40)}"`);
    expect(chineseLeaks, `English UI would render Chinese here:\n${chineseLeaks.join("\n")}`).toEqual([]);
  });
});
