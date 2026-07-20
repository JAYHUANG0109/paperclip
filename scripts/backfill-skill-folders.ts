/**
 * Consolidation Phase D — backfill the unified `folders` table from the fork's
 * legacy skill-folder model, so the nested tree rail shows the existing folders.
 *
 * SAFE BY DESIGN:
 *   - DRY-RUN by default. Prints exactly what it WOULD create/update. Pass
 *     `--apply` to actually write.
 *   - NON-DESTRUCTIVE: never deletes `company_skill_folders` rows and never
 *     touches a skill's `categories`. Only CREATES `folders` rows and SETS
 *     `folderId` where it is currently null. Fully reversible (null the
 *     folderIds + delete the created folders; categories are untouched).
 *   - IDEMPOTENT: skips folders that already exist (by company+kind+slug) and
 *     skips skills that already have a folderId. Safe to re-run.
 *
 * What it does, per company:
 *   1. Collects folder names from BOTH the legacy `company_skill_folders`
 *      registry (carrying scope/sharing) AND the distinct `categories` strings
 *      on skills (the founder's numbered folders live only as categories).
 *   2. Creates a real `folders` row (kind=skill) for each name that doesn't yet
 *      exist — carrying scope/sharing from the registry when present, else the
 *      default "company" scope (numbered folders stay founder-only via the
 *      server-side name restriction regardless of scope).
 *   3. Files each skill that has categories but no folderId into ONE folder:
 *      prefers a numbered (founder-taxonomy) category, else the first category
 *      that maps to a folder. (folderId is single-valued; categories stay as-is
 *      so multi-category membership is not lost at the data layer.)
 *
 * Usage:
 *   pnpm tsx scripts/backfill-skill-folders.ts               # dry-run, all companies
 *   pnpm tsx scripts/backfill-skill-folders.ts --company ID  # dry-run, one company
 *   pnpm tsx scripts/backfill-skill-folders.ts --apply       # write changes
 */
import { and, eq, isNull } from "drizzle-orm";
import { companies, companySkillFolders, companySkills, createDb, folders } from "../packages/db/src/index.js";
import { loadConfig } from "../server/src/config.js";
import { normalizeFolderSlug } from "../server/src/services/folders.js";

const APPLY = process.argv.includes("--apply");

function parseFlag(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

function isRestrictedFolderName(name: string): boolean {
  return /^\s*\d{2}[\s-]/.test(name);
}

async function main() {
  const config = loadConfig();
  const dbUrl =
    process.env.DATABASE_URL?.trim()
    || config.databaseUrl
    || `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`;
  const db = createDb(dbUrl);

  const only = parseFlag("--company");
  const companyRows = only
    ? [{ id: only }]
    : await db.select({ id: companies.id }).from(companies);

  console.log(`${APPLY ? "APPLYING" : "DRY-RUN"} skill-folder backfill for ${companyRows.length} compan${companyRows.length === 1 ? "y" : "ies"}\n`);

  let totalFoldersCreated = 0;
  let totalSkillsFiled = 0;

  for (const company of companyRows) {
    const companyId = company.id;
    const [legacy, skills, existing] = await Promise.all([
      db.select().from(companySkillFolders).where(eq(companySkillFolders.companyId, companyId)),
      db.select({ id: companySkills.id, categories: companySkills.categories, folderId: companySkills.folderId })
        .from(companySkills).where(eq(companySkills.companyId, companyId)),
      db.select({ id: folders.id, name: folders.name, slug: folders.slug })
        .from(folders).where(and(eq(folders.companyId, companyId), eq(folders.kind, "skill"))),
    ]);

    const byName = new Map<string, { id: string; name: string; slug: string }>();
    const usedSlugs = new Set<string>();
    for (const f of existing) { byName.set(f.name, f); usedSlugs.add(f.slug); }

    const legacyByName = new Map(legacy.map((f) => [f.name, f]));
    const categoryNames = new Set<string>();
    for (const s of skills) for (const c of s.categories ?? []) if (c?.trim()) categoryNames.add(c.trim());
    const allNames = new Set<string>([...legacyByName.keys(), ...categoryNames]);

    const created: string[] = [];
    for (const name of allNames) {
      if (byName.has(name)) continue; // already a real folder
      let slug = normalizeFolderSlug(name) || "folder";
      let n = 2;
      while (usedSlugs.has(slug)) slug = `${normalizeFolderSlug(name) || "folder"}-${n++}`;
      usedSlugs.add(slug);
      const lf = legacyByName.get(name);
      const scope = (lf?.scope as "company" | "team" | "private" | undefined) ?? "company";
      const row = {
        companyId,
        kind: "skill" as const,
        parentId: null,
        name,
        slug,
        color: null,
        position: 0,
        scope,
        sharingTeams: scope === "team" ? (lf?.sharingTeams ?? []) : [],
        sharedUserIds: scope === "private" ? (lf?.sharedUserIds ?? []) : [],
        createdByUserId: lf?.createdByUserId ?? null,
      };
      let id = `(dry-run:${slug})`;
      if (APPLY) {
        id = await db.insert(folders).values(row).returning({ id: folders.id }).then((r) => r[0]!.id);
      }
      byName.set(name, { id, name, slug });
      created.push(`${name} [${scope}]`);
    }

    // File skills that have categories but no folderId (idempotent).
    let filed = 0;
    for (const s of skills) {
      if (s.folderId) continue;
      const cats = (s.categories ?? []).map((c) => c.trim()).filter(Boolean);
      if (cats.length === 0) continue;
      // Prefer the founder numbered folder, else the first category with a folder.
      const targetName = cats.find((c) => isRestrictedFolderName(c) && byName.has(c)) ?? cats.find((c) => byName.has(c));
      if (!targetName) continue;
      const folder = byName.get(targetName)!;
      if (APPLY) {
        await db.update(companySkills)
          .set({ folderId: folder.id })
          .where(and(eq(companySkills.id, s.id), isNull(companySkills.folderId)));
      }
      filed++;
    }

    if (created.length || filed) {
      console.log(`company ${companyId}: +${created.length} folders, ${filed} skills filed`);
      for (const c of created) console.log(`    folder: ${c}`);
    }
    totalFoldersCreated += created.length;
    totalSkillsFiled += filed;
  }

  console.log(`\n${APPLY ? "Applied" : "Would create"}: ${totalFoldersCreated} folders, ${totalSkillsFiled} skills filed.`);
  if (!APPLY) console.log("Re-run with --apply to write these changes.");
}

void main().catch((error) => {
  console.error(`skill-folder backfill failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
