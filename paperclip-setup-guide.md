# Seasonarts — Paperclip + Telegram + Odoo MCP 完整建置指南

> **用途：** 將此文件貼入 Claude Code (VS Code) 作為 Paperclip 專案的建置任務。
> 按照以下步驟依序執行，完成 Paperclip 伺服器、Telegram 整合、Odoo MCP 連線的完整設定。

---

## 架構總覽

```
員工在 Telegram 輸入訊息
        ↓
paperclip-plugin-telegram（接收訊息）
        ↓
paperclip-plugin-acp（建立/恢復 Claude Code 工作階段）
        ↓
Claude Code agent（已設定 Odoo MCP）
        ↓
Odoo MCP Server → Odoo（讀寫 ERP 資料）
        ↓
回應沿原路返回：agent → ACP → Telegram 插件 → 員工在 Telegram 看到回覆
```

同時，你（Board / 管理者）可以透過 Paperclip 的 Web UI（localhost:3100）檢視所有對話紀錄、核准請求、監控成本。

---

## 前置需求確認

在開始之前，請確認以下環境：

```bash
# 確認 Node.js 版本（需 20+）
node -v

# 確認 pnpm 版本（需 9.15+）
pnpm -v

# 確認 git
git -v

# 確認 Claude Code CLI 可用
claude --version

# 確認 Python（Odoo MCP 需要）
python3 --version
pip3 --version
```

---

## 第一階段：Paperclip 伺服器設定

### 1.1 如果尚未 clone，先取得 Paperclip

```bash
git clone https://github.com/paperclipai/paperclip.git
cd paperclip
pnpm install
```

### 1.2 啟動 Paperclip

```bash
pnpm dev
```

這會在 `http://localhost:3100` 啟動 API 伺服器和 UI。
內建的 PostgreSQL 會自動建立，不需額外設定。

### 1.3 完成 Onboarding（如果尚未完成）

在瀏覽器打開 `http://localhost:3100`，依照以下填寫：

**Company 頁面：**
- Company name: `Seasonarts`
- Mission / goal:

```
Build an AI-native operations layer for Seasonarts — unify all business systems (Odoo ERP, CRM, inventory, invoicing, communications) under a single orchestration platform. Connect Odoo via MCP for full CRUD access to all business data. Enable employee interaction through Telegram as the primary AI interface. Automate 30% of repetitive workflows within year one, establish foundation for multi-agent organization where AI handles observation, analysis, reporting, and task delegation. Scale to 50% automation in year two, 90% in year three.
```

**Agent 頁面：**
- Agent name: `CEO_agent`
- Adapter type: `Claude Code`
- Model: `Claude Opus 4.7`（或你可用的最新版本）

**Task 頁面（替換預設任務）：**
- Task title:

```
Map Seasonarts operations and establish AI automation foundation
```

- Description:

```
You are the operations strategist for Seasonarts. This is your first task to establish the AI automation foundation.

Phase 1 — Organizational mapping:
- Document the current organizational structure (departments, roles, key workflows)
- Identify the company's primary business processes in Odoo (sales, purchasing, inventory, invoicing, HR)
- List all Odoo modules currently in use or planned

Phase 2 — Pain point assessment:
- Identify the top 10 most repetitive, time-consuming tasks across the company
- For each task, assess: frequency, average time spent, severity (1-5), AI automation potential (low/medium/high)
- Prioritize by ROI (time saved × frequency × severity)

Phase 3 — Automation roadmap:
- Create a phased implementation plan:
  - Month 1-3: Foundation (Odoo MCP connection, basic reporting agents)
  - Month 4-6: Core automation (invoice processing, inventory alerts, daily reports)
  - Month 7-12: Advanced (multi-agent delegation, management-level digital twin)
- Define success metrics for the 30% automation target

Phase 4 — Agent hiring plan:
- Recommend which specialist agents to hire next (e.g., Finance Agent, Inventory Agent, HR Agent)
- Define each agent's role, responsibilities, and which Odoo modules they need access to
- Propose an org chart for the AI workforce

Output all findings as structured documents in the workspace.
```

