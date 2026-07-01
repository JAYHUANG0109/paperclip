import { createContext, useContext } from "react";

/**
 * Curated Traditional-Chinese translations for the Skills store, plus a tiny
 * language context so the store's 中/EN toggle can flip skill names, descriptions
 * and category labels without threading a prop through the whole card tree.
 *
 * Skill names/descriptions come from each skill's author (English). This is a
 * hand-maintained override keyed by skill slug covering all shipped skills
 * (Paperclip bundled + @paperclipai/skills-catalog). Unknown slugs fall back to
 * the original English, so a new skill simply shows English until added here.
 */
export type SkillLang = "en" | "zh";

export interface SkillZh {
  name: string;
  description: string;
}

export const SKILL_ZH: Record<string, SkillZh> = {
  // ── Paperclip bundled ─────────────────────────────────────────────
  "diagnose-why-work-stopped": {
    name: "診斷工作為何停止",
    description: "診斷 Paperclip 任務為何停滯不前，找出根因並決定下一步。",
  },
  "index-refresh": {
    name: "索引重整",
    description:
      "當操作議題為索引重整（通常是每小時的例行重整）時使用：重建 wiki/index.md，讓每個條目都有標題、摘要與連結。",
  },
  "llm-wiki-maintainer": {
    name: "LLM Wiki 維護員",
    description: "使用 LLM Wiki 外掛工具，維護一份有引用出處的本地公司 Wiki。",
  },
  paperclip: {
    name: "Paperclip 控制平面",
    description:
      "透過 Paperclip 控制平面 API 管理任務、與其他代理協作、遵循公司治理。需要檢查指派、更新狀態、委派工作或呼叫 Paperclip 端點時使用。",
  },
  "paperclip-board": {
    name: "Paperclip 董事",
    description:
      "以董事身分透過聊天管理 Paperclip 公司：涵蓋導入（建立公司、設定 CEO、招募規劃）、代理管理與審批。",
  },
  "paperclip-converting-plans-to-tasks": {
    name: "將計畫轉為任務",
    description:
      "Paperclip 將計畫轉換為可執行任務的方法。在 Paperclip 內被要求規劃、界定範圍或拆解工作時使用。",
  },
  "paperclip-create-agent": {
    name: "建立代理",
    description:
      "在 Paperclip 中以具治理意識的方式招募、建立新代理。需要檢視 adapter 設定選項、比較既有代理時使用。",
  },
  "paperclip-create-plugin": {
    name: "建立外掛",
    description: "在 Paperclip 中建立新的外掛（plugin），依規範產出可安裝的外掛套件。",
  },
  "paperclip-dev": {
    name: "Paperclip 開發",
    description: "Paperclip 平台本身的開發工作：在此程式庫中進行修改、驗證與提交。",
  },
  "paperclip-distill": {
    name: "Paperclip 蒸餾／回填",
    description:
      "當操作議題為 Paperclip 的游標視窗、蒸餾（distill）或回填（backfill）——operationType 為 \"distill\" 或 \"backfill\"——時使用。",
  },
  "para-memory-files": {
    name: "PARA 記憶檔案",
    description:
      "採用 Tiago Forte 的 PARA 方法的檔案式記憶系統。需要儲存、取用、更新或整理知識時使用。",
  },
  "terminal-bench-loop": {
    name: "終端基準測試循環",
    description: "終端機基準測試（terminal-bench）的執行循環：逐題嘗試、驗證並記錄結果。",
  },
  "wiki-ingest": {
    name: "Wiki 匯入",
    description:
      "當操作議題要求把 raw/ 中已擷取的來源匯入 LLM Wiki，或使用者明確說「匯入 <slug>」時使用。",
  },
  "wiki-lint": {
    name: "Wiki 檢查",
    description:
      "當操作議題為 lint 或健康檢查（operationType: \"lint\"，通常是每晚的例行 lint 或手動「執行 lint」）時使用。",
  },
  "wiki-query": {
    name: "Wiki 查詢",
    description:
      "當操作議題要求你依 LLM Wiki 回答問題（operationType: \"query\"，議題內文含問題）時使用，並附上引用出處。",
  },
  // ── @paperclipai/skills-catalog ───────────────────────────────────
  "doc-maintenance": {
    name: "文件維護",
    description:
      "讓專案文件與近期程式碼與功能變更保持一致——偵測落差、更新受影響頁面，並在不重寫未變動內容的前提下補上與發布相關的說明。",
  },
  "issue-triage": {
    name: "議題分流",
    description:
      "分流 Paperclip 收件匣中停滯、受阻、審查中或已指派卻無進展的議題，為每則議題決定單一下一步（接續、改派、解除封鎖、升級或關閉）。",
  },
  "task-planning": {
    name: "任務規劃",
    description:
      "把 Paperclip 議題或需求轉為結構化的實作計畫，含子任務樹、封鎖項、負責人與驗收標準。",
  },
  wireframe: {
    name: "線框稿",
    description:
      "以獨立 SVG 檔製作低擬真度的黑白 UI 線框稿，並可選擇打包成單頁 HTML 版本。",
  },
  "qa-acceptance": {
    name: "QA 驗收",
    description:
      "為功能變更產出 QA 驗收標準與人工驗證計畫——涵蓋黃金路徑、邊界案例與錯誤狀態。",
  },
  "github-pr-workflow": {
    name: "GitHub PR 流程",
    description:
      "從功能分支準備 GitHub pull request——分支整理、commit 形態、標題／內文、驗證說明與截圖。",
  },
  "agent-browser": {
    name: "代理瀏覽器",
    description:
      "驅動真實瀏覽器檢視或操作網頁或應用程式——導覽、擷圖、讀取 console 與網路，用於驗證。",
  },
  "release-announcement": {
    name: "發布公告",
    description:
      "撰寫發布公告——變更紀錄、部落格文章、應用程式內通知或社群貼文——以使用者影響為主軸。",
  },
  "design-critique": {
    name: "設計評析",
    description:
      "提供結構化的產品設計評析——使用者任務清晰度、層次、可操作性、錯誤狀態與無障礙。",
  },
  last30days: {
    name: "近 30 天輿情",
    description:
      "研究人們在過去 30 天內對任何主題的真實討論，從 Reddit、X、YouTube 等平台擷取貼文與互動並附上出處。",
  },
};

