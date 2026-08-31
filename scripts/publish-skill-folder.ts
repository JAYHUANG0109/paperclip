/**
 * Publish a repo skill folder into its Paperclip company skill.
 *
 * Agents do NOT have this repo. What they get is the company skill's files
 * (`company_skill_files`), materialized into the instance's skill directory —
 * so a reference file that only exists under `skills/…` in git is invisible to
 * every agent that needs it. This copies the folder in.
 *
 * Upsert by path: existing files are updated in place (so the skill keeps its
 * id, versions, sharing and equip state), new ones are inserted. Files removed
 * from the folder are reported, never deleted — a whole-list replace is how a
 * skill sync silently wiped a company's skills before.
 *
 *   tsx scripts/publish-skill-folder.ts --folder skills/sa-agent-onboarding --key sa-agent-onboarding
 *   tsx scripts/publish-skill-folder.ts --folder skills/sa-agent-onboarding --key sa-agent-onboarding --apply
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createDb, sql } from "../packages/db/src/index.js";
import { loadConfig } from "../server/src/config.js";

const APPLY = process.argv.includes("--apply");
const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

/** Matches the kinds already in use: SKILL.md is the skill, references/ are references. */
function kindFor(rel: string): string {
  if (rel === "SKILL.md") return "skill";
  if (rel.startsWith("references/")) return "reference";
  if (rel.endsWith(".md")) return "markdown";
  if (rel.endsWith(".sh") || rel.endsWith(".py") || rel.endsWith(".mjs")) return "script";
  return "other";
}

function walk(dir: string, base = dir, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, base, acc);
    else acc.push(path.relative(base, full));
  }
  return acc;
}

async function main() {
  const folder = arg("folder");
  const key = arg("key");
  if (!folder || !key) throw new Error("need --folder <path> --key <skill key suffix>");

  const config = loadConfig();
  const db = createDb(process.env.DATABASE_URL?.trim() || config.databaseUrl
    || `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`);

  const skills = (await db.execute(sql`
    select id, company_id, key from company_skills where key like ${"%" + key}
  `)) as unknown as Array<{ id: string; company_id: string; key: string }>;
  if (skills.length !== 1) {
    throw new Error(`expected exactly one skill matching "${key}", found ${skills.length}: ${skills.map((s) => s.key).join(", ")}`);
  }
  const skill = skills[0]!;
  console.log(`skill ${skill.key} (${skill.id})\n`);

  const existing = (await db.execute(sql`
    select path, sha256 from company_skill_files where skill_id = ${skill.id}::uuid
  `)) as unknown as Array<{ path: string; sha256: string | null }>;
  const bySha = new Map(existing.map((e) => [e.path, e.sha256]));

  const files = walk(folder).sort();
  let added = 0;
  let updated = 0;
  let same = 0;
  for (const rel of files) {
    const content = readFileSync(path.join(folder, rel), "utf8");
    const sha = createHash("sha256").update(content).digest("hex");
    const bytes = Buffer.byteLength(content, "utf8");
    const kind = kindFor(rel);

    if (!bySha.has(rel)) {
      added += 1;
      console.log(`  + ${rel} (${kind}, ${bytes}B)`);
    } else if (bySha.get(rel) !== sha) {
      updated += 1;
      console.log(`  ~ ${rel} (${kind}, ${bytes}B)`);
    } else {
      same += 1;
      continue;
    }
    if (!APPLY) continue;

    await db.execute(sql`
      insert into company_skill_files (company_id, skill_id, path, kind, content, is_binary, byte_size, sha256)
      values (${skill.company_id}::uuid, ${skill.id}::uuid, ${rel}, ${kind}, ${content}, false, ${bytes}, ${sha})
      on conflict (skill_id, path) do update
        set content = excluded.content,
            kind = excluded.kind,
            byte_size = excluded.byte_size,
            sha256 = excluded.sha256,
            updated_at = now()
    `);
  }

  // The skill row carries its own copies of two things: `markdown` (the SKILL.md
  // body the catalog serves) and `file_inventory` (the path list). Writing only
  // company_skill_files leaves both stale, so the new references are invisible
  // to anything reading the skill rather than its file rows.
  if (APPLY) {
    const skillMd = files.includes("SKILL.md")
      ? readFileSync(path.join(folder, "SKILL.md"), "utf8")
      : null;
    const inventory = JSON.stringify(files.map((rel) => ({ path: rel, kind: kindFor(rel) })));
    await db.execute(sql`
      update company_skills
         set markdown = coalesce(${skillMd}, markdown),
             file_inventory = ${inventory}::jsonb,
             updated_at = now()
       where id = ${skill.id}::uuid
    `);
    console.log(`  = skill row: markdown + file_inventory (${files.length} paths)`);
  }

  const orphans = existing.filter((e) => !files.includes(e.path)).map((e) => e.path);
  console.log(`\n${APPLY ? "published" : "would publish"}: ${added} added, ${updated} updated, ${same} unchanged`);
  if (orphans.length) {
    console.log(`\nin the skill but not in the folder (left alone — delete by hand if intended):`);
    for (const o of orphans) console.log(`  ! ${o}`);
  }
  if (!APPLY) console.log("\npass --apply to write");
  process.exit(0);
}

void main().catch((e) => { console.error(e); process.exit(1); });
