// Rewrite absolute home paths stored in the DB after moving Paperclip to a machine
// with a DIFFERENT macOS username.
//
// The previous version of this script rewrote exactly one column,
// `agents.adapter_config`, and its header asserted that was "the only place the DB
// stores an absolute path". That was wrong. After the 2026-08-02 Mac mini migration
// a sweep found 6,431 values holding the old home across 28 columns — including
// `plugins.package_path`, which made the Google Chat plugin load no agent tools at
// all, so agents reported they had no way to send a Chat message and fell back to
// asking for MCP connectors. Skills, execution workspaces and environment leases
// were stale for the same reason.
//
// Note that a database restored FROM the old machine reintroduces every one of these
// paths, so this is not a one-time fix — run it after any such restore.
//
// Usage (dry run first — this prints what it would change and writes nothing):
//   OLD_HOME=/Users/seasonart server/node_modules/.bin/tsx server/scripts/rewrite-db-paths.ts
//   OLD_HOME=/Users/seasonart server/node_modules/.bin/tsx server/scripts/rewrite-db-paths.ts --apply
//
// NEW_HOME defaults to $HOME. `--apply` writes a JSON backup of every row it touches
// to ~/.paperclip/instances/default/db-backups/ before changing anything.
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createDb } from "@paperclipai/db";
import { sql } from "drizzle-orm";

const DB_URL = process.env.SEED_DB_URL || "postgres://paperclip:paperclip@127.0.0.1:54329/paperclip";
const OLD = process.env.OLD_HOME;
const NEW = process.env.NEW_HOME || process.env.HOME;
const APPLY = process.argv.includes("--apply");
const INCLUDE_HISTORY = process.argv.includes("--include-history");

/**
 * Columns that feed the running system: config the runtime reads, paths it resolves,
 * state it acts on. These MUST be rewritten or the platform misbehaves on the new host.
 */
const RUNTIME_COLUMNS = new Set([
  "agents.adapter_config",              // agent runtime config incl. ASANA_TOKEN_PATH, claude config dirs
  "plugins.package_path",               // where the plugin loader reads a plugin from
  "plugin_company_settings.settings_json",
  "company_skills.source_locator",      // how a skill's files are resolved
  "company_skills.metadata",
  "execution_workspaces.cwd",           // the cwd a run is given
  "execution_workspaces.metadata",
  "environment_leases.metadata",
  "agent_task_sessions.session_params_json",
  "agent_wakeup_requests.payload",
  "agent_wakeup_requests.error",
  "approvals.payload",
  "workspace_operations.cwd",
  "workspace_operations.metadata",
]);

/**
 * Everything else that merely *mentions* the old path: audit rows, run logs, revision
 * history, and human-authored content. Rewriting these would falsify a record of what
 * actually ran, and in the case of `issue_comments.body` would edit what a colleague
 * wrote. Left alone unless --include-history is passed.
 */
function isHistory(qualified: string): boolean {
  return !RUNTIME_COLUMNS.has(qualified);
}

