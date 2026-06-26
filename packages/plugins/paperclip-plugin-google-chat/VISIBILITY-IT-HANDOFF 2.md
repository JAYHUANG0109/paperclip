# 讓 SeasonartsAI 對全機構可見 — 給資訊部 (IT) 的設定說明

> Making the SeasonartsAI Google Chat app available org-wide. Hand this to the
> Google Workspace **super-admin** (賴忠泰 / 資訊部). Jay has Google Cloud project
> access but **not** super-admin, so Part B must be done by an admin.

## 背景 / Why this is needed

目前 Google Cloud Console 的 Chat API 設定裡，「提供給特定使用者和群組」這個選項
**最多只能填 5 個開發測試用的 email**（這就是為什麼現在只有 jay20020109 和
claude_bot_08 看得到 bot）。

要讓 **全 seasonart.org**（或某個群組）都能加入 SeasonartsAI，Google 要求兩件事：

1. 把這個 Chat 應用程式**發布到 Google Workspace Marketplace**（可設為**私人 /
   僅限本機構**，不需對外公開）。
2. 由 **Workspace 超級管理員**在管理控制台把它**加入許可清單 (allowlist)**。

> 安全性：開放「可見 / 可加入」是安全的——**誰能真正得到 bot 回覆，是由 Paperclip
> 內部控管的**（見最後一節）。沒有被指派 agent 的人只會收到「請聯絡資訊部設定」的訊息。

---

## Part A — 發布為私人 Marketplace 應用程式（GCP，Jay 可協助）

專案：**vital-defender-490707-b6（Paperclip Seasonarts）**，專案編號 455778754146。

1. Google Cloud Console → **APIs & Services → 啟用 API**，啟用
   **Google Workspace Marketplace SDK**。
2. 進入 **Google Workspace Marketplace SDK → App Configuration**：
   - **Visibility / 瀏覽權限**：選 **Private（僅 seasonart.org）**。
   - **App integrations**：勾選 **Google Chat app**（連到現有的 Chat 設定）。
   - 填好 OAuth scopes（沿用現有的 `chat.bot`）。
3. **Store Listing**：填應用程式名稱 `SeasonartsAI`、圖示、簡短說明、開發者 email。
4. 按 **Publish**（私人發布，只在本機構內生效）。

## Part B — 在管理控制台加入許可清單（**只有超級管理員能做**）

1. 登入 **admin.google.com** → **應用程式 (Apps) → Google Workspace Marketplace 應用程式**。
2. **應用程式清單 (Apps list) → 新增應用程式 (Add app)** → 選
   **「新增私人應用程式 / Add private app」**，找到剛發布的 SeasonartsAI。
3. 加入後設定存取範圍：
   - **整個機構 (ON for everyone)**，或
   - **指定的機構單位 (OU) 或 Google 群組**（建議：建一個如 `paperclip-users@seasonart.org`
     的群組，分批開放，比較好控管）。
4. 儲存。

> ⚠️ 群組 / 網域層級的變更**最多可能要 24 小時**才會生效。

## Part C — 確認 Chat API 設定

回到 Chat API → **設定 (Configuration)**：

- 一旦完成 Part B 的許可清單，**「群組」或「整個網域」的瀏覽權限選項才會真正生效**。
- 此時可以把「特定使用者和群組」那 5 個開發用 email 清掉，改選群組 / 網域。
- 確認 **Authentication Audience = 專案編號 (455778754146)**、應用程式狀態為 **運作中 / Live**。

---

## 決策點 / Decisions for IT + Jay

| 問題 | 建議 |
|------|------|
| 開放給誰？ | 先開給一個 **Google 群組**（受控的試行名單），確認穩定後再擴大到整個網域。 |
| 不想發布 Marketplace？ | 唯一不需要管理員的路徑就是現在這個「≤ 5 個 email」清單。群組 / 網域**一定**要走 Part A+B。 |

## 為什麼開放可見是安全的 / Access is still controlled in Paperclip

即使全機構都看得到、加得到 SeasonartsAI，**只有在 Paperclip 內被指派 agent 的人**才會
得到實際回覆：

- 指派在 **Paperclip → 公司設定 → Google Chat** 頁面管理（email → agent）。
- 沒有指派的人傳訊息，bot 只會回覆：「您目前還沒有專屬的 AI 助理，請聯絡資訊部 (IT)
  設定」，而且**不會**啟動任何 agent。
- 這個 gating 預設為**開啟**（plugin 設定的「Restrict to assigned users」）。

所以：可以放心地把「可見範圍」開大，存取控制由我們自己掌握。
