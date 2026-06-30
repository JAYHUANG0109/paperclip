// Generate pixel-art character sprites for agents via the PixelLab API.
//
// Reads agents straight from the embedded Postgres, builds a role-aware prompt
// per agent, generates a front ("south") sprite (and, with --rotate, the other
// 7 directions), saves PNGs under ui/public/assets/agent-sprites/<agentId>/, and
// writes a manifest.json the Virtual Office reads.
//
// Resumable: skips any direction whose PNG already exists, so re-running only
// fills gaps and never re-spends credits.
//
// Usage:
//   PIXELLAB_API_KEY=... node scripts/generate-agent-sprites.mjs            # south only
//   PIXELLAB_API_KEY=... node scripts/generate-agent-sprites.mjs --rotate   # full 8 directions
//   ... --company <uuid>   --limit <n>   --size 64
import { writeFile, mkdir, readFile, access } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "/Users/jayhuang/dev/paperclip/paperclip/node_modules/.pnpm/postgres@3.4.9/node_modules/postgres/src/index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "ui/public/assets/agent-sprites");
const PUBLIC_BASE = "/assets/agent-sprites";
const API = "https://api.pixellab.ai/v1";
const KEY = process.env.PIXELLAB_API_KEY;
const DB = process.env.DATABASE_URL || "postgres://paperclip:paperclip@127.0.0.1:54329/paperclip";

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const DO_ROTATE = flag("--rotate");
const SIZE = parseInt(opt("--size", "64"), 10);
const LIMIT = opt("--limit", null);
const COMPANY = opt("--company", null);

const DIRECTIONS = ["south", "south-east", "east", "north-east", "north", "north-west", "west", "south-west"];

if (!KEY) { console.error("✗ PIXELLAB_API_KEY not set"); process.exit(1); }

// ── Prompt building ─────────────────────────────────────────────────────────
function inferGender(agent) {
  const m = agent.metadata && typeof agent.metadata === "object" ? agent.metadata : {};
  const g = String(m.gender ?? m.sex ?? "").toLowerCase();
  if (g.startsWith("f") || g === "female" || g === "woman") return "woman";
  if (g.startsWith("m") || g === "male" || g === "man") return "man";
  return "person";
}

function attireFor(text) {
  const t = (text || "").toLowerCase();
  const has = (...ks) => ks.some((k) => t.includes(k));
  if (has("創辦人", "founder", "ceo", "coo", "cmo", "cfo", "總部", "副總", "總長", "總監", "chief", "executive", "圍長", "園長"))
    return "wearing a formal business suit, confident executive";
  if (has("工程", "技術", "資訊", "硬體", "軟體", "engineer", "developer", "system", "it ", "dev"))
    return "wearing a casual shirt and glasses, software engineer";
  if (has("教學", "老師", "教師", "teacher", "教育", "教務", "班群", "巡輔"))
    return "wearing smart casual clothes, friendly teacher";
  if (has("行銷", "marketing", "市場"))
    return "wearing trendy casual clothes, marketing professional";
  if (has("人才", "人資", "hr", "招募"))
    return "wearing smart casual clothes, HR professional";
  if (has("設計", "design", "ux", "ui", "美"))
    return "wearing creative casual clothes, designer";
  if (has("活動", "行政", "助理", "assistant", "admin", "顧問"))
    return "wearing neat office clothes, office administrator";
  return "wearing business casual office clothes";
}

function buildPrompt(agent) {
  const gender = inferGender(agent);
  const attire = attireFor(`${agent.role ?? ""} ${agent.title ?? ""} ${agent.name ?? ""}`);
  return `cute pixel art character, a ${gender} office worker, ${attire}, full body, standing, facing forward, clean simple flat colors, retro game sprite`;
}

// ── PixelLab calls ──────────────────────────────────────────────────────────
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
const sql = postgres(DB, { max: 1, onnotice: () => {} });

const rows = await sql`
  select id, name, role, title, metadata, status
  from agents
  where status <> 'terminated'
  ${COMPANY ? sql`and company_id = ${COMPANY}` : sql``}
  order by created_at asc
  ${LIMIT ? sql`limit ${parseInt(LIMIT, 10)}` : sql``}
`;
console.log(`Found ${rows.length} agents. Mode: ${DO_ROTATE ? "8-direction" : "south-only"}, size ${SIZE}px.`);

await mkdir(OUT_DIR, { recursive: true });
const manifestPath = path.join(OUT_DIR, "manifest.json");
let manifest = {};
if (existsSync(manifestPath)) { try { manifest = JSON.parse(await readFile(manifestPath, "utf8")); } catch {} }

let spent = 0, made = 0, skipped = 0, failed = 0;
for (const agent of rows) {
  const dir = path.join(OUT_DIR, agent.id);
  await mkdir(dir, { recursive: true });
  const entry = manifest[agent.id] || (manifest[agent.id] = { name: agent.name });
  entry.name = agent.name;

  const southPath = path.join(dir, "south.png");
  let southB64 = null;
  try {
    if (await fileExists(southPath)) {
      skipped++;
      entry.south = `${PUBLIC_BASE}/${agent.id}/south.png`;
      if (DO_ROTATE) southB64 = (await readFile(southPath)).toString("base64");
    } else {
      const prompt = buildPrompt(agent);
      process.stdout.write(`· ${agent.name} … `);
      southB64 = await pixflux(prompt);
      await writeFile(southPath, Buffer.from(southB64, "base64"));
      entry.south = `${PUBLIC_BASE}/${agent.id}/south.png`;
      made++; spent++;
      console.log("south ✓");
    }

    if (DO_ROTATE && southB64) {
      for (const d of DIRECTIONS.slice(1)) {
        const p = path.join(dir, `${d}.png`);
        if (await fileExists(p)) { entry[d] = `${PUBLIC_BASE}/${agent.id}/${d}.png`; continue; }
        const b64 = await rotate(southB64, d);
        await writeFile(p, Buffer.from(b64, "base64"));
        entry[d] = `${PUBLIC_BASE}/${agent.id}/${d}.png`;
        spent++;
        process.stdout.write(`${d} ✓ `);
      }
      console.log("");
    }
  } catch (err) {
    failed++;
    console.log(`\n  ✗ ${agent.name}: ${err.message}`);
  }
  // Persist manifest after each agent so a crash never loses progress.
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
}

await sql.end();
console.log(`\nDone. generated=${made} skipped=${skipped} failed=${failed} apiCalls=${spent}`);
console.log(`Manifest: ${manifestPath}`);
