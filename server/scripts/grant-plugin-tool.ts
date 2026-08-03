// Grant (or revoke) plugin agent-tools for a specific agent.
//
// Why this script exists: tool access is deny-by-default, enforced by
// `toolAccessPolicyService.decide()`, which permits a call only when an *effective tool
// profile* includes it. The granting side of that system was never built — no HTTP route,
// no service function, no UI writes `tool_profiles`; the only writer in the repo is
// `tool-gateway.test.ts`. So on a live instance those tables sit empty, every plugin tool
// call returns `deny_default`, and agents conclude the capability does not exist. This is
// the operator-facing counterpart to the enforcement that already shipped.
//
// Scope guarantees, both by strict equality in tool-access-policy.ts:
//   - `targetMatches`      — a binding with targetType "agent" applies only when
//                            binding.targetId === ctx.agentId. Other agents are unaffected.
//   - `profileEntryMatches` — a "tool_name" entry applies only when
//                            entry.toolName === ctx.toolName. Other tools stay denied.
// The profile is created with defaultAction "deny", so it can only ever *add* the named
// tools for the named agent. It cannot widen anything else.
//
// Usage (dry run prints the plan and writes nothing):
//   server/node_modules/.bin/tsx server/scripts/grant-plugin-tool.ts \
//     --agent <agentId> --tools send_chat_message,send_chat_space_message
//   ... same command with --apply   to write
//   ... same command with --revoke --apply   to remove the binding again
//
// --company defaults to the agent's own company. --profile-key defaults to
// "agent-<agentId prefix>-tools" so each agent gets its own profile and revoking one
// agent never affects another.
//
// To grant every agent in a company instead of one, use --all-agents with --company:
//   ... --all-agents --company <companyId> --tools send_chat_space_message --apply
//
// IMPORTANT precedence caveat. narrowestScopeBindings() keeps only the bindings at the
// NARROWEST matching scope and discards broader ones (agent=3 beats company=5, see
// tool-profile-binding-precedence.ts). So a company-wide grant is invisible to any agent
// that already has its own agent-scoped binding — that agent sees only its own profile.
// The script warns about those agents rather than leaving you to discover it later.
import { and, eq, inArray } from "drizzle-orm";
import {
  agents,
  createDb,
  plugins,
  toolCatalogEntries,
  toolProfileBindings,
  toolProfileEntries,
  toolProfiles,
} from "@paperclipai/db";

/**
 * The policy compares `entry.toolName` against `ctx.toolName` by strict equality, and for
 * a plugin tool `ctx.toolName` is the NAMESPACED name — "<pluginKey>:<toolName>" (see
 * TOOL_NAMESPACE_SEPARATOR in plugin-tool-registry.ts, and toAgentDescriptor which sets
 * the descriptor name to namespacedName). The company tool catalog, confusingly, stores
 * the BARE name. An earlier version of this script validated against the catalog and then
 * wrote the bare name into the profile, so the grant looked successful, changed nothing,
 * and the tool stayed denied with deny_default.
 */
const NAMESPACE_SEPARATOR = ":";

const DB_URL = process.env.SEED_DB_URL || "postgres://paperclip:paperclip@127.0.0.1:54329/paperclip";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}
const APPLY = process.argv.includes("--apply");
const REVOKE = process.argv.includes("--revoke");
const ALL_AGENTS = process.argv.includes("--all-agents");


/**
 * Grant tools to EVERY agent in a company via a single company-scoped binding.
 *
 * One profile, one binding — not one per agent — so it stays comprehensible and is
 * revocable in one step. See the precedence caveat in the header: agents that already
 * carry their own agent-scoped binding will not see this grant, and are reported.
 */
