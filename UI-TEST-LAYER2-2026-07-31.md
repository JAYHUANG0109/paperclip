# UI test suite — Layer 2 handover (2026-07-31)

Layer 1 (broken test infrastructure) is done and pushed. This document covers
what remains: **assertion drift**, where a test and its component genuinely
disagree about intended behaviour. These need a product decision, not a
mechanical fix, which is why they are listed rather than changed.

## Where the numbers stand

Measured on the pinned 40-file list (`common40.txt`) so the figure is
comparable to the pre-merge baseline.

| | files red | failing tests |
|---|---|---|
| pre-merge baseline (fork tag) | 39 of 40 | 143 |
| now | 37 of 40 | 139 |
| now, under `TZ=UTC` | 36 of 40 | 138 |

The count moved only a little, and that is expected: fixing a
`ReferenceError` does not remove a failing test, it lets the test *run* and
then fail on its real assertion. The qualitative change is what matters —
every remaining failure is now an honest disagreement, not a crashed helper.

**The important finding: this is almost entirely pre-existing fork rot, not
merge fallout.** Comparing each failing test file and its component against
both the fork tag and `upstream/master`, most pairs are fork-owned and
byte-identical on both sides — meaning the merge never touched them. Two
representative cases:

- `Secrets.test.ts` is byte-identical to the fork tag, yet imports
  `findCreateProviderReplacement`, which the fork's `Secrets.tsx` has never
  exported.
- `AgentDetail.instructions.test.tsx` is byte-identical to the fork tag, yet
  tests upstream's metadata-aware prose editor (#9332), which the fork's
  `AgentDetail.tsx` does not implement.

In both cases the fork had previously adopted an upstream *test* without the
corresponding *component*. That pattern, not the sync, is what produced the
143.

## What Layer 1 actually fixed

| fix | effect |
|---|---|
| `CompanySkills.test.tsx` — restored 2 dropped helper params, added `inputValue`/`selectValue` | 143 → 141 |
| `SidebarAgents.test.tsx` — `queryKeys` import + fake-timer-safe render helper | ReferenceErrors → real assertions |
| `AgentDetail.tsx` — ported `syncAgentRouteAfterRename` (its test always referenced it; never exported) | `AgentDetail.progress.test.ts` 6/6 green |
| `IssueDetail.test.tsx` — added `mockLocation`, `createIssueComment`, `queryKeys` + `createIssueDetailLocationState` imports | ReferenceErrors → real assertions |
| `SidebarServerInfo.tsx` — restored from upstream; added the `serverInfo` field the server already sends to the UI's `HealthStatus` | whole suite file recovered, 6/6 green |
| `Layout.test.tsx` — added the `NavLink` stub the router mock omitted | 4 uncaught `Element type is invalid` exceptions gone |
| `AgentDetail.tsx` — imported `QueryClient` as a type | last runtime-fatal `TS2304` in a page cleared |

Gates after this work: `pnpm build` exit 0; **zero** `TS2304/2552/2503/2686`
in UI source (the class that took the Inbox down); UI type errors 131 → 93.

## Layer 2, by category

Counts are per-file failure counts. Where I say "I can resolve this", I mean
without a product decision from you.

### A. Tests assert literal utility classes (~11 + part of 15)

`IssueRecoveryActionCard` (15, mixed), `MarkdownBody` (4), `IssueRow` (2),
`IssueFiltersPopover` (1), `IssueDocumentAnnotations` (1), `ArtifactCard` (1),
`MarkdownListStyles` (1), `ui-font-assets` (1)

Example: expected `text-xs`, received `break-words font-mono text-[11px]
text-foreground/80`. Another expects `z-(--z-…)` where the component has
`z-[60]`.

These look like fallout from the fork's own design-token migration — the repo
carries `token-auditor` / `codemod-runner` agents and a `doc/design/` tree, and
the tests encode the *pre*-migration class names. Both test and component are
fork-owned and unchanged by the merge.

**My read: the tests are stale.** Asserting on exact utility strings is
brittle by nature. Cheapest correct fix is to update these assertions to the
current classes, or better, assert on rendered behaviour instead.
**What I need from you:** confirmation that the current classes (the
`--sz-*` / `--z-*` / `text-(length:--text-*)` token style) are the intended
direction. If yes, I can do this whole category.

### B. Navigation and route inventory (~38)

`Search` (9), `Layout` (9), `CompanySkills` (8), `Sidebar` (7),
`CommandPalette` (3), `InstanceExperimentalSettings` (1), `App` (1)

