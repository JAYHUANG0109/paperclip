# `company_scope:read` audit — per-consumer verdicts

> **STATUS: CLOSED.** All four leaking consumers were handled and
> `company_scope:read` now sits in `agentScopedVisibilityActions`, so an unpaired
> agent is refused the company-wide shortcut exactly as a non-privileged member
> already was. What follows is the audit that made that safe; the resolution of
> each item is recorded inline below.

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

## Boolean gate over an UNFILTERED list — LEAKED, now resolved

- `routes/execution-workspaces.ts:56` — **FIXED by narrowing.** The list no
  longer gates on this action; it filters per item on `project:read`, memoised
  per project. Summary mode stays one query for company-scoped callers, since
  `ExecutionWorkspaceSummary` omits `projectId` and resolving it is only needed
  when narrowing actually happens. The `:workspaceId` routes keep the gate — one
  named resource has nothing to narrow.

- `routes/approvals.ts:247` — **FIXED by narrowing.** Approvals carry no issue
  or project, so the per-item question is the REQUESTER: an approval raised by an
  agent in your world, or by you. Anything tied to neither fails closed.

- `routes/costs.ts:84` — **FIXED by denial, deliberately not narrowing.** All
  seven are AGGREGATES (summary, by-agent, by-provider, by-biller, finance-*),
  and you cannot filter a total per item. Company-wide spend is a privileged
  view: members are already refused, and an agent has no stronger claim. Closing
  the flag makes agents match members; the endpoints needed no change.

- `routes/issues.ts:5297,5331` — **FIXED by denial.** Both already 403 a caller
  without the company-wide answer, and both are explicitly company-WIDE search.
  Members are refused outright, so refusing agents is consistent rather than a
  new restriction.

## Why the one-line fix could not come first

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
