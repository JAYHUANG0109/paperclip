# Upstream sync 2026-07-30 — decisions & state

Merging `upstream/master` (paperclipai/paperclip) into the fork.

| | |
|---|---|
| Merge base | `5d42382df` (2026-07-16) |
| Upstream commits taken | 186 |
| Fork commits ahead | 489 |
| Branch | `sync/upstream-2026-07-30` |
| Worktree | `../paperclip-sync` (isolated; main tree untouched) |
| Safety tag | `pre-upstream-sync-2026-07-30` → `8fb4cd3b1` |
| DB backup | `~/paperclip-presync-2026-07-30/paperclip-20260730-145836.sql.gz` (45 MB, gzip-verified) |
| Conflicts | 53 total |

---

## 1. The migration hazard (fixed)

`drizzle-orm@0.45.2`'s pg migrator uses a **single high-water-mark**, read once before the
apply loop. Hashes are never compared. Any migration whose journal `when` is `<=`
`max(created_at)` in `drizzle.__drizzle_migrations` is **silently skipped** — migrate still
exits 0.

### The mark is a moving target — the fork keeps raising it

First measurement was `1784241826838`, at which only `0180`/`0181` fell below. Partway
through this work a concurrent session landed **`9023_routine_sharing` with
`when = 1785420000000`** and applied it. That single value is **above upstream's entire new
range** (`0195` = `1785170000001`), so the mark jumped and **all 18** upstream migrations
fell below it:

| | mark | upstream migrations that would silently skip |
|---|---|---|
| before `9023` | 1784241826838 | 2 (`0180`, `0181`) |
| after `9023` | **1785420000000** | **all 18** |

The merge would have deployed, `migrate` would have exited 0, and none of upstream's new
tables would exist — status cards, summary slots, decision training, connections v3,
document memberships, the built-in-agent unique index, company skill releases.

**All 18 restamped to `1785420001000`–`1785420018000`**, spaced 1s apart, relative order
preserved. The rebuild script now takes the mark as an argument (measured from the DB, never
inferred from the journal) and restamps *every* incoming entry at or below it, so it cannot
go stale again.

**⚠️ Structural hazard, not a one-off:** any fork migration stamped with a far-future `when`
poisons the mark for every future upstream migration. The `9xxx` filename namespace solved
collisions but created this timestamp trap. Fork migrations should be stamped just above the
previous fork migration, not at an arbitrary future date — and every sync must re-measure
the mark and restamp.

`_journal.json` was rebuilt programmatically: union of both sides (198 ours + 18 new = 216),
sorted lexicographically by tag (required by `check-migration-numbering.ts`), `idx`
renumbered sequentially, boundary `0195 → 9001` verified. Both repo guards pass:

```
check-migration-numbering  → PASS
check-migration-safety     → passed, 20 historical findings covered by baseline
```

**Baseline audit before merging:** all 14 tables and 22 columns created by our `9001–9022`
migrations exist in the live DB. Fork schema was intact; nothing to repair.

Note: journal `when` values were restamped by some earlier merge, so ledger rows no longer
correspond to journal entries (46 orphan rows, 44 entries with no row). Harmless given the
mark-only algorithm, but **always read the mark from the DB, never infer it from the journal.**

## 2. Transport rename — `remote_http` → `mcp_remote`

Upstream renamed the tool-connection transport and added `rest_api`:

```
ours:     "remote_http" | "local_stdio"
upstream: "mcp_remote" | "rest_api" | "local_stdio"
```

Migration `0182` renames the DB values and adds a `CHECK` constraint. Verified against live
data: 3 rows, all `remote_http` → `mcp_remote`, all satisfy the new constraint. Fork code
references updated in `tool-access.ts`. Remaining tree hits for `remote_http` are unrelated
identifiers (`mcp_remote_http` providerType, `remote_http_*` error codes) and release notes.

## 3. `SidebarAgents.tsx` contained raw NUL bytes

The fork wrote its subteam key separator as a **literal NUL byte** rather than the `\0`
escape:

```js
const SUBTEAM_SEP = "\0"; // separates top\0sub in a nested folder's collapse key
```

Git therefore classified the file as **binary** and produced no conflict markers at all —
it silently left our version in place. Converted both bytes to the two-character escape
(identical value), then ran a real 3-way merge. The file is now text-mergeable permanently.

## 4. Silent duplicate members from auto-merge (crashed the compiler)

The highest-value thing the typecheck gate caught. When both sides add a member with
the same name at **different offsets** in the same interface or object literal, git
auto-merges both without reporting a conflict. The result:

- in an `interface` — an accidental *overload set* (legal TS, silently wrong)
- in an object literal — a duplicate property
- together — TS 5.9 aborts with an internal assertion rather than a diagnostic:
  `Debug Failure. Parameter symbol already has a cached type which differs from newly
  assigned type`, thrown from `assignContextualParameterTypes`

