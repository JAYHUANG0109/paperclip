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
    sections: [
      { category: "urgent", sectionGid: "1215693863228588" }, // 🔴 待批閱・急件
      { category: "meetings", sectionGid: "1215720657642984" }, // 📅 今日會議與行程
      { category: "nonUrgent", sectionGid: "1215693863228589" }, // 🟡 待批閱・非急件
      { category: "reminders", sectionGid: "1215693863228590" }, // 🔔 提醒事項
    ],
  },
};

/** True when the server has enough config to build this console's digest itself. */
export function hasServerSideLayout(consoleKey: ConsoleKey): boolean {
  return Boolean(CONSOLE_ASANA_LAYOUT[consoleKey]);
}