The tests expect nav entries and routes that the fork does not render:
`Projects` missing from the sidebar list, `Apps sidebar` and
`Company settings sidebar` absent from `Layout`, and `/skills/studio`,
`/pipelines`, `/goals`, `/apps` all resolving to `undefined` in
`CompanySkills`. `InstanceExperimentalSettings` expects an
`Enable Environments` toggle that isn't there.

**This one is genuinely yours to call** — it is the question of which
navigation surface the product is supposed to have. Note the overlap with the
deferred experimental-flag-gating item: several of these may be intentionally
flag-gated off, in which case the tests need to enable the flag rather than the
nav needing to change.

### C. Test can no longer drive the UI (~16)

`NewIssueDialog` (11), `IssuesList` (4), `FolderControls` (1)

All fail as `expected "vi.fn()" to be called with arguments: ['company-1', …]`
with **`Number of calls: 0`** — the API is never invoked. I checked
`NewIssueDialog`: the submit button is found and is enabled, the click
dispatches, and `issuesApi.create` still never fires. So something between the
click and the mutation now short-circuits (validation, or a different mutation
path).

**I can resolve this** — it is objective, no product judgement needed. It is
just per-file debugging rather than one shared root cause, so it is the most
time-consuming category.

### D. Upstream features the fork did not adopt (~24)

| file | n | the feature |
|---|---|---|
| `RunTranscriptView` | 7 | acpx tool-call folding — repeated `tool_call` status updates for one `toolUseId` collapsing into a single block |
| `Secrets` | 5 | per-vault provider configs: a 4th `providerConfig` param on `getCreateProviderBlockReason`, plus `getSelectableProviderConfig` and `findCreateProviderReplacement` |
| `AgentDetail.instructions` | 4 | #9332 metadata-aware prose editor: `shouldUseMarkdownInstructionsEditor` honours server `markdown: true` for extensionless files; also prose styling (`leading-7`) instead of `font-mono` |
| `IssueRunLedger` | 4 | unmanaged-run labelling |
| `ActivityCharts` | 2 | per-error-reason breakdown (`provider_quota: 1`) |
| `RunWorkspaceRecoverySurface` | 2 | recovery surface elements absent |

For each: **adopt the upstream feature, or delete the orphaned test.** Adopting
`Secrets` and `AgentDetail.instructions` means real behaviour changes to live
pages, so I would not do either without you saying so. Deleting is safe but
loses the coverage.

**My recommendation:** delete the orphaned tests for now and file the features
as separate work. Carrying red tests that describe unimplemented behaviour is
worse than not having them, because it trains everyone to ignore the suite —
which is precisely how the Inbox `TS2304` stayed hidden in a 200-error
baseline.

### E. Behaviour and data differences (~37)

`SidebarAgents` (10, ordering — `expected 'Alpha' to be 'Bravo'`),
`IssueDetail` (6), `IssueColumns` (5), `IssueProperties` (3), `Inbox` (3,
archive flags `[undefined,…]` vs `[true,…]`), `Projects` (2, sort order —
`expected 103 to be less than -1`), `IssueDocumentsSection` (2),
`adapter-display-registry` (2, `'Codex (local)'` vs `'Codex'`),
`IssueThreadInteractionCard` (1), `IssueChatThread` (1),
`IssueAttachmentsSection` (1), `AgentConfigForm` (1)

Mixed bag; each needs reading on its own. **The ordering and sort ones
(`SidebarAgents`, `Projects`, `Inbox`) are worth looking at first** — those are
the shapes most likely to be a live bug a user would actually notice, rather
than drift.

### F. Environment-dependent (1)

`lib/attention.test.ts` — `attentionDateBucket` uses `setHours(0,0,0,0)`
(local midnight) while the test's fixtures are UTC instants. Passes under
`TZ=UTC`, fails under this machine's `CST+0800`.

**Not drift and not a fork bug.** Fix is to pin `TZ` in the vitest config so
the suite is reproducible across machines — worth doing regardless, since it
otherwise fails differently on your M4 MacBook than in CI. I can do this.

## Suggested order

1. **F** — pin `TZ`, one line, removes an environment-dependent failure. (mine)
2. **C** — 16 failures, objective, no decisions needed. (mine)
3. **A** — 11+, needs one confirmation from you about the token direction.
4. **D** — needs your adopt-or-delete call per feature; my recommendation is delete-and-file.
5. **E** — needs per-case reading; I would start with the ordering/sort ones as possible live bugs.
6. **B** — needs your call on the intended navigation surface.