Concretely, `respondInteraction` ended up declared **twice** in `PluginIssuesClient`
(the fork's params-object form + upstream's 4-positional-arg form) and implemented twice
in both `testing.ts`'s mock and `worker-rpc-host.ts`'s client. Bisecting showed the crash
required *both* the merged `types.ts` and the merged `testing.ts`.

Resolved by unifying on one signature — a single named `PluginRespondInteractionParams`
params object carrying both sides' fields — and deleting the duplicate declarations and
implementations. Same treatment for `PluginCreateCommentOptions`.

**Lesson for future syncs:** a clean `git merge` says nothing about duplicate members.
Only a per-package `tsc` run finds them, and a crash (not an error) is a likely symptom.

### Recovery note

While isolating the crash I ran `git checkout upstream/master -- packages/plugins/sdk/src`,
which updates **the index as well as the working tree** — silently discarding the merged
state for that directory. Fork-only `PluginWebhookResponse` disappeared from
`define-plugin.ts` as a result. Recovered by reconstructing the 3-way merge for
`define-plugin.ts` and `index.ts` with `git merge-file` (base `5d42382df`, ours
`8fb4cd3b1`, theirs `upstream/master`); both merged cleanly with no conflicts, and the
fork-only type is back. Verified only those two files were affected.

## 5. Pipelines: restored in full (decision 2026-07-30)

**Decision: keep the feature.** The fork's Pipelines UI was half-deleted; upstream has every
missing piece, so it was restored rather than removed.

The fork had deleted 17 UI files while keeping `Pipelines.tsx`, `PipelineSettings.tsx`,
`PipelineStageHistoryPanel.tsx`, `PipelineItemBodyDocument.tsx` and the entire backend. A
merge keeps "deleted by us" deleted, so those 17 stayed missing and `Pipelines.tsx` read as
an orphan with ~48 unresolvable-module errors. Restored from upstream:

```
api/pipelines.ts · PipelineHealthWarnings · PipelineLivenessBanner
PipelineWorkReferences · PipelinesExperimentalGate (+test) · StageSecretsPanel
lib/pipeline-{breakdown,item-detail,learnings,liveness,references,stage-presentation}
lib/project-workspace-defaults · hooks/useStandardMarkdownMentionOptions
pages/Pipelines.test.tsx · pages/PipelineSettings.test.ts
```

Verified: every local import in all five Pipeline components resolves, and none of the
restored files introduce further missing dependencies. (`PipelinesExperimentalGate` was
among the missing files and is referenced by upstream's `App.tsx` — so removing Pipelines
would have required editing `App.tsx` too.)

**Runtime state on this instance — fully dormant:** `enablePipelines` is unset (false; no
experimental flag is true at all), all 10 tables have 0 rows, the UI gate redirects to
`/dashboard`, and no heartbeat/timer/watchdog invokes the pipelines service. Automations
(`onEnter: {type:"run_routine"}`) only fire on a stage transition, which needs a case.

### Follow-up: the pipeline API is not gated

`server/src/app.ts:417` mounts `pipelineRoutes(db)` **unconditionally** — 51 endpoints with
`assertCompanyAccess` but **zero** `enablePipelines` checks. The UI is gated; the API is
not. An authenticated user or agent could create a pipeline via the API with the flag off,
and its `onEnter` automations would then fire routines for real. Pre-existing, not caused by
this merge, but it is the one path by which "dormant" stops being true. Worth gating
server-side to match the UI.

## 6. Pipelines was never deliberately removed

`PipelineSettings.tsx` (3,418 lines) was dropped as collateral damage in the **2026-07-17**
merge (`b8ea90621`), whose own commit body flagged "Pre-existing fork breakage (half-deleted
Pipelines feature)". Everything else survived: 10 migrations, all 10 tables in the live DB
(0 rows), schema/service/routes/CLI, `pipelineRoutes` still mounted in `app.ts`, and the
rest of the Pipelines UI. **Restored from upstream** in this merge.

---

## Resolution decisions

### Plugin SDK contract — `actorUserId` vs `authorUserEmail` (6 files)
Upstream replaced the fork's `authorUserEmail` with `actorUserId`. **Unioned rather than
picked.** `actorUserId` is primary (host re-verifies active human membership, never trusts
plugin-supplied identity); `authorUserEmail` remains the documented fallback for the Google
Chat connector, which only ever holds a sender email. Precedence documented at each site:

- `createComment`: `actorUserId` → `authorUserEmail` → `authorAgentId`; unresolvable email
  degrades to the plugin system actor so relaying never fails.
- `respondInteraction`: `actorUserId` → `responderEmail`; an unresolvable responder is
  **refused** (a decision must be attributable to a real member).

