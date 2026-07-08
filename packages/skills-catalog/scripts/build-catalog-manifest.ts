import { fileURLToPath } from "node:url";
import path from "node:path";
import { writeCatalogManifest } from "../src/catalog-builder.js";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const result = await writeCatalogManifest(packageDir);

// A build must not fail on TRANSIENT external fetch errors (GitHub rate-limiting
// pinned-file/tree fetches for externally-referenced catalog skills — HTTP
// 429/403/400/408/409/425/5xx, or a bare network error). On such errors
// writeCatalogManifest returns WITHOUT overwriting generated/catalog.json, so the
// committed (last-good) manifest stays in place — safe to proceed. Only genuine,
// non-recoverable errors (stale/invalid manifest, missing SKILL.md, uniqueness)
// should fail the build/deploy.
function isTransientFetchError(error: string): boolean {
  if (!/failed to fetch (pinned GitHub file|GitHub tree)/.test(error)) return false;
  const m = /HTTP (\d+)/.exec(error);
  if (!m) return true; // network error without a status → transient
  const s = Number(m[1]);
  return s === 400 || s === 403 || s === 408 || s === 409 || s === 425 || s === 429 || s >= 500;
}

if (result.errors.length > 0) {
  const allTransient = result.errors.every(isTransientFetchError);
  if (allTransient) {
    console.warn(
      "skills-catalog: transient GitHub fetch error(s) — keeping the committed generated/catalog.json and continuing:",
    );
    for (const error of result.errors) console.warn(`  - ${error}`);
    // exitCode stays 0
  } else {
    for (const error of result.errors) console.error(`- ${error}`);
    process.exitCode = 1;
  }
} else {
  console.log(`Wrote generated/catalog.json with ${result.manifest.skills.length} catalog skills.`);
}