---

## 第二階段：安裝 Telegram 插件

### 2.1 建立 Telegram Bot

1. 在 Telegram 中搜尋 `@BotFather`
2. 發送 `/newbot`
3. 設定名稱，例如 `Seasonarts AI`
4. 設定 username，例如 `seasonarts_ai_bot`
5. **保存 BotFather 給你的 API token**（格式像 `123456789:ABCdefGHIjklMNO-pqrSTUvwxYZ`）

### 2.2 安裝 Telegram 插件

在 Paperclip 的目錄中：

```bash
# 透過 Paperclip API 安裝插件
curl -X POST http://127.0.0.1:3100/api/plugins/install \
  -H "Content-Type: application/json" \
  -d '{"packageName":"paperclip-plugin-telegram"}'
```

或者手動安裝：

```bash
cd paperclip
pnpm add paperclip-plugin-telegram
```

### 2.3 設定 Telegram 插件

安裝後，在 Paperclip UI 中：
1. 前往 **Settings → Plugins**
2. 找到 Telegram 插件
3. 設定以下參數：
   - `TELEGRAM_BOT_TOKEN`: 你從 BotFather 取得的 token
   - `TELEGRAM_COMPANY_ID`: 你的 Seasonarts 公司 UUID（可從 Paperclip URL 或 API 取得）

如果是環境變數方式，在 `.env` 或 Paperclip config 中加入：

```env
TELEGRAM_BOT_TOKEN=your_bot_token_here
```

### 2.4 安裝 ACP 插件（Agent Client Protocol — 讓 Telegram 可以觸發 agent）

```bash
curl -X POST http://127.0.0.1:3100/api/plugins/install \
  -H "Content-Type: application/json" \
  -d '{"packageName":"paperclip-plugin-acp"}'
```

ACP 是 Telegram 和 agent 之間的橋樑。沒有它，Telegram 收到的訊息無法觸發 Claude Code session。

### 2.5 測試 Telegram 連線

1. 在 Telegram 找到你的 bot
2. 發送 `/start`
3. 發送一條測試訊息，例如 `hello`
4. 回到 Paperclip UI 確認是否收到訊息、agent 是否被觸發

---

## 第三階段：Odoo MCP 連線

### 3.1 選擇 Odoo MCP Server

有兩種主要方案：

**方案 A — 開源 mcp-server-odoo（推薦用於測試）：**

```bash
# 安裝開源 Odoo MCP server
pip3 install mcp-server-odoo
```

**方案 B — Odoo Apps Store 的 MCP Server 模組（推薦用於正式環境）：**
在 Odoo 的 Apps Store 安裝 `mcp_server` 模組，直接在 Odoo 實例上啟用 MCP 端點。

### 3.2 設定 Odoo MCP 連線參數

建立設定檔 `~/.odoo-mcp-config.json`：

```json
{
  "url": "https://your-odoo-instance.com",
  "db": "your-odoo-database-name",
  "username": "your-odoo-username",
  "password": "your-odoo-api-key-or-password"
}
```

> **安全提醒：** 建議使用 Odoo API Key 而非密碼。在 Odoo 中前往 Settings → Users → 你的帳號 → Security tab → API Keys 來產生。

### 3.3 測試 Odoo MCP Server 是否能連上你的 Odoo

```bash
# 啟動 MCP server 測試
mcp-server-odoo --config ~/.odoo-mcp-config.json
```

確認沒有連線錯誤後 Ctrl+C 停止。

### 3.4 設定 Claude Code agent 使用 Odoo MCP

Claude Code 使用 MCP server 的設定檔位於 `~/.claude/mcp.json`（全域）或專案目錄的 `.claude/mcp.json`。

在你的 Paperclip 專案目錄建立或編輯 `.claude/mcp.json`：

```json
{
  "mcpServers": {
    "odoo": {
      "command": "mcp-server-odoo",
      "args": ["--config", "/absolute/path/to/.odoo-mcp-config.json"],
      "env": {
        "ODOO_URL": "https://your-odoo-instance.com",
        "ODOO_DB": "your-odoo-database-name",
        "ODOO_USERNAME": "your-odoo-username",
        "ODOO_PASSWORD": "your-odoo-api-key"
      }
    }
  }
}
```

