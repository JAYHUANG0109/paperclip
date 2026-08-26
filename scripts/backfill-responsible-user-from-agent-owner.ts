/**
 * Backfill: re-attribute work still marked responsible to the built-in
 * `local-board` account to the ACTUAL owner of the agent doing it.
 *
 * A run's credentials are chosen by `responsibleUserId`, which is inherited from
 * the issue or routine — NOT from the agent. Work created by the local Board
 * account therefore runs as `local-board` no matter whose agent executes it, and
 * every per-user secret it resolves is local-board's. On this instance that meant
 * agents reaching Asana with the founder's PAT.
 *
 * Owner = earliest joined `agent_memberships` row, the same rule
 * `resolveAgentResponsibleUserId` uses, so this agrees with the runtime.
 *
 * Only rows whose agent has a resolvable owner are touched; anything else is
 * reported and left alone rather than guessed at. Every change is written to
 * `backfill_responsible_user_log` so it can be audited or reversed.
 *
 *   tsx scripts/backfill-responsible-user-from-agent-owner.ts             # dry-run
 *   tsx scripts/backfill-responsible-user-from-agent-owner.ts --apply
 *   tsx scripts/backfill-responsible-user-from-agent-owner.ts --from <userId>   # default: local-board
 */
import { createDb, sql } from "../packages/db/src/index.js";
import { loadConfig } from "../server/src/config.js";

const APPLY = process.argv.includes("--apply");
const fromIdx = process.argv.indexOf("--from");
const FROM = fromIdx >= 0 ? process.argv[fromIdx + 1]! : "local-board";

async function main() {
  const config = loadConfig();
  const dbUrl = process.env.DATABASE_URL?.trim() || config.databaseUrl
    || `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`;
  const db = createDb(dbUrl);

  // Earliest joined membership per agent = its owner.
  const owners = new Map<string, string>();
  const ownerRows = await db.execute(sql`
    select distinct on (agent_id) agent_id, user_id
    from agent_memberships
    where state = 'joined'
    order by agent_id, created_at asc
  `);
  for (const r of ownerRows as unknown as Array<{ agent_id: string; user_id: string }>) {
    owners.set(r.agent_id, r.user_id);
  }

  const plan: Array<{ entity: string; id: string; agentId: string; newUser: string }> = [];
  const orphans: Array<{ entity: string; id: string; reason: string }> = [];

  const issues = await db.execute(sql`
    select id, assignee_agent_id from issues where responsible_user_id = ${FROM}
  `);
  for (const r of issues as unknown as Array<{ id: string; assignee_agent_id: string | null }>) {
    if (!r.assignee_agent_id) { orphans.push({ entity: "issue", id: r.id, reason: "no assignee agent" }); continue; }
    const owner = owners.get(r.assignee_agent_id);
    if (!owner || owner === FROM) { orphans.push({ entity: "issue", id: r.id, reason: "agent has no other owner" }); continue; }
    plan.push({ entity: "issue", id: r.id, agentId: r.assignee_agent_id, newUser: owner });
  }

  const routines = await db.execute(sql`
    select id, assignee_agent_id from routines where responsible_user_id = ${FROM}
  `);
  for (const r of routines as unknown as Array<{ id: string; assignee_agent_id: string | null }>) {
    if (!r.assignee_agent_id) { orphans.push({ entity: "routine", id: r.id, reason: "no assignee agent" }); continue; }
    const owner = owners.get(r.assignee_agent_id);
    if (!owner || owner === FROM) { orphans.push({ entity: "routine", id: r.id, reason: "agent has no other owner" }); continue; }
    plan.push({ entity: "routine", id: r.id, agentId: r.assignee_agent_id, newUser: owner });
  }

  // Revisions carry their own responsible user and are what future runs read,
  // so a routine fixed without its revisions would silently revert.
  const revisions = await db.execute(sql`
    select rev.id, r.assignee_agent_id
    from routine_revisions rev join routines r on r.id = rev.routine_id
    where rev.responsible_user_id = ${FROM}
  `);
  for (const r of revisions as unknown as Array<{ id: string; assignee_agent_id: string | null }>) {
    if (!r.assignee_agent_id) { orphans.push({ entity: "routine_revision", id: r.id, reason: "no assignee agent" }); continue; }
    const owner = owners.get(r.assignee_agent_id);
    if (!owner || owner === FROM) { orphans.push({ entity: "routine_revision", id: r.id, reason: "agent has no other owner" }); continue; }
    plan.push({ entity: "routine_revision", id: r.id, agentId: r.assignee_agent_id, newUser: owner });
  }

  const byEntity: Record<string, number> = {};
  for (const p of plan) byEntity[p.entity] = (byEntity[p.entity] ?? 0) + 1;
  console.log(`${APPLY ? "APPLYING" : "DRY-RUN"} — re-attributing work owned by "${FROM}"\n`);
  for (const [k, v] of Object.entries(byEntity)) console.log(`  ${k}: ${v}`);
  console.log(`  (left alone: ${orphans.length})`);

  if (!APPLY) {
    for (const o of orphans.slice(0, 10)) console.log(`  ! ${o.entity} ${o.id}: ${o.reason}`);
    console.log("\npass --apply to write");
    process.exit(0);
  }

  for (const p of plan) {
    const table = p.entity === "issue" ? sql`issues` : p.entity === "routine" ? sql`routines` : sql`routine_revisions`;
    await db.execute(sql`update ${table} set responsible_user_id = ${p.newUser} where id = ${p.id}::uuid`);
    await db.execute(sql`
      insert into backfill_responsible_user_log (entity, entity_id, old_user, new_user)
      values (${p.entity}, ${p.id}::uuid, ${FROM}, ${p.newUser})
    `);
  }
  console.log(`\nupdated ${plan.length} rows, logged to backfill_responsible_user_log`);
  process.exit(0);
}

void main().catch((e) => { console.error(e); process.exit(1); });
