---
name: 四季校端團隊
description: 四季藝術單一校區的完整教職團隊原型：園長／副園長帶領，含幼教／ESL 教學主管、活動主管、跨校巡輔組長、幼教／ESL 行政、註冊組、總務會計、校護。依職務別提供一致的 scope 與執掌，讓依角色建立 agent 更快、更一致（同職務／同職級共用同一份 scope 與 instructions）。
schema: agentcompanies/v1
slug: seasonarts-campus
category: education
key: paperclipai/optional/education/seasonarts-campus
manager: agents/principal/AGENTS.md
includes:
  - agents/preschool-teaching-lead/AGENTS.md
  - agents/activity-lead/AGENTS.md
  - agents/esl-teaching-lead/AGENTS.md
  - agents/floating-group-lead/AGENTS.md
  - agents/preschool-admin/AGENTS.md
  - agents/esl-admin/AGENTS.md
  - agents/registrar/AGENTS.md
  - agents/general-affairs-accounting/AGENTS.md
  - agents/school-nurse/AGENTS.md
defaultInstall: false
recommendedForCompanyTypes:
  - education
tags:
  - seasonarts
  - education
  - campus
  - 幼教
---

# 四季校端團隊

單一校區的完整教職團隊原型。安裝後會依職務別建立一組 agent，並套上正確的直接主管（週誌主簽者）報告關係，讓「依角色建立 agent」變成一次到位、且同職務共用相同 scope／instructions。

## 成員（校端職務）

- **園長／副園長**（`principal`，本團隊 manager）— 園務決策、主管批閱、巡堂與教學品質、跨校支援、家長重大事件。上層回報創辦人／領導團隊。
- **幼教教學主管**（`preschool-teaching-lead`）— 班級燈號、方案課程、進班輔導、中師與專業教師管理。
- **活動主管**（`activity-lead`）— 活動統籌企劃、執行追蹤、中外師協同、對內外專案。
- **ESL 教學主管**（`esl-teaching-lead`）— ESL 教學管理、美語籌備輔導、外師團隊、跨校輔導。
- **不帶班班群組長**（`floating-group-lead`）— 跨校巡輔、組長帶領、跨校共備、資源擴散。
- **幼教行政**（`preschool-admin`）— 行事曆、教學支援、教育訓練、人事、數位系統、公部門作業。
- **ESL 行政**（`esl-admin`）— ESL 排課合約人事、跨校協調、政府系統、行政訓練。
- **註冊組**（`registrar`）— 親師溝通、招生接待、帳務、校務、公部門、保險。
- **總務會計**（`general-affairs-accounting`）— 採購庶務、會計預算、環境修繕、資產、福利。
- **校護**（`school-nurse`）— 傷病護理、傳染病通報防疫、衛生所配合、健康宣導、環境稽查。

除園長／副園長外，所有成員 `reportsTo` 均為 `principal`；實際主管以週誌主簽者為準。總部（跨校）職務不在本團隊內，依跨校分工資料另建。

來源：doc/agent-role-catalog.md（週誌模板職務提醒清單＋114-1 新人師訓簡報）。
