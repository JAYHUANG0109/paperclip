// Turn a SINGLE hand-picked south-facing sprite into the 8-direction set the
// Virtual Office needs, and wire it into the catalog.
//
// Use this after you've made a character you like in PixelLab's web tools
// (e.g. "Create from style" / Creator) and downloaded ONE south-facing PNG.
// This script calls PixelLab's /v1/rotate to produce the other 7 directions,
// saves them to ui/public/assets/office-characters/<id>/, and updates manifest.json
// so the picker + floor show it immediately.
//
// Usage:
//   PIXELLAB_API_KEY=... node scripts/rotate-office-character.mjs <id> <south.png> [--size 116]
//
// Examples:
//   PIXELLAB_API_KEY=... node scripts/rotate-office-character.mjs female ~/Downloads/woman.png --size 116
//   PIXELLAB_API_KEY=... node scripts/rotate-office-character.mjs male   ~/Downloads/man.png   --size 116
//
// Resumable: skips any direction PNG that already exists.
import { writeFile, mkdir, readFile, access, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "ui/public/assets/office-characters");
const PUBLIC_BASE = "/assets/office-characters";
const API = "https://api.pixellab.ai/v1";
const KEY = process.env.PIXELLAB_API_KEY;

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const positional = args.filter((a, i) => !a.startsWith("--") && (i === 0 || !args[i - 1].startsWith("--")));
const ID = positional[0];
const INPUT = positional[1];
const SIZE = parseInt(opt("--size", "116"), 10);

if (!KEY) { console.error("✗ PIXELLAB_API_KEY not set"); process.exit(1); }
if (!ID || !INPUT) { console.error("Usage: node scripts/rotate-office-character.mjs <id> <south.png> [--size 116]"); process.exit(1); }
if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(ID)) { console.error("✗ id must be a lowercase slug (e.g. female, male, cat)"); process.exit(1); }
if (!existsSync(INPUT)) { console.error(`✗ input not found: ${INPUT}`); process.exit(1); }

const DIRECTIONS = ["south-east", "east", "north-east", "north", "north-west", "west", "south-west"];
const fileExists = (p) => access(p).then(() => true).catch(() => false);

async function rotate(fromBase64, toDirection) {
  const res = await fetch(`${API}/rotate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      image_size: { width: SIZE, height: SIZE },
      from_image: { type: "base64", base64: fromBase64 },
      from_direction: "south",
      to_direction: toDirection,
      from_view: "low top-down",
      to_view: "low top-down",
      image_guidance_scale: 4,
    }),
  });
  if (!res.ok) throw new Error(`rotate→${toDirection} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).image.base64;
}

// ── Main ────────────────────────────────────────────────────────────────────
const dir = path.join(OUT_DIR, ID);
await mkdir(dir, { recursive: true });

const manifestPath = path.join(OUT_DIR, "manifest.json");
let manifest = {};
if (existsSync(manifestPath)) { try { manifest = JSON.parse(await readFile(manifestPath, "utf8")); } catch {} }
const entry = manifest[ID] || (manifest[ID] = { name: ID });

// Save the provided image as south.png.
const southPath = path.join(dir, "south.png");
await copyFile(INPUT, southPath);
entry.south = `${PUBLIC_BASE}/${ID}/south.png`;
const southB64 = (await readFile(southPath)).toString("base64");
console.log(`· south ✓ (from ${INPUT})`);

let spent = 0, failed = 0;
for (const d of DIRECTIONS) {
  const p = path.join(dir, `${d}.png`);
  if (await fileExists(p)) { entry[d] = `${PUBLIC_BASE}/${ID}/${d}.png`; console.log(`  ${d} — skip (exists)`); continue; }
  try {
    const b64 = await rotate(southB64, d);
    await writeFile(p, Buffer.from(b64, "base64"));
    entry[d] = `${PUBLIC_BASE}/${ID}/${d}.png`;
    spent++;
    console.log(`  ${d} ✓`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${d}: ${err.message}`);
    if (/\b(402|403|429)\b|insufficient|credit|quota|balance/i.test(err.message)) {
      console.log("  ⚠ PixelLab balance/quota exhausted — stopping. Add credits and re-run; it resumes.");
      break;
    }
  }
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
}
await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

console.log(`\nDone "${ID}". rotated=${spent} failed=${failed}. Manifest: ${manifestPath}`);
console.log(`Next: pnpm deploy:live  (to ship the art)`);
