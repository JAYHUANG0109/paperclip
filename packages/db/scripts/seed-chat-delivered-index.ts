#!/usr/bin/env tsx
/**
 * One-shot: bring pre-existing Google Chat `delivered:` rows under the plugin's
 * retention index.
 *
 * Background. The Chat plugin remembers which agent comments it has already
 * mirrored in one instance-scoped `plugin_state` row per issue,
 * `delivered:<issueId>`. Each record was size-capped (DELIVERED_CAP = 200 ids),
 * so it looked bounded — but nothing capped the NUMBER of records. A conversation
 * ends by simply never being mentioned again, and no code path deleted its row,
 * so the table only ever grew: 462 rows / 561 kB by 2026-08-14, oldest
 * 2026-06-02, roughly +180/month.
 *
 * `ctx.state` exposes only get/set/delete on an exact key (no list), so the
 * plugin cannot sweep its own rows; it now keeps `delivered:index`, an LRU of
 * issue ids, and evicting from that index deletes the row it names. That bounds
 * everything written from here on — but rows written BEFORE the index existed
 * are absent from it, so eviction can never reach them. They would sit forever
 * while new rows accumulated to the cap on top of them.
 *
 * This script seeds the index with the rows already in the table, ordered oldest
 * -> newest by `updated_at`, so the LRU adopts them and evicts the stalest first.
 *
 * Why recency and not status: 393 of those 462 rows belong to issues already
 * `done`, which looks like a tidier prune key. It is wrong. Issues legitimately
 * churn through `done` before the agent's real answer is written (see the note
 * above the issue.comment.created handler in the plugin worker — deleting on
 * `done` is precisely the bug that lost replies). Dropping a record while more
 * comments can still arrive re-mirrors them into Chat. Recency is safe in a way
 * status is not.
 *
 * Usage:
 *   pnpm --filter @paperclipai/db exec tsx scripts/seed-chat-delivered-index.ts --dry-run
 *   pnpm --filter @paperclipai/db exec tsx scripts/seed-chat-delivered-index.ts
 *
 * Idempotent: re-running merges rather than duplicates, and rows already in the
 * index keep their position. Exits 0 when there is nothing to do.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { createDb } from "../src/client.js";
import { pluginState } from "../src/schema/index.js";

/** Must match DELIVERED_ISSUE_CAP in the Chat plugin worker. */
const DELIVERED_ISSUE_CAP = 500;
const INDEX_KEY = "delivered:index";
const DEFAULT_NAMESPACE = "default";

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const asJson = argv.includes("--json");

function resolveUrl(): string {
  const explicit = process.env.DATABASE_URL?.trim();
  if (explicit) return explicit;
  const port = process.env.PAPERCLIP_PG_PORT?.trim() || "54329";
  return `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
}

async function main(): Promise<void> {
  const db = createDb(resolveUrl());

  // Every delivered row, per plugin, oldest touch first. Scoped to instance rows
  // with a null scope_id, which is what deliveredKey() writes.
  const rows = await db
    .select({
      pluginId: pluginState.pluginId,
      stateKey: pluginState.stateKey,
      updatedAt: pluginState.updatedAt,
    })
    .from(pluginState)
    .where(
      and(
        eq(pluginState.scopeKind, "instance"),
        isNull(pluginState.scopeId),
        eq(pluginState.namespace, DEFAULT_NAMESPACE),
        sql`${pluginState.stateKey} like 'delivered:%'`,
        sql`${pluginState.stateKey} <> ${INDEX_KEY}`,
      ),
    )
    .orderBy(pluginState.updatedAt);

  if (rows.length === 0) {
    if (asJson) console.log(JSON.stringify({ plugins: 0, seeded: 0, evicted: 0 }));
    else console.log("No delivered: rows found — nothing to seed.");
    return;
  }

  // The rows belong to whichever plugin installation wrote them; seed each
  // installation's own index rather than mixing ids across them.
  const byPlugin = new Map<string, string[]>();
  for (const row of rows) {
    const issueId = row.stateKey.slice("delivered:".length);
    if (!issueId) continue;
    const list = byPlugin.get(row.pluginId) ?? [];
    list.push(issueId);
    byPlugin.set(row.pluginId, list);
  }

  const report: Array<{ pluginId: string; existing: number; seeded: number; evicted: number }> = [];

  for (const [pluginId, discovered] of byPlugin) {
    const current = await db
      .select({ valueJson: pluginState.valueJson })
      .from(pluginState)
      .where(
        and(
          eq(pluginState.pluginId, pluginId),
          eq(pluginState.scopeKind, "instance"),
          isNull(pluginState.scopeId),
          eq(pluginState.namespace, DEFAULT_NAMESPACE),
          eq(pluginState.stateKey, INDEX_KEY),
        ),
      );

    const existing = ((current[0]?.valueJson as { issueIds?: string[] } | undefined)?.issueIds ?? []).filter(
      (id): id is string => typeof id === "string",
    );

    // Anything already indexed keeps its (more accurate) position; discovered
    // rows that are missing go in front of it, since they are the older ones.
    const known = new Set(existing);
    const merged = [...discovered.filter((id) => !known.has(id)), ...existing];
    const evicted = merged.length > DELIVERED_ISSUE_CAP ? merged.splice(0, merged.length - DELIVERED_ISSUE_CAP) : [];

    report.push({ pluginId, existing: existing.length, seeded: merged.length - existing.length, evicted: evicted.length });

    if (dryRun) continue;

    await db
      .insert(pluginState)
      .values({
        pluginId,
        scopeKind: "instance",
        scopeId: null,
        namespace: DEFAULT_NAMESPACE,
        stateKey: INDEX_KEY,
        valueJson: { issueIds: merged },
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [
          pluginState.pluginId,
          pluginState.scopeKind,
          pluginState.scopeId,
          pluginState.namespace,
          pluginState.stateKey,
        ],
        set: { valueJson: { issueIds: merged }, updatedAt: new Date() },
      });

    for (const issueId of evicted) {
      await db
        .delete(pluginState)
        .where(
          and(
            eq(pluginState.pluginId, pluginId),
            eq(pluginState.scopeKind, "instance"),
            isNull(pluginState.scopeId),
            eq(pluginState.namespace, DEFAULT_NAMESPACE),
            eq(pluginState.stateKey, `delivered:${issueId}`),
          ),
        );
    }
  }

  if (asJson) {
    console.log(JSON.stringify({ dryRun, plugins: report.length, report }, null, 2));
    return;
  }
  console.log(`${dryRun ? "[dry-run] " : ""}delivered: rows found: ${rows.length}`);
  for (const r of report) {
    console.log(
      `  plugin ${r.pluginId}: index had ${r.existing}, seeded +${r.seeded}, evicted ${r.evicted}` +
        ` -> ${Math.min(r.existing + r.seeded, DELIVERED_ISSUE_CAP)} tracked (cap ${DELIVERED_ISSUE_CAP})`,
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
