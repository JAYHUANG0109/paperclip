/**
 * Backfill (corrected): wire each agent's file-based Asana token onto its
 * OWNER's per-user secret — the user who joined the agent (agent_memberships),
 * not the run's responsible user. This is the reliable per-agent → human
 * pairing, so every person who handed their agent a token gets it reflected in
 * "My secrets" (coverage) and used at runtime. Idempotent; creates the
 * ASANA_TOKEN definition on first use.
 *   cd server && npx tsx scripts/backfill-asana-owner-secrets.ts [companyId]
 */
import { createDb, agents, agentMemberships, authUsers } from "@paperclipai/db";
import { readFileSync } from "node:fs"; import { homedir } from "node:os";
import { and, eq } from "drizzle-orm";
import { readToken, ASANA_USER_SECRET_KEY } from "../src/services/agent-asana.js";
import { secretService } from "../src/services/secrets.js";
import { getConfiguredSecretProvider } from "../src/secrets/configured-provider.js";

const companyId = process.argv[2] || "0980d089-ebdf-4f54-9576-1a9150c5d6f9";
const port = readFileSync(homedir()+"/.paperclip/instances/default/db/postmaster.pid","utf8").split("\n")[3].trim();
const db = createDb(`postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`);
const svc = secretService(db);
const names = new Map((await db.select().from(authUsers)).map((u:any)=>[u.id,u.name]));

async function ensureDef() {
  const defs = await svc.listUserSecretDefinitions(companyId);
  if (defs.some((d:any)=>d.key===ASANA_USER_SECRET_KEY)) return;
  await svc.createUserSecretDefinition(companyId, {
    key: ASANA_USER_SECRET_KEY, name: "Asana token",
    description: "Your personal Asana personal access token. Every agent you are responsible for uses it to read/post on Asana. Never shown back to anyone, including admins.",
    provider: getConfiguredSecretProvider(),
    usageGuidance: "Create a Personal Access Token at https://app.asana.com/0/my-apps and paste it here.",
  }, { userId: null, agentId: null });
}

const roster = await db.select().from(agents).where(eq(agents.companyId, companyId));
let wired=0, already=0, noOwner=0, noToken=0;
let ensured=false;
for (const a of roster) {
  const f = readToken(a, companyId, a.id);
  if (!f?.token) { noToken++; continue; }
  const mems = await db.select().from(agentMemberships).where(and(eq(agentMemberships.companyId,companyId),eq(agentMemberships.agentId,a.id),eq(agentMemberships.state,"joined")));
  if (mems.length===0) { console.log(`~ ${a.name}: file token but no joined owner — skipped`); noOwner++; continue; }
  if (!ensured) { await ensureDef(); ensured=true; }
  for (const m of mems) {
    const entries = await svc.listCurrentUserSecretValues(companyId, m.userId);
    if (entries.some((e:any)=>e.definition.key===ASANA_USER_SECRET_KEY && e.secret)) { already++; continue; }
    await svc.createCurrentUserSecretValue(companyId, m.userId, { definitionKey: ASANA_USER_SECRET_KEY, value: f.token }, { userId: m.userId, agentId: null });
    console.log(`✓ ${a.name} → ${names.get(m.userId)||m.userId}`);
    wired++;
  }
}
console.log(`\nwired=${wired} already-set=${already} no-owner=${noOwner} no-file-token=${noToken}`);
process.exit(0);
