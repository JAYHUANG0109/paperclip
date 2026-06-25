// Daily wiki distillation runner (launchd / cron).
// Connects directly to the embedded Postgres and distills every company's
// wiki — independent of the long-running server process.
import { createDb, companies } from "@paperclipai/db";
import { distillCompanyWiki } from "../src/services/wiki-distillation.js";

const DB_URL =
  process.env.DATABASE_URL ?? "postgres://paperclip:paperclip@127.0.0.1:54329/paperclip";
const WIKI_ROOT = process.env.PAPERCLIP_WIKI_ROOT ?? "/Users/jayhuang/seasonarts-wiki";

(async () => {
  const db = createDb(DB_URL);
  const rows = await db.select({ id: companies.id, name: companies.name }).from(companies);
  for (const c of rows) {
    try {
      const result = await distillCompanyWiki({ db: db as any, companyId: c.id, wikiRoot: WIKI_ROOT });
      console.log(`[${new Date().toISOString()}] distilled ${c.name}: ${result.projectsWritten} project(s)`);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] FAILED ${c.name}:`, (err as Error).message);
    }
  }
  process.exit(0);
})().catch((e) => {
  console.error("distill-cron fatal:", e);
  process.exit(1);
});
