/**
 * Onboarding import — bring a user's existing Claude context into their Paperclip
 * agent so it inherits what they already scoped (less onboarding/training/friction).
 *
 * Routes each exported Claude artifact to the layer that actually uses it:
 *   - CLAUDE.md / custom instructions  (harness-a: behavior)  -> agent AGENTS.md block
 *   - prompts / commands / workflows   (harness-b: procedures)-> skill candidates (staged)
 *   - memory / personal notes          (private knowledge)    -> wiki raw (personal namespace)
 *   - projects / docs / knowledge      (shared knowledge)     -> wiki raw (shared namespace)
 *   - skills/<name>/SKILL.md           (existing skills)      -> company-skills import (staged)
 *   - conversation exports             (latent knowledge)     -> wiki raw -> distill
 *
 * SAFETY (same model as the backfill scripts):
 *   - DRY-RUN by default: prints a full routing manifest, writes nothing.
 *   - --apply writes ONLY the low-risk KNOWLEDGE artifacts (into the wiki raw folder,
 *     additive + idempotent). It NEVER changes agent behavior on its own.
 *   - Behavior-changing artifacts (AGENTS.md instructions, skills) are STAGED for review:
 *       * CLAUDE.md -> a `.claude-import.proposed.md` review file next to AGENTS.md.
 *       * skills    -> listed with the command to import them via the existing skill flow.
 *     The agent's real AGENTS.md is patched ONLY with the extra --apply-instructions gate,
 *     and then only inside a delimited, idempotently-replaced block.
 *   - Idempotent: raw copies skip identical existing files; the AGENTS.md block is replaced in place.
 *
 * Usage:
 *   tsx scripts/import-claude-context.ts --input <dir> --user <email>     # dry-run
 *   tsx scripts/import-claude-context.ts --input <dir> --agent <agentId>  # dry-run
 *   tsx scripts/import-claude-context.ts --input <dir> --user <email> --apply
 *   tsx scripts/import-claude-context.ts --input <dir> --user <email> --apply --apply-instructions
 *   optional: --wiki-space <slug> (default: default)  --shared (route ambiguous knowledge to shared, not personal)
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { agents, and, createDb, eq, pluginCompanySettings } from "../packages/db/src/index.js";
import { loadConfig } from "../server/src/config.js";

const APPLY = process.argv.includes("--apply");
const APPLY_INSTRUCTIONS = process.argv.includes("--apply-instructions");
const SHARED_DEFAULT = process.argv.includes("--shared");
const BLOCK_BEGIN = "<!-- BEGIN claude-import (managed; re-runnable) -->";
const BLOCK_END = "<!-- END claude-import -->";

function flag(name: string): string | null {
  const i = process.argv.indexOf(name);
  if (i < 0) return null;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : null;
}

type Tier = "shared" | "private";
type Risk = "knowledge" | "behavior";
type Action = "apply" | "stage" | "manual";
interface Routed { file: string; rel: string; dest: string; tier: Tier; risk: Risk; action: Action; note?: string }

function classify(rel: string): Omit<Routed, "file" | "rel"> | null {
  const lower = rel.toLowerCase();
  const base = path.basename(lower);
  if (base === "claude.md" || lower.endsWith("/claude.md")) {
    return { dest: "agent AGENTS.md (delimited block)", tier: "private", risk: "behavior", action: APPLY_INSTRUCTIONS ? "apply" : "stage", note: "operating profile (harness-a)" };
  }
  if (base === "skill.md") {
    return { dest: "company skills (existing import flow)", tier: "shared", risk: "behavior", action: "manual", note: "run skills import; then equip to the agent" };
  }
  if (/^(commands|prompts|workflows)\//.test(lower) || lower.endsWith(".prompt.md")) {
    return { dest: "skill candidate (draft a SKILL.md)", tier: "private", risk: "behavior", action: "stage", note: "reusable workflow (harness-b)" };
  }
  if (/^(memory|memories|notes)\//.test(lower)) {
    return { dest: "wiki raw (personal namespace) -> distill", tier: "private", risk: "knowledge", action: "apply", note: "private memory" };
  }
  if (/^(projects|docs|knowledge|reference)\//.test(lower)) {
    return { dest: "wiki raw (shared namespace) -> distill", tier: "shared", risk: "knowledge", action: "apply" };
  }
  if (/^(conversations|chats|transcripts)\//.test(lower) || lower.endsWith(".conversation.json")) {
    return { dest: "wiki raw -> distill into pages", tier: SHARED_DEFAULT ? "shared" : "private", risk: "knowledge", action: "apply", note: "conversation export" };
  }
  if (lower.endsWith(".md") || lower.endsWith(".txt") || lower.endsWith(".pdf")) {
    return { dest: `wiki raw (${SHARED_DEFAULT ? "shared" : "personal"} namespace) -> distill`, tier: SHARED_DEFAULT ? "shared" : "private", risk: "knowledge", action: "apply", note: "generic knowledge" };
  }
  return null; // unknown / skip (e.g. images, binaries) — reported as skipped
}

function walk(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") && entry.name !== ".claude") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  return out;
}

function writeIfChanged(target: string, contents: Buffer | string): "written" | "skipped" {
  const buf = Buffer.isBuffer(contents) ? contents : Buffer.from(contents, "utf8");
  if (fs.existsSync(target)) {
    const existing = fs.readFileSync(target);
    if (existing.equals(buf)) return "skipped";
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, buf);
  return "written";
}

async function main() {
  const inputDir = flag("--input");
  if (!inputDir || !fs.existsSync(inputDir) || !fs.statSync(inputDir).isDirectory()) {
    console.error("--input <dir> is required and must be an existing directory (a user's exported Claude artifacts).");
    process.exit(1);
  }
  const agentId = flag("--agent");
  const userEmail = flag("--user");
  const spaceSlug = flag("--wiki-space") ?? "default";
  if (!agentId && !userEmail) {
    console.error("Provide --agent <id> or --user <email> to target the destination agent.");
    process.exit(1);
  }

  const config = loadConfig();
  const dbUrl = process.env.DATABASE_URL?.trim() || config.databaseUrl
    || `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`;
  const db = createDb(dbUrl);

  // resolve target agent (by id, else by assignedUserEmail in adapter_config)
  const allAgents = await db.select({ id: agents.id, companyId: agents.companyId, name: agents.name, adapterConfig: agents.adapterConfig }).from(agents);
  const agent = agentId
    ? allAgents.find((a) => a.id === agentId)
    : allAgents.find((a) => String((a.adapterConfig as Record<string, unknown>)?.assignedUserEmail ?? "").toLowerCase() === userEmail!.toLowerCase());
  if (!agent) {
    console.error(`No agent found for ${agentId ?? userEmail}. (Match by --agent id, or by adapter_config.assignedUserEmail for --user.)`);
    process.exit(1);
  }
  const cfg = agent.adapterConfig as Record<string, unknown>;
  const instructionsFilePath = typeof cfg.instructionsFilePath === "string" ? cfg.instructionsFilePath : null;
  const userLabel = (userEmail ?? String(cfg.assignedUserEmail ?? agent.id)).replace(/[^a-zA-Z0-9._-]+/g, "-").toLowerCase();

  // resolve wiki root for the agent's company
  const settingsRows = await db.select().from(pluginCompanySettings).where(eq(pluginCompanySettings.companyId, agent.companyId));
  let wikiRoot: string | null = null;
  for (const r of settingsRows) {
    const lf = (r.settingsJson as Record<string, unknown> | undefined)?.localFolders as Record<string, { path?: string }> | undefined;
    const p = lf?.["wiki-root"]?.path;
    if (typeof p === "string" && p.trim()) { wikiRoot = p.trim(); break; }
  }

  console.log(`${APPLY ? "APPLYING" : "DRY-RUN"} Claude → Paperclip import`);
  console.log(`  agent:        ${agent.name} (${agent.id})`);
  console.log(`  AGENTS.md:    ${instructionsFilePath ?? "(none configured)"}`);
  console.log(`  wiki root:    ${wikiRoot ?? "(not configured — knowledge writes will be skipped)"}`);
  console.log(`  input:        ${inputDir}`);
  console.log(`  instructions apply gate: ${APPLY_INSTRUCTIONS ? "ON (will patch AGENTS.md)" : "off (staged to review file)"}\n`);

  const files = walk(inputDir);
  const routed: Routed[] = [];
  const skipped: string[] = [];
  for (const f of files) {
    const rel = path.relative(inputDir, f).split(path.sep).join("/");
    const c = classify(rel);
    if (!c) { skipped.push(rel); continue; }
    routed.push({ file: f, rel, ...c });
  }

  // manifest
  const groups: Record<string, Routed[]> = {};
  for (const r of routed) (groups[r.dest] ??= []).push(r);
  console.log("=== routing manifest ===");
  for (const [dest, items] of Object.entries(groups)) {
    const sample = items[0]!;
    console.log(`\n[${sample.tier}/${sample.risk}/${sample.action}] → ${dest}  (${items.length} file${items.length === 1 ? "" : "s"})`);
    for (const it of items.slice(0, 8)) console.log(`    ${it.rel}${it.note ? `   — ${it.note}` : ""}`);
    if (items.length > 8) console.log(`    …and ${items.length - 8} more`);
  }
  if (skipped.length) console.log(`\nskipped (unrecognized): ${skipped.length} file(s)`);

  if (!APPLY) {
    console.log("\nDry-run only. Re-run with --apply to write KNOWLEDGE into the wiki (safe, additive);");
    console.log("add --apply-instructions to also patch the agent's AGENTS.md (behavior-changing).");
    await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
    return;
  }

  // --- APPLY ---
  let wrote = 0, skippedWrite = 0, staged = 0, manual = 0;

  // 1) knowledge → wiki raw (additive, idempotent)
  if (wikiRoot) {
    for (const r of routed.filter((x) => x.risk === "knowledge" && x.action === "apply")) {
      const nsBase = r.tier === "personal" || r.tier === "private" ? `spaces/personal-${userLabel}` : `spaces/${spaceSlug}`;
      // shared default space stores under wiki/ root; namespaced import goes under raw/claude-import/<user>/
      const target = path.join(wikiRoot, nsBase === `spaces/${spaceSlug}` && spaceSlug === "default" ? "" : nsBase, "raw", "claude-import", userLabel, r.rel);
      const res = writeIfChanged(target, fs.readFileSync(r.file));
      res === "written" ? wrote++ : skippedWrite++;
    }
  } else {
    console.log("\n⚠️  wiki root not configured — skipped all knowledge writes.");
  }

  // 2) CLAUDE.md → proposed AGENTS.md block (staged), or patched with --apply-instructions
  const claudeMds = routed.filter((x) => x.dest.startsWith("agent AGENTS.md"));
  if (claudeMds.length && instructionsFilePath) {
    const merged = claudeMds.map((r) => `\n<!-- source: ${r.rel} -->\n${fs.readFileSync(r.file, "utf8").trim()}\n`).join("\n");
    const block = `${BLOCK_BEGIN}\n## 從 Claude 匯入的個人設定（operating profile）\n${merged}\n${BLOCK_END}`;
    const instrDir = path.dirname(instructionsFilePath);
    if (APPLY_INSTRUCTIONS) {
      let doc = fs.existsSync(instructionsFilePath) ? fs.readFileSync(instructionsFilePath, "utf8") : "";
      const re = new RegExp(`${BLOCK_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${BLOCK_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
      doc = re.test(doc) ? doc.replace(re, block) : `${doc.trimEnd()}\n\n${block}\n`;
      writeIfChanged(instructionsFilePath, doc);
      console.log(`\n✓ patched AGENTS.md with the imported operating profile (delimited block, re-runnable).`);
      wrote++;
    } else {
      const proposed = path.join(instrDir, ".claude-import.proposed.md");
      writeIfChanged(proposed, block + "\n");
      console.log(`\n○ staged operating profile for review → ${proposed}\n   (review, then re-run with --apply-instructions to patch AGENTS.md)`);
      staged++;
    }
  }

  // 3) skills → point to the existing import flow (never auto-imported here)
  const skills = routed.filter((x) => x.dest.startsWith("company skills"));
  const workflows = routed.filter((x) => x.dest.startsWith("skill candidate"));
  if (skills.length || workflows.length) {
    console.log(`\n○ ${skills.length} skill(s) + ${workflows.length} workflow(s) detected — NOT auto-imported (behavior-changing).`);
    console.log(`   Import skills via the existing company-skills import, then equip them to the agent.`);
    manual += skills.length; staged += workflows.length;
  }

  console.log(`\nApplied: ${wrote} written, ${skippedWrite} unchanged, ${staged} staged, ${manual} manual. Knowledge landed under <wikiRoot>/…/raw/claude-import/${userLabel}/ — run wiki distillation to turn it into pages.`);
  await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
}

void main().then(() => process.exit(0)).catch((e) => {
  console.error(`claude-context import failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