### `respondInteraction` host implementation
Upstream re-engineered it (membership re-verification, idempotent replay, continuation-issue
handling). Took upstream's skeleton and patched the fork's paths back in: the `answer`
branch via `interactions.answerQuestions`, and `selectedOptionIds`/`selectedClientKeys`
carried into `acceptInteraction`. Normalised `decision = params.action ?? params.decision`.

Safe because the Google Chat plugin calls it 6 times and **never reads the return value**,
so upstream's changed result type (`{ok,status}` → `{interaction,applied}`) costs nothing.

### `plugin-worker-manager.ts` — hardening restored
The fork had deliberately disabled upstream's scope hardening ("Safe for single-tenant
deployments only. Revert when plugins are updated to carry invocation ids"). Upstream's new
proactive-company-scope resolution (LOOA-695, #10113/#10103) is exactly that fix. **Took
upstream**, removing the fork hack.

### `App.tsx` — architectural conflict, fork architecture kept
Upstream eagerly imports ~70 page modules; the fork code-splits **77** of them through a
`lazyPage()` helper (route-split perf win, commit `6b2262cbc`). Kept the fork's
architecture and added upstream's new routes on top of it:

- 2 gates imported eagerly (`PipelinesExperimentalGate`, `StatusCardsExperimentalGate`) —
  small and always evaluated, matching how the fork treats its other gates.
- 9 new `lazyPage()` consts so upstream's new routes stay code-split:
  `Pipelines`, `PipelineItemDetail`, `PipelineItemLegacyRedirect`, `ReviewQueue`,
  `Learnings` (five named exports off `./pages/Pipelines`), `PipelineSettings`,
  `StatusCards`, `TrainingLibrary`, `TrainingInspector`.
- Upstream's 4 route-block hunks taken verbatim (they were pure additions: cases, status
  cards + legacy redirects, review-queue, pipelines, training).
- `useActiveCompanyPrefix` added to the router import.

Verified all 15 components referenced by the new route blocks are declared, and every
local import in the file resolves. `StatusCardsLegacyRedirect` and `LegacyTrainingRedirect`
were already present via auto-merge.

### Other notable calls
- **`agent-config-primitives.tsx`** — kept the fork's i18n `Proxy` for help text (upstream
  hardcodes English). Added upstream's new `secretAccess` key to `HELP_KEYS` plus `en.json`
  and `zh-TW.json` translations, so both locales stay at 41 keys.
- **`routes/issues.ts`** — dropped the fork's local `GENERIC_ATTACHMENT_CONTENT_TYPES`; it
  is now imported (upstream extracted it), so keeping ours would be a redeclaration. Kept
  the fork's `decodeMultipartFilename` (UTF-8 multipart filename repair).
- **`Search.tsx`** — took upstream's search-parser block and removed the fork's duplicate
  `agents` query (functionally identical: same key, fn, enabled).
- **`SidebarAgents.tsx`** — kept the fork's row structure (hunks 1–2); upstream's
  `SidebarNavItem` chrome refactor deferred (see follow-ups). Adopted upstream's
  shared/leader-elected live-runs polling (hunk 3) and wired `usePublishSharedQueryData`.
- **`index.ts`** — kept the fork's `{ app, toolGateway }` destructuring (our `createApp`
  returns the gateway; upstream's returns `app`) and added upstream's
  `managedPluginAutoInstall`.
- **`main.tsx`** — kept both: upstream's React 19.2 perf-measure reaper and the fork's
  service-worker unregistration.
- **`IssueMonitorActivityCard.tsx`** — accepted upstream's deletion; replaced by
  `IssueMonitorBanner` (#9783). Ours was referenced only by its own test.
- **`pnpm-lock.yaml`** — regenerated from upstream's rather than hand-merged (38 hunks).
  Verified `overrides` (lexical pinned 0.46.0) and both `patchedDependencies`
  (`embedded-postgres`, `acpx`) survived, and fork-only `fflate` is retained.

---

## UI resolution strategy: fork wins on conflicted regions

53 conflicts total. The server/infra tier was merged hunk-by-hunk (see above). For the UI,
after resolving `App.tsx`, `IssueRow`, `IssuesList` and `Sidebar` in detail, the remaining
pages turned out to be **page-level restructures**, not mergeable hunks:

| File | Why it isn't a hunk merge |
|---|---|
| `Secrets.tsx` | 32 hunks; upstream rewrote the page, fork changed 2,319 lines of it |
| `IssueDetail.tsx` | 10 hunks straddling JSX boundaries |
| `Agents.tsx` | one hunk is ours=4 lines vs upstream=158 (whole `renderAgentRow`) |
| `RoutineDetail.tsx` | upstream restructured around sections (`SECTION_TITLES`, `RoutineSectionKey`) |
| `AgentDetail.tsx` | upstream swapped to `AgentActionButtons` + built-in panels |
| `Inbox.tsx` | shares the tree-guide/keyboard-nav rework |
| `Search.tsx`, `IssuesList.tsx` | upstream blocks reference fork-absent helpers |

**Decision: the fork's complete file wins for those.** Rationale: they are the live
platform's current, working UI. Hunk-level side-picking across JSX produced unbalanced tags
and undefined identifiers (14 errors in `Search.tsx` alone) — proof that partial adoption is
unsafe here. Taking the fork's whole file is internally consistent by construction.

This costs nothing on the server side: only 53 of 770 upstream-changed files conflicted, so
**717 files of upstream work merged cleanly**, including every migration, service, adapter
and plugin change.

### Deferred upstream UI work (revisit deliberately)
- Secrets page rewrite; `IssueDetail` refactor; `Agents` built-in lifecycle chips +
  environment column; `RoutineDetail` section navigation; `AgentDetail` built-in bundle
  panel; `Inbox`/`IssuesList` keyboard navigation and nested tree guides.
- `IssueRow` **did** gain upstream's `treeGuides`/`chevronInGuide`/`hideDivider` props (all
  optional, defaulted off), so the capability is present but inert until `IssuesList`/`Inbox`
  pass them.
