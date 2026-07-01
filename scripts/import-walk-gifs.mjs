// Install per-direction WALK animation GIFs for a Virtual Office catalog character.
//
// The office plays these GIFs while an agent is moving (and shows the static
// rotation when idle). Point this at a folder that contains 8 GIFs — one per
// direction. Filenames just need to CONTAIN the direction (e.g. "south.gif",
// "walk_south.gif", "a_woman…-south-east.gif"); it searches recursively.
//
// Copies them to ui/public/assets/office-characters/<id>/walk/<dir>.gif and adds
// a `walk` map to that character's entry in manifest.json.
//
// Usage:
//   node scripts/import-walk-gifs.mjs <id> <folder-with-gifs>
//   e.g. node scripts/import-walk-gifs.mjs female ~/Downloads/woman-walk
import { readdirSync, statSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "ui/public/assets/office-characters");
const PUBLIC_BASE = "/assets/office-characters";

const [ID, SRC] = process.argv.slice(2);
if (!ID || !SRC) { console.error("Usage: node scripts/import-walk-gifs.mjs <id> <folder-with-gifs>"); process.exit(1); }
if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(ID)) { console.error("✗ id must be a lowercase slug"); process.exit(1); }
if (!existsSync(SRC)) { console.error(`✗ folder not found: ${SRC}`); process.exit(1); }

// longest-first so "south-east" matches before "south"
const DIRS = ["south-east", "south-west", "north-east", "north-west", "north", "south", "east", "west"];

function findGifs(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) findGifs(p, acc);
    else if (e.name.toLowerCase().endsWith(".gif")) acc.push(p);
  }
  return acc;
}

const gifs = findGifs(SRC);
if (!gifs.length) { console.error(`✗ no .gif files found under ${SRC}`); process.exit(1); }

const dir = path.join(OUT_DIR, ID, "walk");
mkdirSync(dir, { recursive: true });

const manifestPath = path.join(OUT_DIR, "manifest.json");
let manifest = {};
if (existsSync(manifestPath)) { try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")); } catch {} }
const entry = manifest[ID] || (manifest[ID] = { name: ID });
entry.walk = entry.walk || {};

const used = new Set();
let n = 0;
for (const d of DIRS) {
  // match a gif whose basename contains this direction and hasn't been claimed
  const hit = gifs.find((g) => !used.has(g) && path.basename(g).toLowerCase().includes(d));
  if (!hit) { console.log(`  ${d} — no gif matched, skip`); continue; }
  used.add(hit);
  copyFileSync(hit, path.join(dir, `${d}.gif`));
  entry.walk[d] = `${PUBLIC_BASE}/${ID}/walk/${d}.gif`;
  n++;
  console.log(`  ${d} ← ${path.basename(hit)}`);
}
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

console.log(`\n✓ Imported ${n}/8 walk gifs for "${ID}".`);
console.log(`  Then: bump ART_VERSION in ui/src/lib/office-sprite-catalog.ts + deploy.`);
