# 職務登錄 → 已移到技能內

職務四段（職掌 / 🔴最高原則 / 紅線 / 決策權限三層）的**唯一出處**是：

    skills/sa-agent-onboarding/references/roles/<職位>.md

放在技能裡而不是 `doc/` 底下，是因為 **agent 讀得到的是技能檔案，不是這個 repo**。
技能同步到 Paperclip 後，這些檔案會以 `references/roles/<職位>.md` 出現在
company skill `sa-agent-onboarding`，代理人才拿得到；留在 `doc/` 只有人看得到。

格式規範與命名規則見該資料夾的 `README.md`。
