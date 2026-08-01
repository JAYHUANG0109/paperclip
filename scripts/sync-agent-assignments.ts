/**
 * Reconcile the Google Chat 代理指派 assignment map with `agent_memberships`.
 *
 * The same reconciler the admin endpoint uses
 * (server/src/services/agent-assignment-sync.ts) — this is the operator's way
 * to run it without a session, e.g. from the deploy host.
 *
 * Dry run by default. Writing requires `--apply`, because this touches the
 * mapping that decides who can see which agent:
 *
 *   tsx scripts/sync-agent-assignments.ts                # report only
 *   tsx scripts/sync-agent-assignments.ts --apply        # write
 *   tsx scripts/sync-agent-assignments.ts --company <id> # scope to one company
 */
import { createDb } from "../packages/db/src/index.js";
import { syncAgentAssignments } from "../server/src/services/agent-assignment-sync.js";

const argv = process.argv.slice(2);
const apply = argv.includes("--apply");
const companyIndex = argv.indexOf("--company");
const companyId = companyIndex >= 0 ? argv[companyIndex + 1] : undefined;

const url = process.env.DATABASE_URL ?? "postgres://paperclip:paperclip@127.0.0.1:54329/paperclip";
const db = createDb(url);

const result = await syncAgentAssignments(db, { companyId, dryRun: !apply });

console.log(apply ? "APPLIED" : "DRY RUN (pass --apply to write)");
console.log(`  scanned:            ${result.assignmentCount} assignments, ${result.membershipCount} memberships`);
console.log(`  memberships created: ${result.dbInserts.length}`);
console.log(`  memberships removed: ${result.dbRemovals.length}`);
console.log(`  assignments written: ${result.mapUpserts.length}`);
console.log(`  assignments removed: ${result.mapRemovals.length}`);
console.log(`  preserved (no Paperclip account): ${result.unresolvedEmails.length}`);

// Never let a bounded outcome look like a complete one.
for (const removal of result.mapRemovals) console.log(`  - drop ${removal.email}: ${removal.reason}`);
for (const removal of result.dbRemovals) console.log(`  - remove membership ${removal.id}: ${removal.reason}`);
for (const extra of result.unrepresented) {
  console.log(`  ! ${extra.email} owns more agents than the map can name: ${extra.agentIds.join(", ")}`);
}

process.exit(0);
