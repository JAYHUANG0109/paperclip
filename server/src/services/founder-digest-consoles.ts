import type { ConsoleKey } from "./founder-digest.js";

/**
 * Server-side Asana layout for each daily-calendar console.
 *
 * Today these GIDs live only in each agent's AGENTS.md (free-form text), which
 * forces the AGENT to fetch + categorize Asana inside its model context every
 * run. Lifting them here lets the SERVER do the deterministic plumbing (fetch
 * sections → categorize → resolve private links → collect/dedupe comments +
 * subtasks → idempotency) and hand the agent a pre-built payload, so the agent
 * only spends tokens on the summary/批閱草稿 (see token-lightening #2).
 *
 * Additive only — nothing reads this yet. It's the foundation for the
 * server-side digest builder, which will be wired behind a per-console flag and
 * parity-checked against the current agent output before any switch.
 */

/** The 4 dashboard blocks, in render order. */
export type FounderCategory = "urgent" | "meetings" | "nonUrgent" | "reminders";

export interface ConsoleSectionRef {
  category: FounderCategory;
  /** Asana section GID whose (incomplete) tasks feed this category. */
  sectionGid: string;
}

export interface ConsoleAsanaLayout {
  /**
   * Asana sections that feed the 4 category blocks. A console may aggregate
   * more than one project (e.g. 市政 + 西屯), so this is a flat list of section
   * refs rather than one project.
   */
  sections: ConsoleSectionRef[];
}

/**
 * Per-console Asana layout. Populated for `founder` (verified from
 * 創辦人_tang's AGENTS.md, project 1211712817475632). The 園長 consoles
 * (principal = 仁美; principalZhengXitun = 市政+西屯) are pending — their section
 * GIDs are gathered from 吳家秀 / 王姿雅 / 哈哈Tracy's AGENTS.md before their
 * server-side path is enabled. Until a console appears here, it keeps using the
 * current agent-driven fetch.
 */
export const CONSOLE_ASANA_LAYOUT: Partial<Record<ConsoleKey, ConsoleAsanaLayout>> = {
  founder: {
    // Approvals (急件/非急件) come from the private board 🔒 創辦人私密批閱板 (唐姐)
    // (project 1216210456305653) — only 唐姐 can see it; her token reads it.
    // Meetings/reminders stay on 創辦人每日行事曆 (唐姐) (project 1211712817475632);
    // that project's old 待批閱 sections are now marked (停用).
    sections: [
      { category: "urgent", sectionGid: "1216210456305654" }, // 🔴 待批閱・急件 (私密批閱板)
      { category: "nonUrgent", sectionGid: "1216211675474057" }, // 🟡 待批閱・非急件 (私密批閱板)
      { category: "meetings", sectionGid: "1215720657642984" }, // 📅 今日會議與行程 (每日行事曆)
      { category: "reminders", sectionGid: "1215693863228590" }, // 🔔 提醒事項 (每日行事曆)
    ],
  },
};

/** True when the server has enough config to build this console's digest itself. */
export function hasServerSideLayout(consoleKey: ConsoleKey): boolean {
  return Boolean(CONSOLE_ASANA_LAYOUT[consoleKey]);
}
