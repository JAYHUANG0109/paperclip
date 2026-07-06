# Company Skills Workflow

Use this reference when a board user, CEO, or manager asks you to find a skill, install it into the company library, or assign it to an agent.

## What Exists

- App-shipped catalog: a curated set of company skills in `@paperclipai/skills-catalog`, browseable and installable without leaving Paperclip.
- Company skill library: install, inspect, update, audit, reset, and read company skills for the whole company.
- Agent skill assignment: add or remove company skills on an existing agent.
- Hire/create composition: pass `desiredSkills` when creating or hiring an agent so the same assignment model applies immediately.

The canonical model is:

1. add the skill to the company library — either from the app catalog (`skills install`), an external source (`skills import`), or a managed local skill (`skills create`/`skills scan-projects`)
2. attach the company skill to the agent (`skills agent sync`)
3. optionally do step 2 during hire/create with `desiredSkills`

Catalog install ≠ agent attach. Installing a catalog skill only adds the row to
`company_skills`. The agent will not use it until you sync the agent's desired
set.

## Authoring a brand-new skill — create it MANAGED, not a loose file

When someone asks you to "make this into a skill" / 「把它做成一個技能」, register it
as a **managed company skill** via the API. Do **NOT** just write a `SKILL.md`
into the local Claude skills home (`~/.claude/skills/<slug>/`). A loose local file
becomes an **unmanaged** skill: it has no `company_skills` row, so it can't be
viewed in the dashboard (no 檢視), isn't versioned, and — critically — **can't be
distributed to a team** (the distribute endpoint resolves company skills only).

Create it managed instead:

```sh
curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/skills" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "photo-rename",
    "description": "整理雜亂照片檔名成 YYYYMMDD_班級_活動_序號 …（此描述即自動觸發條件）",
    "markdown": "---\nname: photo-rename\ndescription: …\n---\n\n# …完整 SKILL.md 內文…",
    "equipOnCreate": true
  }'
```

- `markdown` is the **entire** SKILL.md — YAML frontmatter (`name` + a sharp
  `description`, which is what auto-triggers the skill later) followed by the body.
- `equipOnCreate: true` auto-equips it to you (the author) so you can use it right
  away.
- The result is a `company_skills` row: it shows 檢視 in the dashboard, carries
  versions, and can be handed to a team with `/skills/distribute` (below).

