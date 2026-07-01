// Install a PixelLab character EXPORT folder as a Virtual Office catalog character.
//
// PixelLab's "Download" gives you a folder like:
//   a_man_office_worker_with/
//     metadata.json
//     a_man_office_worker_with/rotations/{south,south-east,…}.png   (8 directions)
//
// This copies those 8 rotations into ui/public/assets/office-characters/<id>/
// and updates manifest.json, so the picker + floor use it. No PixelLab API/key
// needed — it's a pure local file copy.
//
// Usage:
//   node scripts/import-pixellab-export.mjs <id> <path-to-export-folder>
//
// Examples:
//   node scripts/import-pixellab-export.mjs male   ui/public/office-characters/a_man_office_worker_with
//   node scripts/import-pixellab-export.mjs female ui/public/office-characters/a_woman_office_worker_with
import { mkdir, readFile, writeFile, copyFile, readdir, access } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "ui/public/assets/office-characters");
const PUBLIC_BASE = "/assets/office-characters";
const DIRECTIONS = ["south", "south-east", "east", "north-east", "north", "north-west", "west", "south-west"];

const [ID, EXPORT] = process.argv.slice(2);
if (!ID || !EXPORT) { console.error("Usage: node scripts/import-pixellab-export.mjs <id> <export-folder>"); process.exit(1); }
if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(ID)) { console.error("✗ id must be a lowercase slug (e.g. male, female, cat)"); process.exit(1); }

// Find the rotations dir — PixelLab nests it one level deep (<name>/<name>/rotations).
async function findRotations(base) {
  const direct = path.join(base, "rotations");
  if (existsSync(direct)) return direct;
  for (const e of await readdir(base, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const nested = path.join(base, e.name, "rotations");
    if (existsSync(nested)) return nested;
  }
  return null;
}

const rotDir = await findRotations(EXPORT);
if (!rotDir) { console.error(`✗ no rotations/ folder found under ${EXPORT}`); process.exit(1); }

const dir = path.join(OUT_DIR, ID);
await mkdir(dir, { recursive: true });

const manifestPath = path.join(OUT_DIR, "manifest.json");
let manifest = {};
if (existsSync(manifestPath)) { try { manifest = JSON.parse(await readFile(manifestPath, "utf8")); } catch {} }
const entry = manifest[ID] || (manifest[ID] = { name: ID });

let copied = 0;
for (const d of DIRECTIONS) {
  const src = path.join(rotDir, `${d}.png`);
  if (!(await access(src).then(() => true).catch(() => false))) { console.log(`  ${d} — missing in export, skip`); continue; }
  await copyFile(src, path.join(dir, `${d}.png`));
  entry[d] = `${PUBLIC_BASE}/${ID}/${d}.png`;
  copied++;
}
await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

console.log(`✓ Imported "${ID}" — ${copied}/8 directions → ${dir}`);
console.log(`  Manifest: ${manifestPath}`);
console.log(`  Next: pnpm deploy:live`);
