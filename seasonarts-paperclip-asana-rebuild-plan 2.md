# Paperclip ← Asana Rebuild Plan / Asana 機制移植 Paperclip 實作計畫
### Seasonarts / 四季藝術教育機構 — Projects · Roles · Teams

> **Scope / 範圍：** Bring Asana's **Project system + design**, **user roles**, and **team mechanism** into Paperclip. Odoo is out of scope here.
> 將 Asana 的**專案系統與設計**、**使用者角色**、**團隊機制**移植到 Paperclip。本文件不含 Odoo。
>
> **Verified against live code** (schema / services / routes / UI). File paths are real.
> 本計畫依**現有原始碼實測**（schema／service／route／UI），檔案路徑為真實路徑。

---

## 0. Can we even do all this? / 這些全部都改得動嗎？

**EN —** Yes. Paperclip is open-source and you hold the full source tree, so **every layer is editable**: the Postgres schema (`packages/db`), shared types/validators (`packages/shared`), the API/services (`server/src`), and the React UI (`ui/src`). Nothing is behind a SaaS wall. There is no feature here that is *impossible* — only differences in **effort** and **risk**.

Two real constraints to accept up front:
1. **Migrations are forever.** Schema changes need Drizzle migrations and are hard to undo once data exists.
2. **Upstream-merge cost.** You are on a fork (`local/*` branches). The deeper you modify *core* files (authorization, issue routes), the harder it becomes to pull future upstream Paperclip updates. Additive tables/columns merge cleanly; rewrites of `authorization.ts` / `issues.ts` will conflict.

**中文 —** 可以。Paperclip 是開源且你擁有完整原始碼，因此**每一層都可改**：Postgres schema（`packages/db`）、共用型別與驗證（`packages/shared`）、API／服務層（`server/src`）、React 前端（`ui/src`）。沒有任何功能被 SaaS 鎖住。這裡沒有「做不到」的項目，只有**工作量**與**風險**的差異。

需先接受兩個現實限制：
1. **Migration 不可逆。** Schema 變更需要 Drizzle migration，一旦有資料就難以回退。
2. **與上游合併的成本。** 你在 fork（`local/*` 分支）上。越深入改**核心**檔案（授權、issue 路由），未來要拉上游 Paperclip 更新就越痛。新增資料表／欄位可乾淨合併；改寫 `authorization.ts`／`issues.ts` 必定衝突。

---

## 1. Concept mapping & gap table / 概念對照與缺口表

| Asana | Paperclip today / 現況 | Gap / 缺口 | Build phase |
|---|---|---|---|
| Organization/Workspace | **Company** (exists) | none | — |
| **Team** (roster + owns projects) | none — only agent `reportsTo` + `metadata` jsonb | **new entity** | Phase 1 |
| **Project** | `projects` table (name, desc, status, color, leadAgent, goal, targetDate) | partial | Phase 0 / 3 |
| **Section / board column** | none — issues group by `status` only | **new entity** | Phase 3 |
| Task | **Issue** (exists) | none | — |
| Subtask | issue parent/child linkage | partial | — |
| **Custom fields** | only **labels** (name+color) | **new subsystem** | Phase 4 |
| Board / List views | exist (`IssuesList.tsx` `viewMode`) | partial (no timeline/calendar) | Phase 6 |
| Org roles (admin/member/guest) | `companyMemberships` owner/admin/operator/viewer (**users only**) | usable | Phase 0 |
| **Per-project access level** (proj admin/editor/commenter/viewer) | none — access is company-wide; project membership is sidebar-only | **new authz model** | Phase 5 (hardest) |
| **Project privacy** (private to members) | none — all company members see all projects | **new authz model** | Phase 5 |
| Guest (explicit-share-only) | `viewer` role + resource membership (partial) | partial | Phase 5 |

Key verified files / 已實測檔案：
`packages/db/src/schema/projects.ts` · `project_memberships.ts` (userId only) · `agents.ts` (`reportsTo`,`metadata`,`permissions`) · `labels.ts` · `issues.ts` · `packages/shared/src/constants.ts` (`PERMISSION_KEYS`, roles) · `server/src/routes/issues.ts:1898` (operator visibility filter) · `server/src/services/authorization.ts` (grant scope: projectId/agentId/subtreeAgentId).