/** Category / tag slug (lowercased) → Traditional Chinese label. */
export const CATEGORY_ZH: Record<string, string> = {
  design: "設計",
  paperclip: "Paperclip",
  "paperclip-operations": "Paperclip 營運",
  product: "產品",
  release: "發布",
  "release-notes": "發布說明",
  ux: "使用者體驗",
  acceptance: "驗收",
  announcement: "公告",
  browser: "瀏覽器",
  changelog: "變更紀錄",
  citations: "引用出處",
  "code-review": "程式碼審查",
  communication: "溝通",
  content: "內容",
  delegation: "委派",
  docs: "文件",
  documentation: "文件",
  github: "GitHub",
  inbox: "收件匣",
  issues: "議題",
  "last-30-days": "近 30 天",
  last30days: "近 30 天",
  planning: "規劃",
  quality: "品質",
  qa: "QA",
  validation: "驗證",
  verification: "驗證",
  testing: "測試",
  "pull-requests": "Pull Request",
  puppeteer: "Puppeteer",
  playwright: "Playwright",
  "software-development": "軟體開發",
  research: "研究",
  "social-media": "社群媒體",
  trends: "趨勢",
  reddit: "Reddit",
  x: "X",
  youtube: "YouTube",
  wireframe: "線框稿",
  prototyping: "原型設計",
  svg: "SVG",
  workflow: "工作流程",
  triage: "分流",
};

/** Localize a category/tag label. Falls back to the raw slug (English) in EN mode
 * or when there's no translation. */
export function localizeCategory(slug: string, lang: SkillLang): string {
  if (lang === "en") return slug;
  return CATEGORY_ZH[slug.trim().toLowerCase()] ?? slug;
}

/** Localize a skill's display name; falls back to the English name/slug. */
export function localizeSkillName(slug: string, englishName: string, lang: SkillLang): string {
  if (lang === "en") return englishName;
  return SKILL_ZH[slug]?.name ?? englishName;
}

/** The curated zh description for a slug, or null (caller falls back to English). */
export function skillDescriptionZh(slug: string): string | null {
  return SKILL_ZH[slug]?.description ?? null;
}

// ── Language toggle context ─────────────────────────────────────────
const SkillLangContext = createContext<SkillLang>("en");
export const SkillLangProvider = SkillLangContext.Provider;
export function useSkillLang(): SkillLang {
  return useContext(SkillLangContext);
}
