# Asana → Odoo → Paperclip 工作模型對照參考手冊
### Seasonarts / 四季藝術教育機構 — Definitive Reference

This document explains the Asana model in plain terms, then maps it onto **Odoo 17 Community (self-hosted)** and onto **Paperclip**, and closes with a single recommended target model that stays consistent across all three. Technical terms are kept in English; section headers are bilingual.

---

## 1. The Asana model in plain terms / Asana 模型解說

Asana organizes work as a strict containment tree, with **one cross-cutting exception (multi-homing)** that is the single most important thing to understand before porting it anywhere else.

### 1.1 The hierarchy / 層級結構

```
Organization                         組織 (a special Workspace tied to a company email domain, e.g. @seasonart.org)
 │   - anyone with the domain email auto-joins as a MEMBER
 │
 ├─ Team                             團隊 (a subset of users; a project belongs to exactly ONE team)
 │   │   privacy: Public / By-Request / Private / Hidden
 │   │
 │   └─ Project                      專案 (a collection of tasks; views: List/Board/Calendar/Timeline/Gantt)
 │       │   privacy + per-person access level
 │       │
 │       └─ Section                  區段/欄 (groupings; render as columns in Board view)
 │           │
 │           └─ Task                 任務 (the atomic unit of work; exactly ONE assignee)
 │               │   followers/collaborators, custom fields, due date, dependencies
 │               │
 │               └─ Subtask          子任務 (up to 5 levels deep; does NOT inherit parent's projects)
 │
 └─ (cross-cutting) Portfolio / Goal  投資組合 / 目標 — span across teams & projects

★ MULTI-HOMING: one Task can live in MANY Projects at once (same object, not copies).
  Each membership is a { project, section } pair → the task can sit in a different
  section in each project. Edits (assignee, due date, completion) propagate everywhere.
```

Key boundary rule: a project/task exists in **only one Organization/Workspace** — objects never cross that wall.

### 1.2 The pieces / 各層說明

