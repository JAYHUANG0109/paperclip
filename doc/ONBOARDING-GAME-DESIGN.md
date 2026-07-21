# Onboarding game (關卡) — design for review

**Goal:** every new user learns the platform by *doing* — a short, gamified series
of easy, interactive 關卡 (levels) their agent walks them through, in their default
language. Platform-started users (not just Google-Chat starters) get an onboarding
message on their first task; setup (Asana token etc.) comes first with TC tutorials
+ direct links; then 5 sequential 關卡 unlock one-by-one. Tested on Jay's agent first.

> STATUS: design for Jay's review. **No build until approved.**

## 1. UX flow (what the user experiences)
1. New user lands on the platform. Their agent's board already shows a **「🎓 上手教學」**
   project with **關卡 1** open and 關卡 2–5 locked (greyed, "完成上一關解鎖").
2. On their **first task** (whether the seeded 關卡 1 or a real task they create), the
   agent's *first* response is the onboarding walkthrough — starting with **setup**
   (Asana token + connections) via interactive cards with **step-by-step TC tutorials
   and direct links** (as few clicks as possible).
3. Each 關卡 = a tiny lesson delivered as **interactive cards** (click / select) + one
   hands-on action, ending with a **「完成本關 ✅」** button. Completing it **unlocks the
   next**. Progress shows as "第 N / 5 關".
4. Finish all 關卡 → "🎉 上手完成", the 教學 project auto-archives, agent switches to
   normal work.

## 2. State model (proposed — no migration for v1)
The **關卡 tasks themselves are the source of truth** for progress (issue status +
sequential blockers). A light mirror on `agent.metadata.onboarding` powers a progress
badge:
```
agent.metadata.onboarding = { stage: 2, total: 5, completedKeys: ["setup","first-task"], status: "in_progress"|"done", startedAt, completedAt }
```
No new table for v1 (graduate to an `onboarding_progress` table only if we need
cross-agent reporting).

## 3. Trigger & gating (reuse existing primitives)
- **Seed on provisioning:** when a new agent/user is created, seed 5 onboarding issues
  in the 「🎓 上手教學」 project, chained with **issue blockers** (關卡 k+1 `blocked_by`
  關卡 k) so only the current one is actionable — the game's "unlock" is just
  dependency resolution we already have.
- **First-task onboarding message:** detect "user has no prior self-created tasks"; on
  that first wake, an AGENTS.md onboarding rule has the agent run the walkthrough
  (cards) before normal handling. If they create a *real* task while onboarding is
  incomplete, the agent gently points them to finish 上手教學 first (offer, not a hard block).
- **Interactive cards:** reuse the existing `ask_user_questions` / `request_confirmation`
  cards (no new card type for v1) for the click/select lesson steps + the 完成 button.

## 4. Proposed 5-關卡 curriculum (core) — for your approval
| 關卡 | 名稱 | 學會什麼 | 動手做 (unlock gate) |
|---|---|---|---|
| 1 | 設定與連線 | Asana 權杖、連接器；為什麼需要 | 完成連線（附教學連結）→ 驗證通過 |
| 2 | 建立第一個任務 | 新增任務、指派給你的 agent、寫清楚驗收 | 建一個真的任務並指派 |
| 3 | 與 agent 協作 | 互動卡片、審批鈕、留言、裁示 | 回應一張 agent 卡片（核准/留言） |
| 4 | 儀表板與收件匣 | 找到「待我處理」、通知、狀態 | 在儀表板找到並開啟一個項目 |
| 5 | 技能與例行作業 | 技能是什麼、如何觸發；例行排程 | 瀏覽技能庫 / 看一個 routine |
Optional advanced 關卡 (6–10, later): Wiki、匯入你的 Claude 記憶、升級/求援、跨部門協作。

## 5. Language
關卡 templates authored in **TC + EN**; the agent renders each user's cards in their
**default language** (TC when default), following `tang-voice-rules`/the language rules.

## 6. Implementation plan (behind a flag, phased)
- **Phase 1 — data & seed:** `agent.metadata.onboarding` shape + a seeder that creates
  the 「🎓 上手教學」 project + 5 blocker-chained 關卡 issues for a target agent. (idempotent)
- **Phase 2 — agent behavior:** an AGENTS.md「上手教學」section (or a small skill) that
  drives each 關卡's card flow + the 完成→unlock + progress mirror, and the first-task
  intercept.
- **Phase 3 — setup tutorial content:** 關卡 1 cards with the **real** token-setup steps +
  direct links (need the existing tutorial URLs from Jay).
- **Phase 4 — UI polish (optional):** locked-關卡 styling + "第 N/5 關" badge on the board.
- **Phase 5 — test on `jay20020109`:** seed for Jay, run all 5 關卡 end-to-end, confirm
  unlock gating + language + completion, then roll out (flag on).

## 7. Open decisions for Jay
1. **State:** OK with `agent.metadata.onboarding` (no migration) for v1? (vs a table)
2. **First-task intercept:** gentle "finish 上手教學 first" *offer*, or hard-block real
   tasks until onboarding done?
3. **Curriculum:** approve the 5 核心關卡 above (edit/reorder as you like), and which
   optional advanced 關卡 (if any) for v1.
4. **Setup tutorial links:** where are the existing Asana-token / connector tutorials
   (URLs/docs) so 關卡 1 links straight to them?
5. **Seeding scope:** seed for **all existing** users too, or only **new** users going
   forward (+ Jay for the test)?
6. **Cards:** reuse existing interactive cards (recommended) — confirm.

## 8. Rollout / safety
Flag-gated; seeder is idempotent + reversible (archive the 教學 project + clear the
metadata). Tested on Jay's agent before any broader rollout. No auto-deploy until the
end-to-end test on `jay20020109` passes and you sign off.