- `IssueThreadInteractionCard`: reverted to fork's version, so upstream's interaction
  *withdrawal* and *expiry* display states are not adopted. Their i18n keys were never added.
- Two small additive exports were needed for upstream files to link:
  `AdapterTypeDropdown` and `ModelDropdown` in `AgentConfigForm.tsx` (upstream exports both;
  the fork had them module-private, which broke `ConfigureBuiltInAgentModal`).
- `IssueMonitorActivityCard` restored: upstream deleted it in favour of `IssueMonitorBanner`,
  but the fork's `IssueDetail.tsx` still imports it. **The build caught this; typecheck did
  not.** Always run `pnpm build`, not just `tsc`.

## Follow-ups (deliberately not done here)

1. **`Workspaces.test.tsx`** — we deleted it, upstream modified it. Kept deleted to avoid a
   test written against a component that has diverged 216 lines. **Lost coverage; restore
   deliberately.**
2. **`SidebarAgents.tsx`** — upstream's `SidebarNavItem` chrome refactor (C11 in their
   DECISION-SHEET) not adopted; would require porting `usePeekLock`, `displayAgentName`,
   `BudgetSidebarMarker` and 12 i18n keys into the new structure.
3. **Pipelines** — restored, but the feature is gated behind `PipelinesExperimentalGate` and
   all 10 tables are empty. Decide whether to use it or remove it properly.
4. **`9023_routine_sharing`** — a concurrent session was mid-feature on routine sharing with
   an uncommitted migration `9023` and a modified `_journal.json`. **Must be re-added to the
   rebuilt journal** (next free `9xxx`, `when` above the live mark) once that work lands.

## Verification done

**Typecheck gate — all 31 non-UI packages clean (0 errors, 0 crashes):** `shared`, `db`,
`plugin-sdk`, `server`, `cli`, all 11 adapters, all plugins including
`paperclip-plugin-google-chat` (the key consumer of the changed `respondInteraction`
signature — its 6 call sites still compile because none read the return value),
`adapter-utils`, `mcp-server`, catalogs and examples.

Migration guards: `check-migration-numbering` PASS, `check-migration-safety` PASS.

**DB rehearsal — PASS.** Two scratch databases on the live cluster (dropped afterwards):

- **A / fresh**: empty DB + the merged migration set → the intended schema.
- **B / rehearsed production**: pre-merge migration set applied, then the ledger's
  `created_at` values overwritten with the **live** ones so the high-water-mark is
  byte-identical to production (`1785420000000`), then the merged set applied.

Data is irrelevant to this hazard — drizzle compares only `max(created_at)` — so this
rehearses the exact mechanism without restoring the 45 MB dump.

```
pre-merge applied: 198 (mark 1784241826832)
ledger forced to live values, mark now 1785420000000
after merged set:  218 rows (applied 18 new)   <- all 18, none skipped

SCHEMA DIFF  fresh  vs  rehearsed-production
  tables      : IDENTICAL (173)
  columns     : IDENTICAL (2503)
  indexes     : IDENTICAL (777)
  constraints : IDENTICAL
PASS — production will converge to the intended schema.
```

This is the check that caught the `9023` regression. Re-run it (`scratchpad/db-verify.mjs`)
after any change to the journal, and re-measure the mark first.

## Verification still owed

- UI typecheck (24 conflicts still open there)
- full test suite in the worktree
- fresh-DB apply + schema diff vs current production schema
- restore-from-backup rehearsal reproducing the real high-water-mark
- re-sync latest `main` (it moved 3× during this work) before merging
