# Per-user wiki space access — enforcement plan

**Goal:** make LLM-Wiki spaces respect `access_scope` (shared / personal / team) so a
`personal` space is visible only to its owner (user or agent), a `team` space only to
team members, and `shared` to everyone — with owner/admin/instance-admin able to see all
(the same model as skill folders).

**Status (this branch):**
- ✅ Pure decision primitive: `spaceScopeVisible` / `assertSpaceAccess` in
  `packages/plugins/plugin-llm-wiki/src/wiki/access.ts`, unit-tested
  (`tests/access.spec.ts`, 9 cases incl. fail-closed). **Not yet wired** — enforcement
  is inert until the steps below land.
- ⛔ Enforcement NOT active yet. Today the plugin does **zero** per-actor checks: a
  `personal` space is visible to everyone who can open the wiki. Do not describe spaces
  as private until Step 4 ships.

## Why it's more than "add a filter" — two structural prerequisites

1. **The read transport carries no actor.** All wiki reads are registered via
   `ctx.data.register` (getData). The SDK's `handleGetData`
   (`packages/plugins/sdk/src/worker-rpc-host.ts:1615`) and the host
   (`server/src/routes/plugins.ts:1381`, `:1567`) pass **no actor** to getData — only
   `{key, companyId, params}`. Reads (`spaces`, `pages`, `page-content`, `sources`,
   `operations`, `settings`, `distillation-*`, …) therefore cannot be gated without
   threading an actor through getData.
2. **Privilege info isn't in the plugin actor.** `isPrivilegedMemberViewer`
   (`server/src/routes/authz.ts:151`) needs `req.actor.memberships` / `isInstanceAdmin` /
   `source`. The SDK actor context (`PluginPerformActionActorContext` protocol.ts:397;
   `PluginApiRequestInput.actor` define-plugin.ts:142) carries only
   `type/userId/agentId/runId/companyId` — no role, no instance-admin flag.

**Decision needed (sign-off):** resolve the viewer **host-side** in `plugins.ts` for all
four transports and thread `{ userId, agentId, isPrivileged, teams }` into the worker —
including a new actor arg on the getData path. (Alternative: extend the SDK actor context
with role + instance-admin. Host-side resolution is preferred — it mirrors
`server/src/routes/folders.ts:33 resolveViewer` and keeps privilege logic where `req` lives.)
This touches the shared plugin SDK, so it affects all plugins — review before merge.

## Sequenced steps

**Step 1 — record ownership on create (safe, additive).**
`createSpace` (core.ts:1409) currently sets `access_scope` but never `owner_user_id`/
`owner_agent_id`. Thread the performAction actor (2nd handler arg,
`PluginPerformActionContext.actor`, already delivered per worker-rpc-host.ts:1652) into the
`create-space` action (worker.ts) and INSERT `owner_user_id`/`owner_agent_id`. No
enforcement yet → no leak risk. Backfill: existing personal/team spaces (none today) would
need an owner set.

**Step 2 — host-side viewer resolution + threading.**
In `server/src/routes/plugins.ts`, for performAction, getData, onApiRequest, and tool
execution, compute `{ userId, agentId, isPrivileged, teams }` (reuse
`isPrivilegedMemberViewer` + `skillSvc.getUserTeams`, exactly like `routes/folders.ts`).
Extend the getData transport (worker-rpc-host.ts + protocol) to carry it. For agents,
resolve the backing user via the run's `responsibleUserId`
(`server/src/services/tool-access.ts:1508`) and/or `agent_memberships`; agent-owned spaces
match on `ownerAgentId` directly.

**Step 3 — enforce at the chokepoint.**
Give `resolveSpace`/`resolveSpaceAnyStatus` (core.ts:1355/1374) an actor param and call
`assertSpaceAccess(space, viewer)` there — this covers ~35 call sites (write-page,
read-page, sources, operations, query, tools, distillation, etc.) in one place. Update the
signature + all call sites to pass the threaded viewer.

**Step 4 — filter the list + guard the direct reads that bypass resolveSpace.**
`listSpaces` (core.ts:1393) queries the table directly — rewrite as a filtered query
(`access_scope='shared' OR owner_user_id=:u OR owner_agent_id=:a OR team_key IN :teams`,
plus privileged short-circuit). Audit the getData read handlers that read a space without
`resolveSpace` and add explicit `assertSpaceAccess`.

**Step 5 — leave system paths system.**
The event-ingestion path (`handlePaperclipEventIngestion` core.ts:3735, from
`ctx.events.on`) has no HTTP actor and must remain a trusted/system path — do **not** gate
it on a user viewer.

**Step 6 — UI.**
`src/ui/app.tsx` already has the shared/personal/team scope selector on create; split the
sidebar into "shared" vs "my private" driven by the now-filtered `listSpaces`.

**Step 7 — tests.** Mirror the skill-folder ACL tests: member sees shared + own only;
direct-by-slug/id access denied for non-owner; agent → backing-user resolution; privileged
short-circuit; team membership. (`tests/access.spec.ts` already covers the pure decision.)

## Files (from the surface map)
- Primitive: `packages/plugins/plugin-llm-wiki/src/wiki/access.ts` (+ `tests/access.spec.ts`)
- Core: `packages/plugins/plugin-llm-wiki/src/wiki/core.ts` (`resolveSpace` 1355, `listSpaces` 1393, `createSpace` 1409, ~35 space-scoped fns)
- Worker: `packages/plugins/plugin-llm-wiki/src/worker.ts` (thread actor into actions/data/tools)
- Host: `server/src/routes/plugins.ts` (viewer resolution for 4 transports)
- SDK: `packages/plugins/sdk/src/{protocol.ts,worker-rpc-host.ts,define-plugin.ts}` (getData actor)
- Reuse: `server/src/routes/authz.ts` (`isPrivilegedMemberViewer`), `server/src/services/folders.ts` (`folderScopeVisible`), `server/src/routes/folders.ts` (`resolveViewer`)
- Agent→user: `server/src/services/tool-access.ts:1508` (`responsibleUserId`), `agent_memberships`

## Risk
The failure mode is a **partial** gate (a read path left ungated) → a "private" space that
leaks, exactly like the founder 送批閱 incident. Because reads are the transport with the
actor gap, Step 4's audit is the load-bearing one. Do not enable personal spaces in the UI
as "private" until Steps 2–4 are complete and tested.
