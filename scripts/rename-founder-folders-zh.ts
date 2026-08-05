/**
 * Rename the founder's numbered skill folders from their English slugs to the
 * Traditional-Chinese names that match the founder's LOCAL "新 Skill" folders,
 * so re-uploading skills organised in those local folders APPENDS into the
 * existing platform folders instead of creating Chinese-named duplicates.
 *
 * The upload auto-filer matches an existing folder by EXACT name
 * (`f.name === segment`, see ui/src/pages/CompanySkills.tsx). Today the platform
 * folders are stored as English slugs ("00-global-rules") while the local
 * folders are Chinese ("00全域規則"), so every upload forks a new folder. Making
 * the stored name equal the local name fixes that.
 *
 * SECURITY — why this also rewrites scope:
 * The reserved founder folders are hidden from non-founders by their NAME
 * (server/src/services/folders.ts `isRestrictedFolderName` = /^\s*\d{2}[\s-]/ —
 * two digits then a space or dash). The Chinese targets are "00全域規則" — two
 * digits then a CJK char — which that pattern does NOT match, so the name gate
 * would stop applying. To keep them locked down we set scope=private +
 * sharedUserIds=[founders] in the SAME update (the durable protection
 * tighten-founder-folders.ts already established). Owners/admins/instance-admins
 * still see them via the platform-wide privileged short-circuit, by design.
 *
 * SAFE: dry-run by default (prints planned changes), --apply to write.
 * Idempotent — a folder already at its Chinese name + private is left alone.
 * Collision-guarded — if a Chinese-named twin already exists it is NOT renamed
 * over (the script warns so the two can be merged by hand first).
 *
 * Usage:
 *   pnpm --filter @paperclipai/server exec tsx ../scripts/rename-founder-folders-zh.ts
 *   pnpm --filter @paperclipai/server exec tsx ../scripts/rename-founder-folders-zh.ts --apply
 */
import { and, authUsers, createDb, eq, folders, inArray } from "../packages/db/src/index.js";
import { loadConfig } from "../server/src/config.js";

const APPLY = process.argv.includes("--apply");
const FOUNDER_EMAILS = ["tang@seasonart.org", "jay20020109@seasonart.org"];

// English slug (current stored name) → Traditional-Chinese target. The targets
// mirror the founder's local "新 Skill" folders EXACTLY (no spaces), because the
// upload matcher compares raw names. Keyed/compared lower-cased + trimmed.
const RENAME: Record<string, string> = {
  "00-global-rules": "00全域規則",
  "01-teaching-plans": "01教學與預想書",
  "02-guidance-teacher-training": "02輔導關懷與師訓",
  "03-weekly-journal": "03週誌系統",
  "04-asana-digital-systems": "04Asana與數位系統",
  "05-department-management": "05部門管理",
  "06-founder-meetings": "06創辦人與會議",
  "07-parent-comms-crisis": "07家長溝通與危機",
  "08-presentation-templates": "08簡報版型",
  "09-growth-awards-family": "09成長藍圖獎項",
  "10-investment": "10投資",
};
const TARGET_NAMES = new Set(Object.values(RENAME).map((n) => n.toLowerCase()));

async function main() {
  const config = loadConfig();
  const dbUrl =
    process.env.DATABASE_URL?.trim()
    || config.databaseUrl
    || `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`;
  const db = createDb(dbUrl);

  const founders = await db
    .select({ id: authUsers.id, email: authUsers.email })
    .from(authUsers)
    .where(inArray(authUsers.email, FOUNDER_EMAILS));
  const founderIds = founders.map((f) => f.id);

  if (founderIds.length === 0) {
    console.error("No founder users found for", FOUNDER_EMAILS, "— aborting (refuse to write an orphaned private folder).");
    process.exit(1);
  }
  const missing = FOUNDER_EMAILS.filter((e) => !founders.some((f) => (f.email ?? "").toLowerCase() === e));
  if (missing.length) console.warn(`WARNING: no user row for ${missing.join(", ")} — proceeding with ${founders.map((f) => f.email).join(", ")}.`);

  const allSkillFolders = await db
    .select({ id: folders.id, name: folders.name, scope: folders.scope, sharedUserIds: folders.sharedUserIds })
    .from(folders)
    .where(eq(folders.kind, "skill"));

  // Names present today, lower-cased, so we can detect Chinese-named twins that
  // a prior duplicate upload may have already created.
  const existingNames = new Set(allSkillFolders.map((f) => (f.name ?? "").trim().toLowerCase()));

  console.log(`${APPLY ? "APPLYING" : "DRY-RUN"} — rename founder folders to Traditional Chinese + lock to private [${founders.map((f) => f.email).join(", ")}]\n`);

  let renamed = 0;
  let skipped = 0;
  for (const f of allSkillFolders) {
    const current = (f.name ?? "").trim().toLowerCase();
    const target = RENAME[current];

    // Already at a Chinese target name — only make sure it is private + founders.
    if (!target && TARGET_NAMES.has(current)) {
      const alreadyPrivate = f.scope === "private"
        && founderIds.every((id) => (f.sharedUserIds ?? []).includes(id))
        && (f.sharedUserIds ?? []).every((id) => founderIds.includes(id));
      if (alreadyPrivate) {
        console.log(`  ok (already renamed + private): ${f.name}`);
        continue;
      }
      console.log(`  lock scope only (already Chinese name): ${f.name}  [${f.scope} → private]`);
      if (APPLY) {
        await db.update(folders)
          .set({ scope: "private", sharedUserIds: founderIds, sharingTeams: [], updatedAt: new Date() })
          .where(and(eq(folders.id, f.id), eq(folders.kind, "skill")));
      }
      renamed++;
      continue;
    }

    if (!target) continue; // not one of the reserved English-slug folders

    // Collision guard: a Chinese-named twin already exists → don't create a
    // second folder with the same name. Leave both for a manual merge.
    if (existingNames.has(target.toLowerCase())) {
      console.warn(`  SKIP collision: "${f.name}" → "${target}" — a folder named "${target}" already exists. Merge them by hand first.`);
      skipped++;
      continue;
    }

    console.log(`  rename: "${f.name}" → "${target}"   [scope ${f.scope} → private + ${founderIds.length} founders]`);
    if (APPLY) {
      await db.update(folders)
        .set({ name: target, scope: "private", sharedUserIds: founderIds, sharingTeams: [], updatedAt: new Date() })
        .where(and(eq(folders.id, f.id), eq(folders.kind, "skill")));
      existingNames.add(target.toLowerCase());
    }
    renamed++;
  }

  console.log(`\n${APPLY ? "Applied" : "Would change"}: ${renamed} folder(s)${skipped ? `, ${skipped} skipped (collision)` : ""}.`);
  if (!APPLY) console.log("Re-run with --apply to write.");
}

void main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`founder-folder rename failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