async function grantCompanyWide(db: ReturnType<typeof createDb>, companyId: string, requested: string[]) {
  if (requested.length === 0) {
    console.error("✗ --tools <name,name> is required.");
    process.exit(1);
  }
  const profileKey = arg("profile-key") ?? "company-plugin-tools";
  console.log(`company: ${companyId}`);
  console.log(`profile: ${profileKey}  (binding scope: company — applies to every agent)`);

  const bare = requested.map((n) => (n.includes(NAMESPACE_SEPARATOR) ? n.slice(n.lastIndexOf(NAMESPACE_SEPARATOR) + 1) : n));
  const catalog = await db.select().from(toolCatalogEntries)
    .where(and(eq(toolCatalogEntries.companyId, companyId), inArray(toolCatalogEntries.name, bare)));
  const known = new Set(catalog.map((e) => e.name));
  const unknown = bare.filter((n) => !known.has(n));
  for (const entry of catalog) console.log(`  ✓ ${entry.name} — status=${entry.status} quarantined=${entry.quarantinedAt ? "YES" : "no"}`);
  if (unknown.length) {
    console.error(`  ✗ not in this company's tool catalog: ${unknown.join(", ")}. Aborting.`);
    process.exit(1);
  }

  const installed = await db.select().from(plugins);
  const namespaced: string[] = [];
  for (const name of bare) {
    const owner = installed.find((pl) => ((pl.manifestJson as { tools?: { name?: string }[] } | null)?.tools ?? []).some((t) => t.name === name));
    if (!owner) {
      console.error(`  ✗ no installed plugin declares "${name}". Aborting.`);
      process.exit(1);
    }
    namespaced.push(`${owner.pluginKey}${NAMESPACE_SEPARATOR}${name}`);
  }
  console.log(`\npolicy-visible names: ${namespaced.join(", ")}`);

  const liveAgents = await db.select().from(agents).where(eq(agents.companyId, companyId));
  const active = liveAgents.filter((a) => a.status !== "terminated");
  console.log(`agents in company (non-terminated): ${active.length}`);

  // Agents with their own agent-scoped binding shadow the company one entirely.
  const existingBindings = await db.select().from(toolProfileBindings)
    .where(and(eq(toolProfileBindings.companyId, companyId), eq(toolProfileBindings.targetType, "agent")));
  const shadowed = active.filter((a) => existingBindings.some((b) => b.targetId === a.id));
  if (shadowed.length) {
    console.log(`\n⚠ ${shadowed.length} agent(s) already have an agent-scoped binding, which takes`);
    console.log(`  precedence and HIDES this company grant from them (agent=3 beats company=5):`);
    for (const a of shadowed) console.log(`    – ${a.name} (${a.id.slice(0, 8)})`);
    console.log(`  They keep whatever their own profile grants. If that profile lacks a tool`);
    console.log(`  granted here, they still cannot use it — grant it on their profile too.`);
  }

  if (!REVOKE && !APPLY) {
    console.log(`\n(dry run — nothing written)`);
    console.log(`would create profile "${profileKey}" (defaultAction=deny, status=active)`);
    console.log(`would add include entries: ${namespaced.join(", ")}`);
    console.log(`would bind targetType=company targetId=${companyId}`);
    console.log(`\nEffective for ${active.length - shadowed.length} of ${active.length} agents. Re-run with --apply.`);
    return;
  }

  const existing = await db.select().from(toolProfiles)
    .where(and(eq(toolProfiles.companyId, companyId), eq(toolProfiles.profileKey, profileKey)));

  if (REVOKE) {
    if (!existing[0]) { console.log("nothing to revoke."); return; }
    if (!APPLY) { console.log("\n(dry run) would delete the company binding, entries and profile."); return; }
    await db.delete(toolProfileBindings).where(and(
      eq(toolProfileBindings.companyId, companyId),
      eq(toolProfileBindings.profileId, existing[0].id),
    ));
    await db.delete(toolProfileEntries).where(and(
      eq(toolProfileEntries.companyId, companyId),
      eq(toolProfileEntries.profileId, existing[0].id),
    ));
    await db.delete(toolProfiles).where(eq(toolProfiles.id, existing[0].id));
    console.log(`\n✓ revoked company-wide grant. Every agent falls back to deny-by-default.`);
    return;
  }

  const profile = existing[0] ?? await db.insert(toolProfiles).values({
    companyId,
    profileKey,
    name: "Company plugin tools",
    description:
      "Company-scoped grant of specific plugin agent-tools to every agent. defaultAction " +
      "is deny, so only the tool_name entries listed here are permitted. Agents with their " +
      "own agent-scoped binding take precedence and do not see this profile.",
    defaultAction: "deny",
    status: "active",
  }).returning().then((r) => r[0]!);

  const already = await db.select().from(toolProfileEntries)
    .where(and(eq(toolProfileEntries.companyId, companyId), eq(toolProfileEntries.profileId, profile.id)));
  const stale = already.filter((e) => e.toolName && bare.includes(e.toolName));
  for (const e of stale) {
    await db.delete(toolProfileEntries).where(eq(toolProfileEntries.id, e.id));
    console.log(`  – removed stale bare-name entry "${e.toolName}"`);
  }
  const have = new Set(already.filter((e) => !stale.includes(e)).map((e) => e.toolName));
  const toAdd = namespaced.filter((n) => !have.has(n));
  if (toAdd.length) {
    await db.insert(toolProfileEntries).values(toAdd.map((toolName) => ({
      companyId, profileId: profile.id, selectorType: "tool_name" as const, effect: "include" as const, toolName,
    })));
  }

  const bound = await db.select().from(toolProfileBindings).where(and(
    eq(toolProfileBindings.companyId, companyId),
    eq(toolProfileBindings.profileId, profile.id),
    eq(toolProfileBindings.targetType, "company"),
  ));
  if (!bound.length) {
    await db.insert(toolProfileBindings).values({
      companyId, profileId: profile.id, targetType: "company", targetId: companyId,
    });
  }

  console.log(`\n✓ profile ${profile.id} (${profile.defaultAction}/${profile.status})`);
  console.log(`✓ entries: ${toAdd.length ? toAdd.join(", ") : "(already present)"}`);
  console.log(`✓ binding: ${bound.length ? "(already bound)" : `company ${companyId}`}`);
  console.log(`\nEffective for ${active.length - shadowed.length} of ${active.length} agents.`);
  console.log(`Revoke with the same command plus --revoke --apply.`);
}

