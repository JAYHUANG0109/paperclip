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

// t("some.key", { ...opts, defaultValue: "text", ...opts })
const T_CALL_WITH_DEFAULT =
  /\bt\(\s*["'`]([\w.\-]+)["'`]\s*,\s*\{[^}]*?defaultValue:\s*(["'])((?:\\.|(?!\2).)*)\2/gs;

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
    for (const match of src.matchAll(T_CALL_WITH_DEFAULT)) {
      const line = src.slice(0, match.index).split("\n").length;
      usages.push({
        key: match[1]!,
        defaultValue: match[3]!,
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