---

## 2. The phased plan / 分階段實作

Effort key / 工作量： **S**=small (1 file-area, no/￼trivial migration) · **M**=medium (several files + migration) · **L**=large (subsystem) · **XL**=core rewrite + security-critical.
Risk key / 風險： 🟢 additive · 🟡 touches shared surfaces · 🔴 core authz / security.

---

### Phase 0 — Native setup, ZERO code / 原生設定，零程式碼  ·  Effort: S · 🟢

**EN —** Everything you can do *today* without touching code:
- One **Project** per Asana project; set `leadAgentId`, link a `goal`.
- **Labels** as the lightweight stand-in for custom fields (`部門:資訊`, `階段:Wave1`, `優先:高`).
- **Board + List** views already work.
- **`reportsTo`** wired on every agent → the Agents-page org tree reflects your hierarchy.
- **Human roles** (owner/admin/operator/viewer) assigned per the access design (only Jay/Tang/Betty as owners).

**中文 —** 今天就能做、完全不動程式碼：
- 每個 Asana 專案對應一個 **Project**；設定 `leadAgentId`、連結 `goal`。
- 用 **Labels** 當自訂欄位的輕量替代（`部門:資訊`、`階段:Wave1`、`優先:高`）。
- **看板＋清單**檢視已可用。
- 為每個 agent 設定 **`reportsTo`** → Agents 頁的組織樹即反映階層。
- 依存取設計指派**人員角色**（只有 Jay／Tang／Betty 為 owner）。

**Deliverable / 產出：** a working Asana-shaped workspace with no engineering. / 不需工程即得到 Asana 形狀的工作區。

---

### Phase 1 — Teams entity & sidebar folders / 團隊實體與側邊欄資料夾  ·  Effort: M · 🟡