async function main() {
  if (!OLD || !NEW) {
    console.error("✗ set OLD_HOME (and NEW_HOME or $HOME).");
    process.exit(1);
  }
  if (OLD === NEW) {
    console.log("OLD_HOME === NEW_HOME — nothing to rewrite.");
    process.exit(0);
  }
  if (!OLD.startsWith("/")) {
    console.error("✗ OLD_HOME must be an absolute path.");
    process.exit(1);
  }

  const db = createDb(DB_URL);
  const like = `%${OLD}%`;
  /** Single-quote escaping for values interpolated into sql.raw(). */
  const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
  /** Identifier quoting; information_schema names only, but be strict anyway. */
  const ident = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const rows = async <T,>(query: string): Promise<T[]> => {
    const res = await db.execute(sql.raw(query));
    return (Array.isArray(res) ? res : (res as { rows?: unknown[] }).rows ?? []) as T[];
  };

  const columns = await rows<{ table_name: string; column_name: string }>(`
    SELECT c.table_name, c.column_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public'
      AND t.table_type = 'BASE TABLE'
      AND c.data_type IN ('text', 'character varying', 'jsonb', 'json')
    ORDER BY c.table_name, c.column_name
  `);

  const runtime: { t: string; c: string; n: number }[] = [];
  const history: { t: string; c: string; n: number }[] = [];

  for (const col of columns) {
    let n = 0;
    try {
      const [row] = await rows<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${ident(col.table_name)} WHERE ${ident(col.column_name)}::text LIKE ${lit(like)}`,
      );
      n = Number(row?.n ?? 0);
    } catch {
      continue; // column type we cannot cast/compare — skip rather than abort the sweep
    }
    if (n === 0) continue;
    const qualified = `${col.table_name}.${col.column_name}`;
    (isHistory(qualified) ? history : runtime).push({ t: col.table_name, c: col.column_name, n });
  }

  const sum = (rows: { n: number }[]) => rows.reduce((acc, r) => acc + r.n, 0);
  console.log(`Rewriting ${OLD} → ${NEW}`);
  console.log(`\nRUNTIME columns (${sum(runtime)} values in ${runtime.length} columns) — these break the platform:`);
  for (const r of runtime) console.log(`  ${r.t}.${r.c}: ${r.n}`);
  console.log(`\nHISTORY columns (${sum(history)} values in ${history.length} columns) — audit/logs/content, ${INCLUDE_HISTORY ? "WILL rewrite (--include-history)" : "left alone"}:`);
  for (const h of history) console.log(`  ${h.t}.${h.c}: ${h.n}`);

  const targets = INCLUDE_HISTORY ? [...runtime, ...history] : runtime;
  if (!targets.length) {
    console.log("\nNothing to do.");
    process.exit(0);
  }

  if (!APPLY) {
    console.log(`\n(dry run — nothing written. Re-run with --apply to rewrite ${sum(targets)} values.)`);
    process.exit(0);
  }

  // Back up every row we are about to touch, keyed by primary key where one exists.
  const backupDir = join(homedir(), ".paperclip", "instances", "default", "db-backups");
  mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup: Record<string, unknown[]> = {};
  for (const t of targets) {
    try {
      backup[`${t.t}.${t.c}`] = await rows<unknown>(
        `SELECT * FROM ${ident(t.t)} WHERE ${ident(t.c)}::text LIKE ${lit(like)}`,
      );
    } catch (e) {
      console.error(`  ! could not back up ${t.t}.${t.c}: ${(e as Error).message}`);
    }
  }
  const backupPath = join(backupDir, `path-rewrite-${stamp}.json`);
  writeFileSync(backupPath, JSON.stringify(backup, null, 2));
  console.log(`\n✓ Backed up affected rows to ${backupPath}`);

  let changed = 0;
  for (const t of targets) {
    const [{ data_type: type }] = await rows<{ data_type: string }>(
      `SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name=${lit(t.t)} AND column_name=${lit(t.c)}`,
    );
    // jsonb/json must round-trip through text; text/varchar replace directly.
    const repl = `replace(${ident(t.c)}::text, ${lit(OLD)}, ${lit(NEW)})`;
    const expr = type === "jsonb" ? `${repl}::jsonb` : type === "json" ? `${repl}::json` : repl;
    const res = await db.execute(sql.raw(
      `UPDATE ${ident(t.t)} SET ${ident(t.c)} = ${expr} WHERE ${ident(t.c)}::text LIKE ${lit(like)}`,
    ));
    const n = (res as unknown as { count?: number }).count ?? 0;
    changed += n;
    console.log(`  ✓ ${t.t}.${t.c}: ${n} row(s)`);
  }

  console.log(`\n✓ Rewrote ${changed} row(s). Restart the service so the runtime reloads config and plugins.`);
  process.exit(0);
}

main().catch((e) => {
  console.error("FAILED:", (e as Error)?.message || e);
  process.exit(1);
});
