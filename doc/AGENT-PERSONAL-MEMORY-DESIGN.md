# Auto personal wiki storage + memory per agent — design for review

**Goal:** every agent automatically gets its **own private wiki space** as durable
storage/memory — a place it reads at the start of relevant work and files learnings,
decisions, and context into, private by the (already-deployed) wiki space gate.

> STATUS: design for Jay's review. **No build until decisions below are made.**

## Why this sits cleanly on what we shipped
The deployed wiki gate already enforces `access_scope=personal` spaces: a space with
`owner_agent_id=<agent>` is visible only to that agent's viewer (and privileged admins).
So "auto personal memory per agent" = **auto-provision one personal space per agent +
teach the agent to use it** — no new access model, just provisioning + behavior.

## Design
- **Provisioner** (mirrors `seed-onboarding-game.ts`): for an agent, create a personal
  space — `slug: mem-<shortAgentId>`, `displayName: <agentName>｜私人記憶`,
  `access_scope=personal`, `owner_agent_id=<agent>`, folder skeleton bootstrapped.
  Dry-run/apply, idempotent, records `agent.metadata.personalSpace = {slug, spaceId}`.
- **Auto-trigger:** a hook on agent provisioning (new agents get one automatically) +
  a one-time **backfill** for existing agents (scope per decision #2).
- **Memory behavior** (a small skill / AGENTS.md rule): "You have a private wiki space
  `mem-<you>`. Read it before relevant work; file durable learnings / decisions /
  context there (not transient run logs). It is private to you." The agent uses the
  existing `wiki_read_page` / `wiki_write_page` / `wiki_update_index` tools against its
  own space.

## The important nuance — private from *users* vs private from *other agents*
The deployed gate injects a viewer for **board (user) getData/performAction** calls, so
a personal space is hidden from **other users** today. But **agent wiki tools**
(`wiki_read_page`, …) are currently **viewer-less / trusted** — so, as shipped, *any*
agent's tools could read *any* space, including another agent's personal space. That's
fine for "each agent has its own store, private from humans," but NOT "private from
other agents."

**Decision #3 (below):** if per-agent memory must be private from **other agents** too,
we additionally **gate agent tool execution** — inject the acting agent's viewer into
the tool path and `guardSpace` there (an extension of the deployed gate). If
"private-from-users" is enough for v1, we skip that and note it.

## Decisions needed (then I build)
1. **Relationship to `para-memory-files` (the existing agent memory dir):**
   **complement** (wiki space = richer, browsable, durable long-term; memory-dir = quick
   scratch) — *recommended* — or **unify** onto the wiki?
2. **Scope / rollout:** **validate on a few** (your agent + founder + 資訊部) then backfill
   all — *recommended* — or **all agents** immediately?
3. **Privacy level:** private-from-**users** only (v1, no tool gating) — *recommended for
   v1* — or also private-from-**other-agents** (adds agent-tool gating, a bigger change)?
4. **What goes in it:** freeform, or a light structure (e.g. `decisions.md`, `context.md`,
   `learnings.md`)? — I'd propose a light structure.

## Implementation phases (after decisions)
1. **Provisioner** — personal-space-per-agent (dry-run/apply, idempotent) + `agent.metadata.personalSpace`.
2. **Memory skill / AGENTS.md rule** — read-before / file-durable behavior.
3. **Auto-hook** — provision on new-agent creation (server), per scope.
4. *(only if decision #3 = yes)* **Agent-tool gate** — inject agent viewer into tool
   execution + `guardSpace`, with a deny-test for cross-agent access.
5. **Test on Jay's agent** end-to-end; then backfill per scope.

## Rollout / safety
Provisioner idempotent + reversible (archive the personal space + clear
`agent.metadata.personalSpace`). Flag-gated auto-hook. Tested on Jay first. No deploy
until the end-to-end test passes and you sign off; agent-tool gating (if chosen) ships
behind its own deny-test like the space gate did.
