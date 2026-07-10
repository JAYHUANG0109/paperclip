#!/usr/bin/env node
/**
 * sync-locales — keep every locale file in key-parity with en.json.
 *
 * The app ships exactly two locales: en (source of truth) and zh-TW (the only
 * other selectable language — see src/i18n/resolveLocale.ts). This script is
 * directory-driven: it reconciles whatever locale files exist against en.json.
 * For every non-source locale it:
 *   - adds any key missing from that locale, using the English value as a
 *     fallback,
 *   - drops any extra key not present in en.json,
 *   - reorders keys to match en.json (stable, review-friendly diffs).
 *
 * Existing translated values are never overwritten. So the workflow for adding
 * UI strings is a 2-file edit (en.json + zh-TW.json), then `npm run
 * sync-locales` to guarantee key parity.
 *
 * Run:  node scripts/sync-locales.mjs          (writes changes)
 *       node scripts/sync-locales.mjs --check   (CI mode: fail if drifted)
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const localesDir = join(here, "..", "src", "i18n", "locales");
const SOURCE = "en";
const checkOnly = process.argv.includes("--check");

const read = (locale) =>
  JSON.parse(readFileSync(join(localesDir, `${locale}.json`), "utf8"));

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Build a value shaped exactly like `source`, preferring existing `target` leaves. */
function reconcile(source, target) {
  if (!isObject(source)) {
    // Leaf: keep the target's own string when present, else fall back to source.
    return typeof target === "string" ? target : source;
  }
  const out = {};
  const t = isObject(target) ? target : {};
  for (const key of Object.keys(source)) {
    out[key] = reconcile(source[key], t[key]);
  }
  return out;
}

const en = read(SOURCE);
const files = readdirSync(localesDir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.replace(/\.json$/, ""))
  .filter((l) => l !== SOURCE)
  .sort();

const serialize = (obj) => `${JSON.stringify(obj, null, 2)}\n`;
const drifted = [];

for (const locale of files) {
  const current = read(locale);
  const reconciled = reconcile(en, current);
  const before = serialize(current);
  const after = serialize(reconciled);
  if (before !== after) {
    drifted.push(locale);
    if (!checkOnly) writeFileSync(join(localesDir, `${locale}.json`), after);
  }
}

if (checkOnly) {
  if (drifted.length) {
    console.error(
      `Locale files out of parity with ${SOURCE}.json: ${drifted.join(", ")}\n` +
        `Run \`npm run sync-locales\` to fix.`,
    );
    process.exit(1);
  }
  console.log(`All ${files.length} locales in parity with ${SOURCE}.json.`);
} else {
  console.log(
    drifted.length
      ? `Synced ${drifted.length} locale(s): ${drifted.join(", ")}`
      : `Already in parity — no changes.`,
  );
}