async function main() {
  const agentId = arg("agent");
  const toolsRaw = arg("tools");
  if (!agentId && !ALL_AGENTS) {
    console.error("✗ --agent <agentId> is required (or --all-agents with --company).");
    process.exit(1);
  }
  if (ALL_AGENTS && !arg("company")) {
    console.error("✗ --all-agents requires --company <companyId>.");
    process.exit(1);
  }
  if (!REVOKE && !toolsRaw) {
    console.error("✗ --tools <name,name> is required unless --revoke.");
    process.exit(1);
  }
  const toolNames = (toolsRaw ?? "").split(",").map((t) => t.trim()).filter(Boolean);

  const db = createDb(DB_URL);

  if (ALL_AGENTS) {
    await grantCompanyWide(db, arg("company")!, (toolsRaw ?? "").split(",").map((t) => t.trim()).filter(Boolean));
    process.exit(0);
  }

  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId!));
  if (!agent) {
    console.error(`✗ agent ${agentId} not found.`);
    process.exit(1);
  }
  const companyId = arg("company") ?? agent.companyId;
  const profileKey = arg("profile-key") ?? `agent-${agentId.slice(0, 8)}-tools`;
  console.log(`agent:   ${agent.name} (${agentId})`);
  console.log(`company: ${companyId}`);
  console.log(`profile: ${profileKey}`);

  if (REVOKE) {
    const [profile] = await db.select().from(toolProfiles)
      .where(and(eq(toolProfiles.companyId, companyId), eq(toolProfiles.profileKey, profileKey)));
    if (!profile) {
      console.log("nothing to revoke — no such profile.");
      process.exit(0);
    }
    if (!APPLY) {
      console.log(`\n(dry run) would delete the binding for this agent, and the profile + entries.`);
      process.exit(0);
    }
    await db.delete(toolProfileBindings).where(and(
      eq(toolProfileBindings.companyId, companyId),
      eq(toolProfileBindings.profileId, profile.id),
      eq(toolProfileBindings.targetId, agentId),
    ));
    await db.delete(toolProfileEntries).where(and(
      eq(toolProfileEntries.companyId, companyId),
      eq(toolProfileEntries.profileId, profile.id),
    ));
    await db.delete(toolProfiles).where(eq(toolProfiles.id, profile.id));
    console.log(`\n✓ revoked. This agent falls back to deny-by-default.`);
    process.exit(0);
  }

  // Refuse to grant a tool the company catalog does not actually offer — otherwise the
  // grant looks successful and the call still fails, with `deny_missing_tool`.
  // Accept either the bare or the namespaced form on the command line; the catalog is
  // keyed by the bare name, the profile must be keyed by the namespaced one.
  const bare = toolNames.map((n) => (n.includes(NAMESPACE_SEPARATOR) ? n.slice(n.lastIndexOf(NAMESPACE_SEPARATOR) + 1) : n));
  const catalog = await db.select().from(toolCatalogEntries)
    .where(and(eq(toolCatalogEntries.companyId, companyId), inArray(toolCatalogEntries.name, bare)));
  const known = new Map(catalog.map((entry) => [entry.name, entry]));
  const unknown = bare.filter((name) => !known.has(name));
  console.log(`\ntools requested: ${bare.join(", ")}`);
  for (const entry of catalog) {
    console.log(`  ✓ ${entry.name} — status=${entry.status} quarantined=${entry.quarantinedAt ? "YES" : "no"}`);
  }
  if (unknown.length) {
    console.error(`  ✗ not in this company's tool catalog: ${unknown.join(", ")}`);
    console.error("    Granting these would still fail with deny_missing_tool. Aborting.");
    process.exit(1);
  }

  // Resolve each bare name to the namespaced form the policy will compare.
  const installed = await db.select().from(plugins);
  const pluginKeyFor = (toolName: string): string | null => {
    for (const plugin of installed) {
      const manifest = plugin.manifestJson as { tools?: { name?: string }[] } | null;
      if ((manifest?.tools ?? []).some((t) => t.name === toolName)) return plugin.pluginKey;
    }
    return null;
  };
  const namespaced: string[] = [];
  for (const name of bare) {
    const key = pluginKeyFor(name);
    if (!key) {
      console.error(`  ✗ no installed plugin declares a tool named "${name}" — cannot build its namespaced name. Aborting.`);
      process.exit(1);
    }
    namespaced.push(`${key}${NAMESPACE_SEPARATOR}${name}`);
  }
  console.log(`\npolicy-visible names (what gets stored): ${namespaced.join(", ")}`);

  if (!APPLY) {
    console.log(`\n(dry run — nothing written)`);
    console.log(`would create profile "${profileKey}" (defaultAction=deny, status=active)`);
    console.log(`would add include entries: ${namespaced.join(", ")}`);
    console.log(`would bind targetType=agent targetId=${agentId}`);
    console.log(`\nRe-run with --apply to write. Other agents and other tools are unaffected.`);
    process.exit(0);
  }

  const existing = await db.select().from(toolProfiles)
    .where(and(eq(toolProfiles.companyId, companyId), eq(toolProfiles.profileKey, profileKey)));
  const profile = existing[0] ?? await db.insert(toolProfiles).values({
    companyId,
    profileKey,
    name: `Tool grant — ${agent.name}`,
    description:
      `Permits specific plugin agent-tools for agent ${agent.name} (${agentId}). ` +
      "defaultAction is deny, so only the tool_name entries in this profile are allowed, " +
      "and only for agents named by a binding on it.",
    defaultAction: "deny",
    status: "active",
  }).returning().then((r) => r[0]!);

  const alreadyEntries = await db.select().from(toolProfileEntries)
    .where(and(eq(toolProfileEntries.companyId, companyId), eq(toolProfileEntries.profileId, profile.id)));
  // Clear out bare-name entries this script may have written before the namespacing fix.
  // They can never match ctx.toolName, so they are dead weight that makes a broken grant
  // look complete.
  const stale = alreadyEntries.filter((e) => e.toolName && bare.includes(e.toolName));
  for (const entry of stale) {
    await db.delete(toolProfileEntries).where(eq(toolProfileEntries.id, entry.id));
    console.log(`  – removed stale bare-name entry "${entry.toolName}"`);
  }
  const have = new Set(alreadyEntries.filter((e) => !stale.includes(e)).map((e) => e.toolName));
  const toAdd = namespaced.filter((name) => !have.has(name));
  if (toAdd.length) {
    await db.insert(toolProfileEntries).values(toAdd.map((toolName) => ({
      companyId, profileId: profile.id, selectorType: "tool_name" as const, effect: "include" as const, toolName,
    })));
  }

  const alreadyBound = await db.select().from(toolProfileBindings).where(and(
    eq(toolProfileBindings.companyId, companyId),
    eq(toolProfileBindings.profileId, profile.id),
    eq(toolProfileBindings.targetId, agentId),
  ));
  if (!alreadyBound.length) {
    await db.insert(toolProfileBindings).values({
      companyId, profileId: profile.id, targetType: "agent", targetId: agentId,
    });
  }

  console.log(`\n✓ profile ${profile.id} (${profile.defaultAction}/${profile.status})`);
  console.log(`✓ entries added: ${toAdd.length ? toAdd.join(", ") : "(already present)"}`);
  console.log(`✓ binding: ${alreadyBound.length ? "(already bound)" : `agent ${agentId}`}`);
  console.log(`\nOnly this agent gained only these tools. Verify with:`);
  console.log(`  GET /api/plugins/tools   (as that agent — should now list them)`);
  console.log(`Revoke with the same command plus --revoke --apply.`);
  process.exit(0);
}

main().catch((e) => {
  console.error("FAILED:", (e as Error)?.message || e);
  process.exit(1);
});
