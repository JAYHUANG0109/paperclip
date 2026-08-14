# `company_scope:read` audit — per-consumer verdicts

Context: `company_scope:read` is deliberately absent from `agentScopedVisibilityActions`
in `services/authorization.ts`. The human branch DENIES it to force per-item
filtering; agents skip that branch entirely, so an unpaired agent gets the
company-wide allow. This is the audit that comment asked for
("It belongs in this set once each consumer is checked").

Asymmetry being audited, per endpoint:
  non-privileged MEMBER -> company_scope:read = false
  unpaired AGENT        -> company_scope:read = true   <-- the gap

## Filters per item — SAFE

- `routes/activity.ts:163` — builds an explicit `{agentIds, responsibleUserId}`
  scope for non-privileged viewers; `company_scope:read` is only a "sees
  everything" shortcut, and each row still passes `issue:read`.
- `routes/attention.ts:84` — `keepIssue()` re-checks `issue:read` per item when
  `!companyScope.allowed`. Comment states it is scoped to the caller's own world
  for everyone, with no `scope=all` escape.
- `services/decision-queues.ts:317` — `visibleItems` resolves each item to its
  issue and asks `canReadDecisionSource`.
- `routes/companies.ts:171,210` — artifacts and timeline both narrow by
  `visibleAgentIds` / `canRead`.
- `routes/issues.ts:3939` — `filterIssues` applies per row.
- `routes/status-cards.ts:257` — `GET /status-cards/:id/dry-run` is a SINGLE
  named resource, not a list. Nothing to filter.
- `routes/issues.ts:7880` — POST (create), not a read.

## Boolean gate over an UNFILTERED list — LEAKS to unpaired agents

- `routes/execution-workspaces.ts:56`
  `GET /companies/:companyId/execution-workspaces` gates on the assert, then
  returns `svc.list(companyId, filters)` — every workspace in the company.
  Also guards `/workspace-overview` and three `:workspaceId` routes (those are
  single resources, so lower risk).

- `routes/approvals.ts:247`
  `GET /companies/:companyId/approvals` gates, then
  `svc.list(companyId, status)` — every approval in the company.

- `routes/costs.ts:84`
  SEVEN endpoints use `assertCompanyCostReadAllowed` (lines 182, 201, 210, 219,
  228, 237, 246) versus ONE that uses the per-issue variant (192). Company-wide
  spend, unfiltered.

- `routes/issues.ts:5297,5331`
  `GET /search` and `GET /search/extract` — needs a closer read; search results
  are the highest-value target of the three.

## Why the one-line fix does not work

Adding `company_scope:read` to `agentScopedVisibilityActions` makes an unpaired
agent's answer `false`, matching members. But these four consumers treat `false`
as 403 for the WHOLE endpoint, so the agent would lose sight of its own work
rather than be narrowed to it — exactly what the original comment warned about.

Each leaking consumer needs per-item filtering FIRST (the shape activity.ts and
attention.ts already use), and only then can the action join the scoped set.
Sequence matters: flip the flag first and you break agents; filter first and the
flip becomes a no-op safety net.

## Exposure today

Small but real. Unpaired agents are: 5 staff agents (never run, and they
auto-pair on first login) plus 3 infrastructure agents which are company-wide by
design. So nothing is currently exploiting it — but it is load-bearing the
moment a new agent is created without a joined user.
