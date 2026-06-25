// Daily wiki distillation runner (launchd / cron).
// Connects directly to the embedded Postgres and distills every company's wiki —
// independent of the long-running server process.
//
// Portable by design: nothing here hard-codes a machine-specific path.
//   - DB URL comes from DATABASE_URL (falls back to the embedded-Postgres default).
//   - The wiki root comes from PAPERCLIP_WIKI_ROOT, else from the LLM-wiki
//     plugin's own per-company stored folder config in the database.
// So this same script works unchanged on a laptop, a Mac mini, or any host.
import { createDb, companies, plugins, pluginCompanySettings } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { distillCompanyWiki } from "../src/services/wiki-distillation.js";

const DB_URL =
  process.env.DATABASE_URL ?? "postgres://paperclip:paperclip@127.0.0.1:54329/paperclip";
const ENV_WIKI_ROOT = process.env.PAPERCLIP_WIKI_ROOT?.trim() || null;
const WIKI_PLUGIN_KEY = "paperclipai.plugin-llm-wiki";
const WIKI_ROOT_FOLDER_KEY = "wiki-root";

async function resolveWikiRoot(
  db: ReturnType<typeof createDb>,
  companyId: string,
): Promise<string | null> {
  if (ENV_WIKI_ROOT) return ENV_WIKI_ROOT;
  const pluginRow = await db
    .select({ id: plugins.id })
    .from(plugins)
    .where(eq(plugins.pluginKey, WIKI_PLUGIN_KEY))
    .then((r) => r[0] ?? null);
  if (!pluginRow) return null;
  const settings = await db
    .select({ settingsJson: pluginCompanySettings.settingsJson })
    .from(pluginCompanySettings)
    .where(
      and(
        eq(pluginCompanySettings.pluginId, pluginRow.id),
        eq(pluginCompanySettings.companyId, companyId),
      ),
    )
    .then((r) => r[0] ?? null);
  const folders = (settings?.settingsJson as Record<string, unknown> | undefined)?.localFolders as
    | Record<string, { path?: string }>
    | undefined;
  return folders?.[WIKI_ROOT_FOLDER_KEY]?.path ?? null;
}

(async () => {
  const db = createDb(DB_URL);
  const rows = await db.select({ id: companies.id, name: companies.name }).from(companies);
  for (const c of rows) {
    const wikiRoot = await resolveWikiRoot(db, c.id);
    if (!wikiRoot) {
      console.log(`[${new Date().toISOString()}] skip ${c.name}: no wiki root configured`);
      continue;
    }
    try {
      const result = await distillCompanyWiki({ db: db as any, companyId: c.id, wikiRoot });
      console.log(
        `[${new Date().toISOString()}] distilled ${c.name}: ${result.projectsWritten} project(s) -> ${wikiRoot}`,
      );
    } catch (err) {
      console.error(`[${new Date().toISOString()}] FAILED ${c.name}:`, (err as Error).message);
    }
  }
  process.exit(0);
})().catch((e) => {
  console.error("distill-cron fatal:", e);
  process.exit(1);
});