- **Organization vs Workspace** — both are the top-level container. An **Organization** is a special Workspace tied to a company email domain; anyone signing up with `@seasonart.org` **auto-joins as a Member**. A plain Workspace has no domain and no team layer (it acts as one implicit team). ([Object hierarchy](https://developers.asana.com/docs/object-hierarchy), [Workspaces & organizations FAQ](https://help.asana.com/s/article/workspaces-and-organizations-faq?language=en_US))
- **Team** — a subset of users who work together; exists only inside Organizations. **Every project belongs to exactly one team.** Team privacy is one of *Public to org / Membership by request / Private / Hidden*, and it gates who can discover/join the team and reach its public projects. ([Team permissions](https://help.asana.com/s/article/team-permissions?language=en_US))
- **Project** — a collection of tasks belonging to one team. Same data, multiple **views**: List, Board, Calendar (all plans); Timeline/Gantt (paid). ([Project views](https://asana.com/features/project-management/project-views))
- **Section** — subdivides a project; the *same object* shows as a grouping header in List view and as a **column** in Board view.
- **Task** — the atomic unit: name, notes, **single assignee** (one owner = clear accountability), due date, `completed`, followers/collaborators, custom fields, dependencies, and `resource_subtype` of `default_task` / `milestone` / `approval`. ([Tasks reference](https://developers.asana.com/reference/tasks))
- **Subtask** — a full task nested under a parent (max 5 levels). **Critical:** subtasks do **not** inherit the parent's project memberships. ([Subtasks](https://help.asana.com/hc/en-us/articles/14101387791899-Subtasks))
- **Dependencies** — "blocked by" / "blocking" relationships; assignee auto-notified when unblocked. ([Task dependencies](https://help.asana.com/hc/en-us/articles/14078761989531-Task-dependencies))

### 1.3 Multi-homing — the load-bearing idea / 一任務多專案

A single task can belong to many projects **simultaneously** — it is the *same* object, not a copy. Mechanically, a task carries a **`memberships`** array of `{ project, section }` pairs. Because it is one object, **changing the assignee/due date/status or completing it propagates to every hosting project instantly**. Removing it from one project removes only that membership. This is Asana's single most powerful structural feature and the main thing to plan for when recreating the model elsewhere. ([How to multi-home tasks](https://help.asana.com/s/article/how-to-multi-home-tasks?language=en_US), [Multi-home to avoid silos](https://help.asana.com/s/article/multi-home-tasks-to-avoid-information-silos?language=en_US))

### 1.4 Custom fields, Portfolios, Goals / 自訂欄位、投資組合、目標

- **Custom fields** — seven base types: `text`, `number`, `enum` (single-select), `multi_enum` (multi-select), `date`, `people`, `reference`; plus read-only **formula** and **custom-ID** variants on the number type. The key reuse mechanism is the split between the **field definition** (workspace-scoped `custom_field`) and the **field setting** (`custom_field_settings`, a many-to-many join attaching the field to a specific project/portfolio). Library/global fields are reused across projects without duplication. ([Custom fields guide](https://developers.asana.com/docs/custom-fields-guide), [Custom field settings](https://developers.asana.com/reference/custom-field-settings))
- **Portfolios** — high-level collections of **projects and other portfolios** (nesting allowed), giving a cross-initiative health/progress view. Numeric global fields support **sum rollups**; owners post status updates. ([Portfolios feature](https://asana.com/features/goals-reporting/portfolios), [Portfolio progress & reporting](https://help.asana.com/s/article/portfolio-progress-and-reporting?language=en_US))
- **Goals** — company goals + team goals that ladder up via sub-goals. Connect projects/portfolios/tasks as supporting work; progress is **automatic** (from source) or **manual** (current vs target value, measured as percentage/number/currency); each goal has an owner, time period, and status (on track / at risk / off track). ([Goals feature](https://asana.com/features/goals-reporting/goals), [Plan & manage company goals](https://help.asana.com/s/article/plan-and-manage-company-goals?language=en_US))
- **Rules** — `trigger → action(s)` automation, scoped to a project; supports branching, up to 50 rules/project and 20 triggers + 20 actions/rule; **rule bundles** apply a reusable set across projects. ([Rules feature](https://asana.com/features/workflow-automation/rules), [How to use rules](https://help.asana.com/s/article/rules?language=en_US))

### 1.5 Members, guests, roles, permissions / 成員、訪客、角色、權限

Access composes **two tiers**: the **account/org tier** (who you are, what admin powers you hold) and the **object tier** (team privacy → project access → task visibility). A user must clear the team/project gate **and** hold an account role that permits the action.

**Account tier — Member vs Guest (automatic, by email domain):**
- Domain email (`@seasonart.org`) → **Member**, auto-joined, can discover any *public* team/project.
- Any other domain → **Guest**, **explicit-share-only** (sees only what's shared; no browse/search/discovery), cannot be Admin, and on paid Organizations **does not consume a paid seat** — the core lever for cheap external collaboration. ([Guests FAQ](https://help.asana.com/s/article/guests-faq?language=en_US), [Permissions overview](https://asana.com/resources/asana-tips-permissions))

**Org roles** — *Member*, *Billing Owner* (billing visibility only), *Admin* (manage users/teams + per-user security; cannot touch SSO/SCIM or grant Super Admin), *Super Admin* (full superset incl. SAML/SSO, SCIM, domain export/delete). Asana has **no custom org-wide RBAC roles** in the general model — governance = these built-in roles **+** per-team privacy **+** per-project access levels. ([Admin & super admin roles](https://help.asana.com/s/article/admin-and-super-admin-roles-in-asana))

**Project access levels** (the four in-app tiers):

| Level | Can do |
|---|---|
| **Project Admin** | Full control: manage members & access, settings, move/archive/delete, all task actions |
| **Editor** | Add/edit/complete tasks, comment; cannot change architecture or manage members |
| **Commenter** | View + comment/@mention; limited task interaction |
| **Viewer** | View only — no comment/edit |

([Project permissions](https://help.asana.com/s/article/individual-project-permissions?language=en_US), [Viewer access](https://help.asana.com/hc/en-us/articles/23124207462043-Viewer-project-access-level))

**Task tier** — tasks inherit project privacy by default; a task can be made **private** (visible only to assignee + collaborators + explicitly-added) even inside a public project; sharing one task from a private project grants access to **that task + its subtasks only**. ([Understanding privacy & visibility](https://help.asana.com/s/article/understanding-privacy-and-visibility-in-asana?language=en_US))

---

## 2. Asana → Odoo 17 Community recreation / Odoo 重建方案

### 2.1 Side-by-side mapping / 對照表

| Asana concept | Odoo 17 equivalent | Native / Studio / Custom | Notes |
|---|---|---|---|
| **Organization / Workspace** | Company (`res.company`); the **database** is the true hard wall | Native | Workspace ≈ one company. Multi-company isolation is weaker than Asana's hard workspace boundary. |
| **Team** (folder of projects) | No true folder. Closest: project **Tags**, `hr.department`, or parent/child project | Native (genuine gap) | No first-class "team folder" with its own roster + project list. Tags = flat grouping; department = groups people; parent project = awkward for peer grouping. **A custom `project.group` model or OCA addon is needed for parity.** |
| **Project** | `project.project` | Native | 1:1. |
| **Project privacy** | Visibility field: *Invited internal users* / *All internal users* / *Invited portal users + all internal* | Native | Maps to Private / Public-to-team / Comment-only-guest reasonably. |
| **Section / Column** | Task **Stage** (`project.task.type`), Kanban columns | Native | Semantic difference: Asana Sections are pure groupers; Odoo Stages also carry workflow/drag-drop meaning. |
| **Task** | `project.task` | Native | 1:1. |
| **Subtask** | `parent_id` (Sub-tasks tab) | Native | Functional but flatter UX than Asana's deep nesting. |
| **Task status (within stage)** | Status field: In Progress / Changes Requested / Approved / Canceled / Done | Native | Roughly maps to incomplete/complete + approval states. |
| **Custom fields** | `x_studio_*` (Studio, **Enterprise only**) or `x_*` via custom module/dev mode (Community) | **Studio (Ent.) / Custom (Comm.)** | **Biggest gap:** Studio is Enterprise-only. Community needs a developer-authored module inheriting `project.task`/`project.project`. |
| **Assignee(s)** | `user_ids` (multiple supported in v17) | Native | Matches Asana's multi-assignee; note Asana's *primary* single-assignee accountability rule has no direct Odoo enforcement. |
| **Followers / Collaborators** | `message_follower_ids` (chatter) | Native | Drives notifications and private-project access. |
| **Portfolio** | No exact equivalent; approx. via grouping/filtering, **analytic accounts/plans** (financial rollup), or parent project | Native (partial) / Custom | No native cross-project status/progress rollup dashboard. Analytic plans roll up *financials only*. True portfolios → 3rd-party/OCA. |
| **Goals (OKRs)** | **No native OKR feature** | Custom / 3rd-party | Options: `to_okr`, "OKR & Project Integrator" (both paid/proprietary). No free OCA standard. |
| **Members / Guests / Roles** | `res.users` + security **groups** + **record rules** + **portal users** (guests) | Native | More powerful than Asana roles, but technical (not point-and-click). Guests = portal users. |

### 2.2 The four big gaps on Community 17 / 四個主要缺口

1. **Custom fields — no Studio.** This is the single biggest functional gap. Any Asana custom field requires a developer-authored module (`x_`-prefixed fields + view inheritance) or a paid App-Store "Studio alternative." **Budget developer time** — it is not a settings toggle. ([Studio fields](https://www.odoo.com/documentation/19.0/applications/studio/fields.html), [Community + Studio forum](https://www.odoo.com/forum/help-1/community-version-13-and-add-fields-with-odoo-studio-175518))
2. **No native Goals/OKR.** Buy `to_okr` / an OKR addon, or model goals as a lightweight custom model. ([to_okr](https://apps.odoo.com/apps/modules/16.0/to_okr))
3. **No native Portfolio.** Analytic accounts cover only the *financial* slice; true cross-project status/progress dashboards need a 3rd-party module. ([Analytic accounting](https://www.odoo.com/documentation/18.0/applications/finance/accounting/reporting/analytic_accounting.html))
4. **"Team" folder grouping is a real gap.** Decide deliberately: **tags** for cheap flat grouping (native), or a small custom **`project.group`** model if 四季 needs Asana-style team rosters owning a set of projects. Do not over-promise Asana Team parity out of the box.

**Pragmatic Community-17 setup advice:**
- Map **one Odoo company = one Asana workspace** for 四季 (the database is the hard boundary). Multi-site/multi-company is native but isolation is softer than Asana — validate confidentiality needs.
- Use **Stages** as your Sections from day one; share stages across projects via the stage's "Projects" field only where workflows truly match.
- For privacy, prefer **"Invited internal users"** for confidential projects, but **test the shared-URL behavior**: a non-follower internal user can still open a task via a shared link. Validate against confidentiality requirements before rollout. ([Project visibility tutorial](https://home.mycbms.com/how-to-configure-project-visibility-access-rights-in-odoo-17-project-app-odoo-17-tutorials-cbms-odoo-erp/))
- Onboard external collaborators as **portal users** (Asana-guest analog); expect extra UX/licensing thought.
- Treat **multi-homing** as the migration's hardest concept: Odoo tasks belong to **one** project, so an Asana multi-homed task must be re-modeled (e.g., a primary project + tags, or a custom many-to-many). Do not assume 1:1.

**Bottom line:** Project / Section / Task / Subtask / Assignee / Followers / privacy / roles map natively and cleanly. The four items needing money or developer effort are **custom fields, Goals/OKR, Portfolio, and Team-folder grouping** — plus **multi-homing**, which has no native Odoo equivalent.

---

## 3. Asana → Paperclip recreation / Paperclip 重建方案

Paperclip's primitives are **Companies, Projects, Issues, Agents, Goals**, with a **member-role** model (owner / admin / operator / viewer) and **resource memberships**. The mapping is closer to Asana than Odoo in the access-control shape, and notably different in that Paperclip's "members" include **agents** as first-class actors.

### 3.1 Concept correspondence / 概念對照

| Asana concept | Paperclip concept | Match quality | Notes |
|---|---|---|---|
| **Organization / Workspace** | **Company** | Strong | Top-level container and hard boundary, like an Asana org. 四季 = primary company. |
| **Team** (folder + roster gating projects) | (no direct "team folder"); approximated by **resource memberships** scoping who is on which project | Partial | Paperclip gates access per-resource (project/issue) via memberships rather than a team-folder layer. Closer to Asana's *project sharing* than to the *team* layer. |
| **Project** | **Project** | Strong | Direct correspondence as the work container. |
| **Section** | (project-internal grouping/status) | Weak/implicit | No documented first-class Section object; group/track via issue status. |
| **Task** | **Issue** | Strong | The atomic unit of work. |
| **Subtask** | (issue relationship / parent linkage) | Partial | Re-check depth/nesting semantics against the live model; do not assume Asana's 5-level rule. |
| **Assignee (single)** | Issue assignee — which can be an **Agent** or a human | Strong, with a twist | Paperclip's distinctive feature: the assignee can be an autonomous **agent**, not only a person. |
| **Followers/Collaborators** | resource members on the issue/project | Partial | Membership-driven visibility rather than a separate "follower" notion. |
| **Custom fields** | (not a documented first-class Asana-style field library) | Gap | Treat as a gap; verify against live API before promising. |
| **Portfolio** | (no direct equivalent surfaced) | Gap | Use Goals + cross-project views instead. |
| **Goal** | **Goal** | Strong | First-class. Use for OKR-style laddering as in Asana. |
| **Member (org)** | Company member with role | Strong | See role mapping below. |
| **Guest (explicit-share-only)** | **viewer** role + **resource membership** scoping | Strong | Resource membership = the explicit-share mechanism; viewer = read-only, mirroring Asana's Viewer/guest scope. |

### 3.2 Roles — Paperclip vs Asana / 角色對照

Paperclip uses four member roles. They map onto Asana's two-tier model (org roles + project access levels) like this:

| Paperclip role | Closest Asana analog | Meaning |
|---|---|---|
| **owner** | Super Admin / Billing Owner | Full control of the company, including the most sensitive settings. |
| **admin** | Admin + Project Admin | Manage members, projects, and configuration. |
| **operator** | Editor | Do the work: create/edit/run issues, drive agents — but not full administration. |
| **viewer** | Viewer / Guest (read-only) | Read-only access to the resources they are a member of. |

**Resource memberships** are the bridge to Asana's per-object sharing: instead of a separate team-folder gate, Paperclip scopes a user/agent to specific resources (a project or issue) — analogous to Asana "shared with specific people" and to sharing a single task. A **viewer + a single resource membership** reproduces Asana's "guest scoped to one task/project."

### 3.3 Where Paperclip matches Asana / 相符之處
- **Company = Organization** as the hard top-level boundary.
- **Project = Project**, **Issue = Task** as clean 1:1 work containers/units.
- **Goal = Goal**, first-class, supporting OKR-style laddering.
- **Role tiers** (owner/admin/operator/viewer) map cleanly onto Asana's admin + access-level ladder.
- **Resource memberships** reproduce Asana's explicit-share / guest-scoping semantics.

### 3.4 Where Paperclip differs / 相異之處
- **Agents are first-class assignees** — an Issue can be owned/executed by an autonomous agent. Asana has no equivalent (its assignee is always a person). This is Paperclip's defining addition.
- **No team-folder layer** — access is membership-per-resource, not a team roster that auto-gates a project set.
- **Sections, Custom fields, Portfolios** are not surfaced as first-class Asana-equivalents — treat as gaps and verify against the live API/model before committing structure to them.
- **Multi-homing** — not assumed; an Issue should be treated as belonging to one project unless the live model proves otherwise.

> Verification note: the Paperclip-specific object/field details above come from the deployment context (companies, projects, issues, agents, goals, owner/admin/operator/viewer roles, resource memberships). Confirm Section/Subtask/Custom-field/Portfolio specifics against the live Paperclip API before encoding them, since they were not part of the cited Asana/Odoo research.

---

## 4. Recommended target model for Seasonarts / 四季建議目標模型

Goal: **one coherent structure** that is recognizable to Asana-trained staff, buildable on Odoo 17 Community, and natural in Paperclip — minimizing per-tool surprises.

### 4.1 The shared backbone / 共用骨架

```
四季藝術 (Seasonarts)            = Asana Organization = Odoo Company = Paperclip Company
 │
 ├─ Department grouping          = Asana Team        = Odoo project TAG (or custom project.group)
 │                                                     = Paperclip resource-membership grouping
 │   e.g. Finance / IT / Teaching-Ops / Marketing
 │
 ├─ Project                      = Asana Project      = Odoo project.project = Paperclip Project
 │   │
 │   ├─ Section / workflow stage = Asana Section      = Odoo Stage (Kanban) = Paperclip status
 │   │
 │   └─ Task                     = Asana Task         = Odoo project.task   = Paperclip Issue
 │       └─ Subtask              = Asana Subtask       = Odoo parent_id      = Paperclip child issue
 │
 └─ Goal (OKR)                   = Asana Goal         = Odoo OKR addon/custom = Paperclip Goal
```

### 4.2 Concrete recommendations / 具體建議

1. **One company = one workspace = one database boundary.** Treat 四季 as the single top-level org in all three tools. Use the `@seasonart.org` domain as the membership boundary (matches the existing SSO + allowlist setup).

2. **Model "Teams" as a flat department grouping, not a hard folder** — because Odoo and Paperclip both lack Asana's team-folder. Use a controlled vocabulary of departments (Finance / IT / Teaching-Ops / Marketing). Implement as:
   - Asana: actual Teams.
   - Odoo: a **project Tag** per department (cheap, native); upgrade to a custom `project.group` model only if you genuinely need per-department rosters owning project sets.
   - Paperclip: **resource memberships** grouped by department convention.

3. **Avoid relying on multi-homing as a core workflow.** Since neither Odoo nor Paperclip reproduces it natively, design so each task has **one home project + tags/labels** for cross-cutting visibility. Reserve true multi-homing for Asana-only edge cases and document them as non-portable.

4. **Standardize Sections/Stages as a small shared workflow** (e.g., To Do → In Progress → Review → Done) so Asana Sections, Odoo Stages, and Paperclip statuses line up 1:1 and migrations stay mechanical.

5. **Custom fields: keep them few and centralized.** On Odoo Community this needs a developer module, so agree on a *small* canonical set (e.g., Priority, Estimated hours, Department) and build them once as global/library fields in Asana and as a single Odoo custom module — rather than per-project fields that won't port.

6. **Roles: adopt a single 4-tier ladder across tools.**

   | Intent | Asana | Odoo | Paperclip |
   |---|---|---|---|
   | Full control | Super Admin / Project Admin | Settings + Project Admin group | **owner** |
   | Manage / configure | Admin | Project Administrator group | **admin** |
   | Do the work | Editor | Project User (internal) | **operator** |
   | Read-only / external | Viewer / Guest | Viewer / portal user | **viewer** |

   This keeps the pilots (Sinney = finance, Frank = IT) and future staff on one mental model regardless of tool.

7. **External collaborators = guests/portal/viewers, scoped explicitly.** Use Asana guests, Odoo portal users, and Paperclip viewer-+-resource-membership respectively — never give externals discovery-level membership.

8. **Goals (OKRs): author once, mirror manually.** Use Asana Goals and Paperclip Goals natively; on Odoo Community plan for a paid OKR addon or a lightweight custom model, and keep the OKR text canonical in one place to avoid drift.

9. **Portfolios: do not promise them on Odoo/Paperclip.** Use Asana Portfolios for executive cross-project rollups; on the other two, approximate with Goals + cross-project filtered views (Odoo: analytic accounts only for the financial slice).

### 4.3 What ports cleanly vs what needs effort / 對照總結

- **Ports cleanly everywhere:** Company/Org boundary, Project, Task/Issue, Subtask, single-owner accountability, the 4-tier role ladder, Goals (Asana ↔ Paperclip).
- **Needs deliberate design / money / dev work:** Team-folders (use tags), multi-homing (avoid as core), custom fields (Odoo Community module), Portfolios (Asana-only), OKR on Odoo (paid/custom).
- **Paperclip's bonus:** agents as first-class assignees — fits the narrow-tool-wrapper / restricted-role plan for 四季 and has no Asana/Odoo equivalent.

---

### Sourcing caveat / 來源說明
Asana help-center bodies are JS-rendered and were corroborated via Asana developer docs, `asana.com/resources` & `/features` pages, official forum product-launch threads, and a third-party admin manual. Plan-tier specifics (free-plan guest caps, RBAC/SCIM = Enterprise, billing edge cases) should be confirmed against the live Admin Console. Odoo citations are 17.0 native where available (task stages, sub-tasks) with 18.0/19.0 used where 17.0 behavior is identical (visibility, analytic accounting, Studio-Enterprise-only). Paperclip object/field specifics beyond the named primitives should be verified against the live API before encoding.