**EN — Goal:** a real **Team** object (Asana's team), agents/projects belong to a team, sidebar shows collapsible team folders.

Build steps:
1. **Schema** — new `teams` table: `id, companyId, name, description, privacy('public'|'private'), color, createdAt`. New `team_memberships`: `teamId, principalType('user'|'agent'), principalId, role`. Add `teamId` (nullable) to `agents` and `projects`. → *Drizzle migration.*
2. **Shared types/validators** — `Team`, `TeamMembership`; add `teamId` to `Agent` and `Project` types + create/update validators (`packages/shared`).
3. **Service/routes** — `teams` CRUD service + routes (`server/src/routes/teams.ts`); include `teamId` in agent/project projections.
4. **UI** — `SidebarAgents.tsx`: group by `teamId` into collapsible folders (reuse `@/components/ui/collapsible`); `Agents.tsx`: add a "folders" group mode; a Team picker on the agent/project config forms.

**Fast-start variant (S):** prototype with `agents.metadata.team` (jsonb, **no migration**) + UI grouping, to validate UX before committing the real `teams` table.

**中文 — 目標：** 建立真正的 **Team** 物件（對應 Asana 團隊），agent／project 歸屬於團隊，側邊欄顯示可收合的團隊資料夾。

實作步驟：
1. **Schema** — 新增 `teams` 表：`id, companyId, name, description, privacy, color, createdAt`；新增 `team_memberships`：`teamId, principalType, principalId, role`；在 `agents` 與 `projects` 加上可空 `teamId`。→ *需 Drizzle migration。*
2. **共用型別／驗證** — 新增 `Team`、`TeamMembership`；在 `Agent`、`Project` 型別與建立/更新驗證加入 `teamId`。
3. **服務／路由** — `teams` CRUD 服務與路由；agent／project 投影帶出 `teamId`。
4. **前端** — `SidebarAgents.tsx` 依 `teamId` 分組為可收合資料夾；`Agents.tsx` 新增「資料夾」分組模式；設定表單加團隊選擇器。

**快速試做（S）：** 先用 `agents.metadata.team`（jsonb，**免 migration**）＋前端分組驗證 UX，再決定是否落地 `teams` 表。

---

### Phase 2 — Project grouping & lead/owner polish / 專案分組與負責人  ·  Effort: S–M · 🟡

**EN —** Projects gain the team layer from Phase 1 (`projects.teamId`) so the project list/sidebar can group by team like Asana ("這個團隊的專案"). Optionally add a true `ownerUserId` to projects (today only `leadAgentId` exists) so a *human* can own a project, matching Asana's project owner.

**中文 —** 專案套用 Phase 1 的團隊層（`projects.teamId`），讓專案清單／側邊欄可依團隊分組（如 Asana 的「某團隊的專案」）。可另加真正的 `ownerUserId`（現只有 `leadAgentId`），讓**人員**能擁有專案，對應 Asana 的專案 owner。

---

### Phase 3 — Project Sections (board columns) / 專案區段（看板欄位）  ·  Effort: M · 🟡

**EN — Goal:** Asana **Sections** — user-defined groupings/columns inside a project, independent of status.
1. **Schema** — `project_sections`: `id, projectId, name, position`. Add `sectionId` (nullable FK) to `issues`. → migration.
2. **Types/validators** — `Section`; add `sectionId` to issue create/update.
3. **Routes** — section CRUD + reorder; include `sectionId` on issue payloads.
4. **UI** — `IssuesList.tsx` board: render **columns by section** (option alongside the existing status-Kanban); list view: section group headers; drag-drop between sections.

Note / 注意: keep status AND sections — status drives the engine (heartbeat lifecycle); sections are pure organization. Do **not** overload status.

**中文 — 目標：** Asana 的**區段**——專案內使用者自訂的分組／欄位，獨立於 status。
1. **Schema** — `project_sections`：`id, projectId, name, position`；`issues` 加可空 `sectionId`。→ 需 migration。
2. **型別／驗證** — 新增 `Section`；issue 建立/更新加 `sectionId`。
3. **路由** — 區段 CRUD 與排序；issue payload 帶 `sectionId`。
4. **前端** — `IssuesList.tsx` 看板：依**區段**渲染欄位（與現有 status 看板並存為選項）；清單檢視加區段分組標題；支援拖放。

保留 status 與 sections 兩者：status 驅動引擎（heartbeat 生命週期），sections 純為組織用途；**勿**讓 status 兼差。

---

### Phase 4 — Custom Fields / 自訂欄位  ·  Effort: L · 🟡

**EN — Goal:** Asana-style reusable custom fields (text/number/select/multi-select/date/people).
1. **Schema** — `custom_fields` (`id, companyId, name, type, options jsonb`), `custom_field_settings` (`fieldId, projectId` — the many-to-many attach, mirroring Asana's split between definition and per-project setting), `custom_field_values` (`fieldId, issueId, value jsonb`). → migration.
2. **Types/validators** — field definitions, value payloads.
3. **Routes/services** — field library CRUD; attach/detach to project; read/write values on issues.
4. **UI** — field-library admin; render fields in issue detail; add as **columns** in list view and as **filters**; respect type validation.

This is a genuine subsystem (like Asana's). Scope it tight: ship `text/number/single-select/date` first; add `multi-select/people/formula` later.

**中文 — 目標：** Asana 式可重用自訂欄位（文字／數字／單選／多選／日期／人員）。
1. **Schema** — `custom_fields`（`id, companyId, name, type, options`）、`custom_field_settings`（`fieldId, projectId`，對應 Asana「定義」與「每專案設定」的拆分多對多）、`custom_field_values`（`fieldId, issueId, value`）。→ migration。
2. **型別／驗證** — 欄位定義與值的 payload。
3. **路由／服務** — 欄位庫 CRUD；專案掛載/卸載；issue 讀寫欄位值。
4. **前端** — 欄位庫管理；issue 詳情渲染欄位；清單檢視加為**欄位**與**篩選**；型別驗證。

這是完整子系統。請收斂範圍：先出 `文字／數字／單選／日期`，之後再加 `多選／人員／公式`。

---

### Phase 5 — Per-project access levels & privacy / 每專案存取層級與隱私  ·  Effort: XL · 🔴 **(hardest, security-critical)**

**EN — Goal:** Asana's defining model — a project can be **private**, and a person/agent has a **role on that project** (admin/editor/commenter/viewer) independent of their company role.

Why it's the hard one: today access = `assertCompanyAccess` only ([issues.ts](server/src/routes/issues.ts)); ALL company members see ALL projects. There are **no** per-project roles ([constants.ts:654](packages/shared/src/constants.ts#L654) PERMISSION_KEYS has none). This phase **rewrites the core authorization path.**

Build steps:
1. **Schema** — `project_members`: `projectId, principalType('user'|'agent'), principalId, projectRole('admin'|'editor'|'commenter'|'viewer')`. Add `visibility('company'|'private')` to `projects`. → migration. *(Note: this finally lets **agents** be project members — today `project_memberships` is `userId`-only.)*
2. **Authorization rewrite (🔴)** — new `assertProjectAccess(user/agent, projectId, requiredLevel)`; gate **every** read/write of a project and its issues by (a) company access AND (b) for `private` projects, project membership + sufficient role. Must update: `server/src/routes/issues.ts` (incl. the operator visibility filter at :1898), `projects` routes, comments, documents, and the agent-side `authorization.ts` action checks.
3. **Visibility filter upgrade** — replace today's "operator sees own-agent work only" with "member sees projects they belong to (any role) + own assignments." This is the change that finally enables your **"Project Omega: A=admin, B/C=members" cross-team scenario.**
4. **UI** — project "Share / 共用" dialog: add members, pick role; private-project lock icon; hide non-member projects from lists/search.

**Risk controls / 風險控管:** ship behind a feature flag (e.g. `PAPERCLIP_PROJECT_PRIVACY`); default OFF = current behavior; extensive authz tests before enabling; this is the phase most likely to leak data if wrong.

**中文 — 目標：** Asana 的招牌機制——專案可設為**私密**，且人員／agent 在該專案上擁有**專案層級角色**（admin／editor／commenter／viewer），獨立於公司角色。

為何最難：現況存取只有 `assertCompanyAccess`，**全公司成員看得到全部專案**；且**沒有**任何每專案角色。本階段會**改寫核心授權路徑**。

實作步驟：
1. **Schema** — `project_members`：`projectId, principalType('user'|'agent'), principalId, projectRole`；`projects` 加 `visibility('company'|'private')`。→ migration。*（這也讓 **agent** 終於能成為專案成員；現況 `project_memberships` 僅限 `userId`。）*
2. **授權改寫（🔴）** — 新增 `assertProjectAccess(...)`；對專案及其 issue 的**每一個**讀寫，依（a）公司存取「且」（b）私密專案需專案成員＋足夠角色來把關。需改：`issues.ts`（含 :1898 的 operator 可見性篩選）、`projects` 路由、留言、文件、以及 agent 端 `authorization.ts`。
3. **可見性升級** — 將現行「operator 只看自己 agent 的工作」改為「成員可看其所屬專案（任一角色）＋自己的指派」。這正是讓你的**「Project Omega：A 當 admin、B/C 當成員」跨團隊情境**得以成立的關鍵。
4. **前端** — 專案「共用」對話框：加成員、選角色；私密專案鎖頭圖示；非成員專案從清單／搜尋隱藏。

**風險控管：** 以 feature flag（如 `PAPERCLIP_PROJECT_PRIVACY`）包裹；預設關閉＝維持現行行為；啟用前需大量授權測試；本階段一旦寫錯最易造成資料外洩。

---

### Phase 6 — Deadlines + Calendar/Timeline view (per user & agent) / 期限＋行事曆‧時間軸檢視（依使用者與其 agent）  ·  Effort: M · 🟡

> ⚠️ **Prerequisite found in code / 程式碼中發現的前置需求：** Issues currently have **NO due-date field** — only `monitorNextCheckAt` (internal heartbeat scheduling). Projects only have `targetDate`. A deadline-driven calendar therefore needs a real due-date column added first. / Issue **目前沒有到期日欄位**，只有 `monitorNextCheckAt`（內部 heartbeat 排程）；專案僅有 `targetDate`。因此期限型行事曆需先新增真正的到期日欄位。

**EN — Goal:** a per-user **"My Calendar / 我的行事曆"** and **Timeline** that shows the deadlines of the issues *I* own and the issues *my agent(s)* own, plus project `targetDate`s.

Build steps:
1. **Schema** — add `dueDate` (and optional `startDate`) to `issues` (`packages/db/src/schema/issues.ts`). → migration.
2. **Types/validators** — add `dueDate`/`startDate` to issue create/update (`packages/shared`).
3. **UI — issue detail** — a date picker; show due date on issue rows/cards (`IssuesList.tsx`, `IssueRow`).
4. **UI — Calendar view** — month/week grid plotting issues by `dueDate`; **Timeline view** — horizontal bars from `startDate`→`dueDate` (Gantt-lite). Pure front-end over the issue list once the field exists.
5. **Per-user / per-agent scoping** — the calendar's default filter = `assigneeUserId == me` **OR** `assigneeAgentId ∈ my joined agents`. This reuses the **existing** operator-visibility logic ([issues.ts:1898](server/src/routes/issues.ts#L1898)) so each person naturally sees *their own + their agent's* deadlines, and admins can switch to a company-wide calendar. Add a "team" filter once Phase 1 ships.

This view is **the natural home for deadlines** and pairs with each user↔agent pairing: a 園長 sees her園長 agent's due tasks; 資訊部 staff see their IT agent's due tasks; the project lead/admin sees the whole project's timeline.

**中文 — 目標：** 每位使用者的 **「我的行事曆」** 與 **時間軸**，顯示**我**負責與**我的 agent**負責之 issue 的期限，加上專案 `targetDate`。

實作步驟：
1. **Schema** — 在 `issues` 新增 `dueDate`（與可選 `startDate`）。→ migration。
2. **型別／驗證** — issue 建立/更新加入 `dueDate`／`startDate`。
3. **前端‧issue 詳情** — 日期選擇器；issue 列／卡片顯示到期日。
4. **前端‧行事曆檢視** — 月／週格依 `dueDate` 標示 issue；**時間軸檢視** — 由 `startDate`→`dueDate` 的水平長條（簡易 Gantt）。欄位就緒後屬純前端。
5. **依使用者／agent 範圍** — 行事曆預設篩選＝`assigneeUserId == 我` **或** `assigneeAgentId ∈ 我已加入的 agent`。沿用**現有**的 operator 可見性邏輯（[issues.ts:1898](server/src/routes/issues.ts#L1898)），每人自然看到**自己＋自己 agent**的期限；admin 可切換為全公司行事曆。Phase 1 上線後再加「團隊」篩選。

此檢視是**期限的自然歸屬**，並與每組「使用者↔agent」配對相呼應：園長看自己園長 agent 的到期任務；資訊部看 IT agent 的到期任務；專案負責人／admin 看整個專案的時間軸。

---

### Phase 7 — Guests (external collaborators) / 訪客（外部協作者）  ·  Effort: M · 🟢

**EN —** Asana-guest pattern = external `viewer` users scoped via Phase-5 project membership. Depends on Phase 5. Additive, low risk.

**中文 —** Asana 訪客＝外部 `viewer` 使用者，透過 Phase 5 的專案成員機制限定範圍。相依於 Phase 5；屬新增功能、風險低。

---

### Phase 8 — Memory / Knowledge automation (server-side wiki distillation) / 記憶‧知識自動化（伺服器端 wiki 淬煉）  ·  Effort: L · 🟡

**EN —** Automatically distill Paperclip activity (issues, comments, documents) into a browsable knowledge wiki on a daily schedule — the "auto daily distill" goal.

**Why server-side (route B2), not the plugin's agent (B1):** the `plugin-llm-wiki` Wiki Maintainer agent is **blocked on claude-local** — it has neither the plugin's wiki tools (no MCP bridge to the agent run) nor filesystem access to the wiki root (sandbox). Proven by SEAAA-168's "runtime is missing the tooling" disposition. B1 (fixing that agent wiring) is large core/adapter work and depends on an unfinished alpha feature.

**Route B2 — server-side distill job (chosen):** the server already has full DB access to all Paperclip data AND write access to the wiki (files + DB), so a scheduled server job can read everything and write pages by calling an LLM directly — **bypassing the broken agent path entirely.**

Build steps:
1. A scheduled server job (daily cron, Asia/Taipei) that reads recent Paperclip issues/comments/documents (cursor-windowed, with caps).
2. Calls an LLM (Claude) with a distillation prompt → produces/updates wiki pages.
3. Writes pages directly to the wiki store (plugin DB `wiki_pages`/revisions + the wiki root files), in **OKF format** (markdown + YAML frontmatter — pairs with the OKF standard).
4. Records provenance + cost; respects per-run source caps.
5. Browse in the Paperclip UI (the wiki plugin's Wiki page) and/or as portable OKF files.

Fixes needed regardless: relocate the wiki root off the literal `server/~/seasonarts-wiki` path to a clean, server-writable location.

**中文 —** 每日自動將 Paperclip 活動（議題、留言、文件）淬煉成可瀏覽的知識 wiki ——即「每日自動 distill」目標。採**伺服器端**（B2）而非外掛的 agent（B1）：外掛的 Wiki Maintainer 在 claude-local 上**被卡住**（agent 取不到 wiki 工具、也無 wiki 根目錄的檔案權限，見 SEAAA-168）。B2 由伺服器直接讀 DB 全量資料、直接寫 wiki，呼叫 LLM 淬煉，**完全繞過壞掉的 agent 路徑**；以 OKF 格式（markdown＋YAML frontmatter）輸出，與 OKF 標準相容。

> **Status (shipped):** Route B2 deterministic distiller is live (no-LLM templated pages), wiki relocated to `~/seasonarts-wiki`, daily 23:59 job installed via `scripts/setup-wiki-distill.sh` (portable), on-demand `POST /companies/:id/wiki/distill` + a "Distill now" button (owner/admin), and the Wiki surface is gated to owners/admins via slot `minRole`. LLM-summarized prose is a future upgrade (swap the render* functions).

---

### Phase 9 — Custom-field columns & filtering / 自訂欄位的清單欄位與篩選  ·  Effort: M · 🟡

**EN —** Phase 4 added custom fields (definitions, per-project attach, per-issue values) shown on the **issue panel** + **project overview**. Phase 9 surfaces them in the **list view**: render each attached field as a **column** across issues, and let users **filter/group** by a field. Needs a batch endpoint (all field values for a project's issues in one query, to avoid N+1) + integration into the list/column system. **Columns first, filtering second.** Easier and lower-risk than Phase 5 (additive, no authz changes).

**中文 —** Phase 4 已加入自訂欄位（定義、依專案掛載、依議題值），顯示在**議題面板**與**專案總覽**。Phase 9 讓它們出現在**清單檢視**：把每個掛載欄位顯示成跨議題的**欄位（column）**，並可依欄位**篩選／分組**。需要一個批次端點（一次查詢取得整個專案所有議題的欄位值，避免 N+1）＋整合進清單欄位系統。**先做欄位顯示，再做篩選。** 比 Phase 5 簡單、風險低（純新增、不動授權）。

---

### Phase 5 addendum — Wiki data-API role gating / 補充：Wiki 資料 API 角色把關

The Wiki **UI** (sidebar + page) is already owner/admin-gated via slot `minRole`, and the distill action is server-checked. But the wiki plugin's **read API routes** are still `auth: "board"` (any authenticated user). Truly locking wiki *data* (so an operator can't query it directly) needs the caller's role plumbed into plugin **data** handlers (they currently receive only params, not actor context) — a host/SDK change. **Folded into Phase 5** (the access-control phase), since it's the same authz machinery.

---

## 4b. Assignment & Sharing — current reality / 指派與分享的現況

> Verified in code. This is what works **today**, before any phase is built.
> 程式碼實測。以下為**現況**（尚未實作任何階段前）。

| Action / 動作 | Today? | Detail / 說明 |
|---|---|---|
| Assign an issue to **another user** / 把 issue 指派給**其他使用者** | ✅ | `assigneeUserId` is settable by any operator+; viewers are read-only. Single assignee only. / 任何 operator 以上可設定 `assigneeUserId`；viewer 唯讀。**單一**受指派者。 |
| Assign an issue to **an agent** / 指派給 **agent** | ✅ | `assigneeAgentId`. The normal way work gets done. / 一般工作流程。 |
| Assign **a user to a project** / 把**使用者指派到專案** | ❌ | Projects only have `leadAgentId` (an agent). No user assignment until **Phase 2** (`ownerUserId`). / 專案僅有 `leadAgentId`；需 **Phase 2** 才有使用者擁有者。 |
| **Add/share others** onto an issue (followers/collaborators) / 在 issue 上**加入/分享**他人 | ❌ | Single assignee only; no followers list. Everyone in the company can already see it. / 僅單一受指派者，無關注者清單；公司成員本來就看得到。 |
| **Add/share others** onto a project / 在專案上**加入/分享**他人 | ❌ | Project membership is **self-service only** ([resource-memberships.ts:76](server/src/services/resource-memberships.ts#L76)) and is sidebar-only, not access. True "share with specific people" needs **Phase 5**. / 專案成員為**僅限本人**操作且只影響側邊欄；真正的「分享給特定人」需 **Phase 5**。 |

**Bottom line / 結論:** **Assigning** work (issues → users or agents) works today. **Curated sharing** (add specific people to a private project/issue, Asana-style) does **not** — it is unlocked by **Phase 5** (per-project membership + privacy). Because everything is currently company-wide visible, "adding" people is mostly unnecessary for *access* today; it only becomes meaningful once private projects exist. / **指派**工作（issue → 使用者或 agent）現在就能用；**精選分享**（把特定人加入私密專案/issue）目前**不行**，需 **Phase 5** 解鎖。由於現況全公司皆可見，「加人」在存取上多半是多餘的，唯有出現私密專案後才有意義。

---

## 3. Recommended order & build sizing / 建議順序與規模

| Phase | What / 內容 | Effort | Risk | Upstream-merge pain |
|---|---|---|---|---|
| 0 | Native setup / 原生設定 | S | 🟢 | none |
| 1 | Teams + sidebar folders / 團隊＋資料夾 | M | 🟡 | low (additive) |
| 2 | Project grouping/owner / 專案分組 | S–M | 🟡 | low |
| 3 | Sections / 區段 | M | 🟡 | medium (touches issues) |
| 4 | Custom fields / 自訂欄位 | L | 🟡 | medium |
| 5 | Per-project roles + privacy / 每專案角色＋隱私 | **XL** | 🔴 | **high (core authz)** |
| 6 | Deadlines + Calendar/Timeline (per user & agent) / 期限＋行事曆‧時間軸 | M | 🟡 | low–medium (adds `dueDate`) |
| 7 | Guests / 訪客 | M | 🟢 | low | low |
| 8 | Memory/Knowledge automation (server-side wiki distillation, route B2) / 記憶‧知識自動化 | L | 🟡 | medium |

**EN — Recommendation:** Do **0 → 1 → 6 → 3 → 5**, treating Phase 5 as its own project with a feature flag and a test plan; slot 2, 4, 7 in when needed. (Phase 6 is pulled early because deadlines + a per-user/agent calendar deliver high day-one value at low risk once `dueDate` is added.) Phase 5 is where ~70% of the risk lives — everything before it is additive and safe. If you never do Phase 5, you keep Asana's *shape* (teams, projects, sections, fields, board) but with Paperclip's **company-wide** security model (admins see all, operators see own work) instead of Asana's per-project security.

**中文 — 建議：** 依 **0 → 1 → 6 → 3 → 5** 進行，把 Phase 5 當成獨立專案（feature flag＋測試計畫）；2、4、7 視需要插入。（Phase 6 提前，因為加上 `dueDate` 後，期限＋依使用者/agent 的行事曆能以低風險帶來高即戰力。）約 **70% 的風險集中在 Phase 5**，之前各階段皆為新增、安全。若永不做 Phase 5，你仍保有 Asana 的**外形**（團隊、專案、區段、欄位、看板），但安全模型維持 Paperclip 的**全公司制**（admin 看全部、operator 看自己），而非 Asana 的每專案制。

---

## 4. Editability confirmation / 可改性確認

| Layer / 層 | Location / 位置 | Editable? |
|---|---|---|
| DB schema | `packages/db/src/schema/*` + Drizzle migrations | ✅ |
| Types / validators | `packages/shared/src/{types,validators}` | ✅ |
| API / services | `server/src/{routes,services}` | ✅ |
| Authorization | `server/src/services/authorization.ts`, `routes/authz.ts` | ✅ (🔴 careful) |
| UI | `ui/src/{pages,components}` | ✅ |

**EN —** All green — open source, full control. The only true costs are engineering time, migration discipline, and (for Phase 5) authorization-test rigor + upstream-merge maintenance.

**中文 —** 全部可改——開源、完全掌控。唯一真正的成本是工程時間、migration 紀律，以及（Phase 5）授權測試的嚴謹度與上游合併維護。
