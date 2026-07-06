# Paperclip 團隊上手指南（Season Arts）

歡迎一起開發 Paperclip！這份是給團隊成員的**本機開發**快速上手說明。
（想看完整的 PR 規範與貢獻流程，請看 [`CONTRIBUTING.md`](./CONTRIBUTING.md)。）

## 前置需求
- **Node.js 20+**、**pnpm 9.15+**、git
- （選配）要在本機測試 **AI 代理人執行**時：自己的 `claude` CLI 登入（OAuth）或 Anthropic API key；若測 Asana／Google，需自己的整合 token

## 快速開始（三行）
```bash
git clone https://github.com/JAYHUANG0109/paperclip.git
cd paperclip
pnpm install
pnpm dev            # API + UI：http://localhost:3100
```
第一次執行會**自動建立內嵌的 PostgreSQL**，不需要另外安裝資料庫。每個人都有自己本機的 Postgres 與檔案儲存。

## 你會拿到 / 不會拿到
- ✅ **會**：一個全新、空的本機環境（自己的沙盒公司），可自由開發與測試。
- ❌ **不會**：線上 Season Arts（SEAAA）的資料。以下都刻意**不放進 git**、只存在託管正式站的那台 Mac 上：
  - 內嵌 Postgres **資料庫**（所有代理人、任務、歷史）
  - 各代理人的 **Asana／Google token**、`asana-connection.json`
  - 機密設定 **`.env`**、`master.key`
  - `~/.paperclip/instances/...` 實例設定與各代理人的 `AGENTS.md`

想看接近真實的資料，請找 Jay 要一份**去識別化的種子資料**，不要共用任何 token。

## 測試 AI 代理人
只是開 UI／看資料庫不需要額外設定。要真的跑代理人時，在自己機器上提供**自己的**模型授權（`claude` 登入或 API key）與整合 token —— 不會、也不應該從別人的環境共用。

## 協作流程
1. 開分支開發（若要直接 push 到本 repo，需先被加為協作者；否則 fork 後開 PR）。
2. 對 `main` 開 **Pull Request**（詳細規範見 `CONTRIBUTING.md`）。
3. 合併進 `main` 後，由 **Jay** 在託管正式站的 Mac 上執行部署，變更才會上線。
   - 部署指令是 `ops/deploy.sh deploy`（藍綠部署，會自動健康檢查與回滾）。
   - ⚠️ 不要用 `pnpm deploy:live`（已淘汰，不會更新正在運行的正式站）。

## 重要規則
- 🔒 **絕不** commit 機密：`.env`、`master.key`、任何 token、`asana-connection.json`、資料庫。（這些已被 `.gitignore` 排除，別繞過。）
- 🖥️ **別在託管正式站的那台筆電上跑 `pnpm dev`** —— 它和正式站都用 **3100** 埠，會衝突。在自己的機器上則沒問題。
- 團隊成員**無法**部署到正式站（部署綁定 Jay 的筆電 + launchd + Tailscale funnel）。上線一律走 PR → 合併 → 由 Jay 部署。

## 常用指令
```bash
pnpm dev            # 完整開發（API + UI，watch 模式）
pnpm dev:server     # 只跑後端
pnpm dev:ui         # 只跑前端
pnpm build          # 全部建置
pnpm typecheck      # 型別檢查
pnpm test           # 單元測試（Vitest）
pnpm db:migrate     # 套用資料庫 migration
```

有問題找 **Jay**。祝開發愉快！
