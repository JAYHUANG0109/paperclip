// Generate the shared Virtual Office CHARACTER CATALOG via the PixelLab API.
//
// Unlike generate-agent-sprites.mjs (one bespoke set per AGENT, keyed by agent id),
// this builds the FIXED, reusable roster users pick from: two default people
// (male/female) plus animals. Output goes to ui/public/assets/office-characters/
// <id>/<direction>.png with a manifest.json the picker + floor read.
//
// The id list MUST match ui/src/lib/office-sprite-catalog.ts (CATALOG). Keep the
// two in sync — same ids, same prompts.
//
// Resumable: skips any PNG that already exists, so re-runs only fill gaps and
// never re-spend credits.
//
// Usage:
//   PIXELLAB_API_KEY=... node scripts/generate-office-characters.mjs            # south only (1 credit each)
//   PIXELLAB_API_KEY=... node scripts/generate-office-characters.mjs --rotate   # full 8 directions (walkable)
//   ... --only male,female,cat   --size 64
import { writeFile, mkdir, readFile, access } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "ui/public/assets/office-characters");
const PUBLIC_BASE = "/assets/office-characters";
const API = "https://api.pixellab.ai/v1";
const KEY = process.env.PIXELLAB_API_KEY;

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const DO_ROTATE = flag("--rotate");
const SIZE = parseInt(opt("--size", "64"), 10);
const ONLY = (opt("--only", "") || "").split(",").map(s => s.trim()).filter(Boolean);

const DIRECTIONS = ["south", "south-east", "east", "north-east", "north", "north-west", "west", "south-west"];
if (!KEY) { console.error("✗ PIXELLAB_API_KEY not set"); process.exit(1); }

// Shared suffix — matches PROMPT_SUFFIX in office-sprite-catalog.ts + the PixelLab
// "Low Top-Down" office look.
const SUFFIX =
  "full body, standing, facing forward, cute chibi proportions, clean simple flat colors, soft shading, single black outline, retro game sprite";

// id → subject clause. MUST stay in sync with CATALOG in office-sprite-catalog.ts.
const CHARACTERS = {
  male:          "a man office worker with short dark hair, wearing a white button-down shirt with a tie and grey trousers, full body, head to toe, standing",
  female:        "a woman office worker with long dark hair, wearing a white button-down shirt and grey trousers, full body, head to toe, standing",
  cat:           "an anthropomorphic orange tabby cat office worker, wearing a grey business suit, standing on two legs",
  fox:           "an anthropomorphic orange fox office worker, wearing a brown blazer, standing on two legs",
  dog:           "an anthropomorphic golden dog office worker, wearing a blue shirt and tie, standing on two legs",
  bunny:         "an anthropomorphic white bunny office worker, wearing a pink cardigan, standing on two legs",
  bear:          "an anthropomorphic brown bear office worker, wearing a dark suit, standing on two legs",
  panda:         "an anthropomorphic panda office worker, wearing a green vest, standing on two legs",
  hamster:       "an anthropomorphic tan hamster office worker, wearing a yellow sweater, standing on two legs",
  penguin:       "an anthropomorphic penguin office worker, wearing a red bow tie, standing on two legs",
  frog:          "an anthropomorphic green frog office worker, wearing a purple shirt, standing on two legs",
  owl:           "an anthropomorphic brown owl office worker, wearing round glasses and a teal vest, standing on two legs",
  "penguin-chef":"an anthropomorphic penguin wearing a white chef hat and apron, standing on two legs",
  shiba:         "an anthropomorphic shiba inu dog office worker, wearing a beige coat, standing on two legs",
};

const buildPrompt = (subject) => `cute pixel art character, ${subject}, ${SUFFIX}`;

async function pixflux(description) {
  const res = await fetch(`${API}/generate-image-pixflux`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      description,
      image_size: { width: SIZE, height: SIZE },
      no_background: true,
      view: "low top-down",
      direction: "south",
      outline: "single color black outline",
      shading: "basic shading",
      detail: "low detail",
      text_guidance_scale: 8,
    }),
  });
  if (!res.ok) throw new Error(`pixflux ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).image.base64;
}

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

const fileExists = (p) => access(p).then(() => true).catch(() => false);

// ── Main ────────────────────────────────────────────────────────────────────
await mkdir(OUT_DIR, { recursive: true });
const manifestPath = path.join(OUT_DIR, "manifest.json");
let manifest = {};
if (existsSync(manifestPath)) { try { manifest = JSON.parse(await readFile(manifestPath, "utf8")); } catch {} }

const ids = Object.keys(CHARACTERS).filter(id => ONLY.length === 0 || ONLY.includes(id));
console.log(`Generating ${ids.length} catalog characters. Mode: ${DO_ROTATE ? "8-direction" : "south-only"}, size ${SIZE}px.`);

let made = 0, skipped = 0, failed = 0, spent = 0;
for (const id of ids) {
  const dir = path.join(OUT_DIR, id);
  await mkdir(dir, { recursive: true });
  const entry = manifest[id] || (manifest[id] = { name: id });

  const southPath = path.join(dir, "south.png");
  let southB64 = null;
  try {
    if (await fileExists(southPath)) {
      skipped++;
      entry.south = `${PUBLIC_BASE}/${id}/south.png`;
      if (DO_ROTATE) southB64 = (await readFile(southPath)).toString("base64");
    } else {
      process.stdout.write(`· ${id} … `);
      southB64 = await pixflux(buildPrompt(CHARACTERS[id]));
      await writeFile(southPath, Buffer.from(southB64, "base64"));
      entry.south = `${PUBLIC_BASE}/${id}/south.png`;
      made++; spent++;
      console.log("south ✓");
    }

    if (DO_ROTATE && southB64) {
      for (const d of DIRECTIONS.slice(1)) {
        const p = path.join(dir, `${d}.png`);
        if (await fileExists(p)) { entry[d] = `${PUBLIC_BASE}/${id}/${d}.png`; continue; }
        const b64 = await rotate(southB64, d);
        await writeFile(p, Buffer.from(b64, "base64"));
        entry[d] = `${PUBLIC_BASE}/${id}/${d}.png`;
        spent++;
        process.stdout.write(`${d} ✓ `);
      }
      console.log("");
    }
  } catch (err) {
    failed++;
    console.log(`\n  ✗ ${id}: ${err.message}`);
    if (/\b(402|403|429)\b|insufficient|credit|quota|balance/i.test(err.message)) {
      console.log("  ⚠ PixelLab balance/quota exhausted — stopping. Add credits and re-run; it resumes.");
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
      break;
    }
  }
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
}

console.log(`\nDone. generated=${made} skipped=${skipped} failed=${failed} apiCalls=${spent}`);
console.log(`Manifest: ${manifestPath}`);
