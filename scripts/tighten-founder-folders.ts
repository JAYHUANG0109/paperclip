/**
 * Consolidation follow-up — force the founder's numbered (00–10) skill folders
 * to Private, shared only with the founder (Tang) + Jay.
 *
 * Belt-and-suspenders on top of the server-side name restriction: these folders
 * are already hidden from non-founder users by name, but this also sets
 * scope=private + sharedUserIds=[Tang, Jay] so they're gated by scope too.
 * (Owners/admins/instance-admins still see them for oversight — that is the
 * platform-wide privileged short-circuit, by design.)
 *
 * SAFE: dry-run by default (prints planned changes), --apply to write.
 * Idempotent — safe to re-run and safe on folders already set private by hand.
 * Only touches folders whose NAME is a reserved numbered folder.
 *
 * Usage:
 *   pnpm --filter @paperclipai/server exec tsx ../scripts/tighten-founder-folders.ts
 *   pnpm --filter @paperclipai/server exec tsx ../scripts/tighten-founder-folders.ts --apply
 */
import { and, authUsers, createDb, eq, folders, inArray } from "../packages/db/src/index.js";
import { loadConfig } from "../server/src/config.js";

const APPLY = process.argv.includes("--apply");
const FOUNDER_EMAILS = ["tang@seasonart.org", "jay20020109@seasonart.org"];

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

  const founders = await db
    .select({ id: authUsers.id, email: authUsers.email })
    .from(authUsers)
    .where(inArray(authUsers.email, FOUNDER_EMAILS));
  const founderIds = founders.map((f) => f.id);

  if (founderIds.length === 0) {
    console.error("No founder users found for", FOUNDER_EMAILS, "— aborting (won't create an orphaned private folder).");
    process.exit(1);
  }
  const missing = FOUNDER_EMAILS.filter((e) => !founders.some((f) => (f.email ?? "").toLowerCase() === e));
  if (missing.length) console.warn(`WARNING: no user row for ${missing.join(", ")} — proceeding with ${founders.map((f) => f.email).join(", ")}.`);

  const allSkillFolders = await db
    .select({ id: folders.id, name: folders.name, scope: folders.scope, sharedUserIds: folders.sharedUserIds })
    .from(folders)
    .where(eq(folders.kind, "skill"));
  const numbered = allSkillFolders.filter((f) => isRestrictedFolderName(f.name));

  console.log(`${APPLY ? "APPLYING" : "DRY-RUN"} — ${numbered.length} numbered folders → private, shared with: ${founders.map((f) => f.email).join(", ")}\n`);

  let changed = 0;
  for (const f of numbered) {
    const already = f.scope === "private"
      && founderIds.every((id) => (f.sharedUserIds ?? []).includes(id))
      && (f.sharedUserIds ?? []).every((id) => founderIds.includes(id));
    if (already) {
      console.log(`  ok (already private+[founders]): ${f.name}`);
      continue;
    }
    console.log(`  ${f.scope} → private + [${founders.length} founders]: ${f.name}`);
    if (APPLY) {
      await db.update(folders)
        .set({ scope: "private", sharedUserIds: founderIds, sharingTeams: [], updatedAt: new Date() })
        .where(and(eq(folders.id, f.id), eq(folders.kind, "skill")));
    }
    changed++;
  }

  console.log(`\n${APPLY ? "Applied" : "Would change"}: ${changed} of ${numbered.length} numbered folders.`);
  if (!APPLY) console.log("Re-run with --apply to write.");
}

void main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`founder-folder tightening failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