If a skill already exists only as an unmanaged local file, re-create it managed
with the same steps (its `markdown` is the local `SKILL.md`'s content).

## Permission Model

- Company skill reads: any same-company actor
- Company skill mutations: board, a human/agent principal with an explicit `skills:create` grant, or an agent whose `canCreateSkills` permission is enabled. `canCreateSkills` defaults on for agents unless explicitly disabled.
- Agent skill assignment: same permission model as updating that agent
- Team installs continue to require `agents:create` because they import or create agents in addition to attaching skills.

## Core Endpoints

App-shipped catalog (read-only browse + company install):

- `GET /api/skills/catalog`
- `GET /api/skills/catalog/:catalogId`
- `GET /api/skills/catalog/ref?ref=<id|key|slug>`
- `GET /api/skills/catalog/:catalogId/files?path=SKILL.md`
- `POST /api/companies/:companyId/skills/install-catalog`

Company library:

- `GET /api/companies/:companyId/skills`
- `GET /api/companies/:companyId/skills/:skillId`
- `GET /api/companies/:companyId/skills/:skillId/files?path=SKILL.md`
- `POST /api/companies/:companyId/skills` (managed local create)
- `POST /api/companies/:companyId/skills/import`
- `POST /api/companies/:companyId/skills/scan-projects`
- `GET /api/companies/:companyId/skills/:skillId/update-status`
- `POST /api/companies/:companyId/skills/:skillId/install-update`
- `POST /api/companies/:companyId/skills/:skillId/audit`
- `POST /api/companies/:companyId/skills/:skillId/reset`
- `DELETE /api/companies/:companyId/skills/:skillId`

Agent attach and hire/create composition:

- `GET /api/agents/:agentId/skills`
- `POST /api/agents/:agentId/skills/sync`
- `POST /api/companies/:companyId/agent-hires`
- `POST /api/companies/:companyId/agents`

If a board user, CEO, or manager is driving locally, prefer the
`paperclipai skills` CLI documented in `doc/CLI.md` — it wraps every endpoint
above, accepts company skill or catalog refs by `id`/`key`/`slug`, and prints
the same JSON these endpoints return when called with `--json`.

## Install A Skill Into The Company

Two paths cover the common cases:

1. **App-shipped catalog** (preferred when the right skill exists in the
   bundled/optional catalog) — browse it first, then install with the catalog
   install endpoint. No external network fetch happens.
2. **External source** (skills.sh, GitHub, local path, or URL) — use the
   import endpoint below.

### App-shipped catalog

Browse, inspect, and install catalog skills before reaching for an external
source. Bundled skills are the curated defaults for any company; optional
skills are role- or domain-specific.

```sh
curl -sS "$PAPERCLIP_API_URL/api/skills/catalog?kind=bundled" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"

curl -sS "$PAPERCLIP_API_URL/api/skills/catalog/ref?ref=github-pr-workflow" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"

curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/skills/install-catalog" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "catalogSkillId": "paperclipai:bundled:software-development:github-pr-workflow"
  }'
```

The install response records provenance (`catalogId`, `catalogKey`,
`packageVersion`, `originHash`) on the company skill so update/audit/reset
flows know the pinned origin. `force: true` may replace a same-key
catalog-managed skill but never bypasses hard-stop audit findings.

### External source import

Import using a **skills.sh URL**, a key-style source string, a GitHub URL, or a local path.

### Source types (in order of preference)

| Source format | Example | When to use |
|---|---|---|
| **skills.sh URL** | `https://skills.sh/google-labs-code/stitch-skills/design-md` | When a user gives you a `skills.sh` link. This is the managed skill registry — **always prefer it when available**. |
| **Key-style string** | `google-labs-code/stitch-skills/design-md` | Shorthand for the same skill — `org/repo/skill-name` format. Equivalent to the skills.sh URL. |
| **GitHub URL** | `https://github.com/vercel-labs/agent-browser` | When the skill is in a GitHub repo but not on skills.sh. |
| **Local path** | `/abs/path/to/skill-dir` | When the skill is on disk (dev/testing only). |

**Critical:** If a user gives you a `https://skills.sh/...` URL, use that URL or its key-style equivalent (`org/repo/skill-name`) as the `source`. Do **not** convert it to a GitHub URL — skills.sh is the managed registry and the source of truth for versioning, discovery, and updates.

### Example: skills.sh import (preferred)

```sh
curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/skills/import" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "source": "https://skills.sh/google-labs-code/stitch-skills/design-md"
  }'
```

Or equivalently using the key-style string:

```sh
curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/skills/import" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "source": "google-labs-code/stitch-skills/design-md"
  }'
```

### Example: GitHub import

```sh
curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/skills/import" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "source": "https://github.com/vercel-labs/agent-browser"
  }'
```

You can also use source strings such as:

- `google-labs-code/stitch-skills/design-md`
- `vercel-labs/agent-browser/agent-browser`
- `npx skills add https://github.com/vercel-labs/agent-browser --skill agent-browser`

If the task is to discover skills from the company project workspaces first:

```sh
curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/skills/scan-projects" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
```

## Inspect What Was Installed

```sh
curl -sS "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/skills" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"
```

Read the skill entry and its `SKILL.md`:

```sh
curl -sS "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/skills/<skill-id>" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"

curl -sS "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/skills/<skill-id>/files?path=SKILL.md" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"
```

## Assign Skills To An Existing Agent

`desiredSkills` accepts:

- exact company skill key
- exact company skill id
- exact slug when it is unique in the company

The server persists canonical company skill keys.

```sh
curl -sS -X POST "$PAPERCLIP_API_URL/api/agents/<agent-id>/skills/sync" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "desiredSkills": [
      "vercel-labs/agent-browser/agent-browser"
    ]
  }'
```

If you need the current state first:

```sh
curl -sS "$PAPERCLIP_API_URL/api/agents/<agent-id>/skills" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"
```

## Distribute A Skill To People You Manage (bulk)

`POST /api/agents/:managerAgentId/skills/sync` changes ONE agent and REPLACES its
skill set. To hand a skill to several agents at once — e.g. a manager telling you
"give this skill to my team" — use distribute, which ADDS the skill to each
chosen agent (their existing skills are kept):

`POST /api/agents/:managerAgentId/skills/distribute`

Two ways to say who gets the skill — a **scope** (server resolves the agents) or
an **explicit list**. Pick whichever matches the request.

**By scope** (turnkey — "give this to my team / the whole company"):

```jsonc
{
  "skill": "<company skill key | id | unique slug>",   // or "skills": ["a","b"]
  "scope": "managed",           // see options below
  "excludeAgentIds": ["<id>"],  // optional: trim a few out of the scope
  "mode": "add"                 // "add" (default, keeps their other skills) | "replace"
}
```

`scope` options:
- `"company"` — every agent in the company (founder: "the whole company uses this").
- `"managed"` — every agent transitively below you in the reporting chain
  ("everyone I manage"). Same as `"subtree"`.
- `"direct-reports"` — only agents whose `reportsTo` is you.
- `{ "team": "教學組" }` — every agent whose `metadata.teams` includes that team
  ("the entire 教學組 uses this").

**By explicit list** (for "A and B, not C" / "just A"):

```jsonc
{ "skill": "<...>", "targetAgentIds": ["<agent-id>", "<agent-id>"], "mode": "add" }
```

If you need to build or preview the list yourself, `GET /api/companies/:companyId/agents`
returns every agent with its `reportsTo` and `metadata.teams`, so you can resolve
names → ids, confirm the set with the manager, then send `targetAgentIds`
(optionally with `excludeAgentIds`). Explicit `targetAgentIds` takes precedence
over `scope` when both are sent.

The response reports each target's outcome so you can tell the manager what
happened:

```jsonc
{
  "skills": ["..."], "mode": "add", "scope": "team:教學組", "targetCount": 3,
  "distributedBy": "<managerAgentId>",
  "summary": { "equipped": 2, "already_equipped": 1, "forbidden": 0, "not_found": 0 },
  "results": [ { "agentId": "...", "name": "...", "status": "equipped" } ]
}
```

Per-target statuses: `equipped` (added), `already_equipped` (had it — no-op, so
re-running is safe), `forbidden` (you may not configure that agent), `not_found`,
`error`. Each agent equips the skill on its next heartbeat.

Authorization per target: allowed if you could configure that agent directly
(e.g. you hold `agents:create`), OR — for an agent calling with its own id as
`:managerAgentId` — if the target is anywhere in your reporting subtree. So a
manager can distribute an approved skill to their own team even without
company-wide `agents:create` (this endpoint only ADDS a skill, never edits other
config). Targets outside that come back `forbidden`.

## Include Skills During Hire Or Create

Use the same company skill keys or references in `desiredSkills` when hiring or creating an agent:

```sh
curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/agent-hires" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "QA Browser Agent",
    "role": "qa",
    "adapterType": "codex_local",
    "adapterConfig": {
      "cwd": "/abs/path/to/repo"
    },
    "desiredSkills": [
      "agent-browser"
    ]
  }'
```

For direct create without approval:

```sh
curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/agents" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "QA Browser Agent",
    "role": "qa",
    "adapterType": "codex_local",
    "adapterConfig": {
      "cwd": "/abs/path/to/repo"
    },
    "desiredSkills": [
      "agent-browser"
    ]
  }'
```

## Notes

- Built-in Paperclip runtime skills are still added automatically when required by the adapter.
- If a reference is missing or ambiguous, the API returns `422`.
- Prefer linking back to the relevant issue, approval, and agent when you comment about skill changes.
- Use company portability routes when you need whole-package import/export, not just a skill:
  - `POST /api/companies/:companyId/imports/preview`
  - `POST /api/companies/:companyId/imports/apply`
  - `POST /api/companies/:companyId/exports/preview`
  - `POST /api/companies/:companyId/exports`
- Use skill-only import when the task is specifically to add a skill to the company library without importing the surrounding company/team/package structure.