> **注意：** 根據你使用的 mcp-server-odoo 版本，參數傳遞方式可能不同。有些版本只讀環境變數，有些接受 config 檔。請以該套件的 README 為準。

### 3.5 驗證 agent 可以存取 Odoo

在 Paperclip 中建立一個測試任務：

```
Test Odoo MCP connection — list all available Odoo models, then search for 5 recent contacts (res.partner) and 5 recent invoices (account.move). Report the results.
```

如果 agent 能成功列出資料，MCP 連線就算完成。

---

## 第四階段：Tailscale 遠端存取（可選，但推薦）

如果你想從外部（手機、其他電腦）存取 Paperclip：

```bash
# 安裝 Tailscale
curl -fsSL https://tailscale.com/install.sh | sh

# 啟動並登入
sudo tailscale up

# 確認你的 Tailscale IP
tailscale ip -4
```

之後從任何有 Tailscale 的裝置，用 `http://<tailscale-ip>:3100` 存取 Paperclip。

啟動 Paperclip 時綁定 Tailscale：

```bash
npx paperclipai onboard --yes --bind tailnet
```

---

## 第五階段：完整工作流程驗證清單

完成以上所有步驟後，依序驗證：

```
[ ] Paperclip 在 localhost:3100 可存取
[ ] Seasonarts 公司已建立，mission 已填寫
[ ] CEO_agent 已建立，使用 Claude Code adapter
[ ] 第一個任務已建立且 agent 可以執行
[ ] Telegram bot 已建立（@BotFather）
[ ] paperclip-plugin-telegram 已安裝
[ ] paperclip-plugin-acp 已安裝
[ ] Telegram bot token 已設定在插件中
[ ] 在 Telegram 發訊息可觸發 agent
[ ] Odoo MCP server 已安裝
[ ] Odoo 連線參數已設定
[ ] .claude/mcp.json 已設定 Odoo MCP
[ ] Agent 可以讀取 Odoo 資料（contacts, invoices）
[ ] Agent 回應會出現在 Telegram 對話中
[ ] Paperclip UI 可以看到所有 Telegram 對話紀錄
```

---

## 常見問題排除

### Telegram 訊息發了但 agent 沒反應
- 確認 ACP 插件有安裝且啟用
- 確認 Telegram 插件中的 company ID 正確
- 確認有 agent 被指定為可接收 Telegram 訊息
- 查看 Paperclip 的 terminal log 有無錯誤

### Odoo MCP 連線失敗
- 確認 Odoo 的 XML-RPC 端口有開放
- 確認用的是 API Key 而非一般密碼
- 確認 Odoo URL 不帶尾端斜線
- 試試直接用 curl 測試 Odoo 的 XML-RPC：
```bash
curl -X POST https://your-odoo.com/xmlrpc/2/common \
  -H "Content-Type: text/xml" \
  -d '<?xml version="1.0"?><methodCall><methodName>version</methodName></methodCall>'
```

### Agent 執行但看不到 Odoo 工具
- 確認 `.claude/mcp.json` 在正確的目錄
- 重啟 Paperclip
- 在 Claude Code CLI 中直接測試：`claude --mcp-config .claude/mcp.json`

---

## 下一步（完成以上之後）

1. **建立更多專業 agent** — 財務 Agent、庫存 Agent、HR Agent
2. **設定 Heartbeat 排程** — 讓 agent 每天早上自動執行任務（掃描異常、生成日報）
3. **建立 SKILL** — 將重複的工作流程封裝成 SKILL，agent 可以反覆執行
4. **安裝 paperclip-plugin-hindsight** — 給 agent 長期記憶
5. **建立 Budget 限制** — 設定每個 agent 的月度 token 預算
6. **開放給團隊** — 設定更多 Telegram 群組/頻道，讓不同部門的員工透過 Telegram 與對應的 agent 互動
