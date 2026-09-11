import { useCallback, useEffect, useState } from "react";
import type { Agent } from "@paperclipai/shared";
import { parseTeamToken } from "@paperclipai/shared";

// An agent's team membership, read from metadata. Asana-style multi-team:
// metadata.teams (string[]) — an agent may belong to several teams. Falls back
// to metadata.team (string). Mirrors the sidebar's grouping logic so the
// Agents page, the office, and the sidebar all agree on team names.
export function agentTeams(agent: Pick<Agent, "metadata">): string[] {
  const md = agent.metadata as Record<string, unknown> | null;
  if (!md) return [];
  const out: string[] = [];
  const raw = md.teams;
  if (Array.isArray(raw)) {
    for (const t of raw) if (typeof t === "string" && t.trim().length > 0) out.push(t.trim());
  } else if (typeof md.team === "string" && md.team.trim().length > 0) {
    out.push(md.team.trim());
  }
  return out;
}

// English labels for the org's Chinese team names, so team folders/chips read in
// English when the platform language is English. Unmapped teams fall back to their
// original name. Only the DISPLAY label is localized — grouping/filtering still
// keys off the raw (Chinese) team name, so this is display-only and safe.
const TEAM_EN: Record<string, string> = {
  // Leadership groups. 園長團隊 was disbanded on 2026-09-11 and its ranks became
  // independent top-level groups (doc/sa-org-chart.md); the two disbanded names
  // stay listed so terminated agents and old shares still label in English.
  "創辦人": "Founder",
  "總園長": "Head Principal",
  "園長 & 處長": "Principals & Directors",
  "園長團隊": "Principals",
  "領導團隊": "Principals", // pre-2026-09-01 name; kept so old data still labels
  "園長": "Principal",
  "處長": "Director",
  "系統自動化": "System Automation",
  "教學組": "Teaching",
  "人才發展": "Talent Development",
  // Campuses (top level) — romanized district names
  "仁美": "Renmei",
  "市政": "Shizheng",
  "西屯": "Xitun",
  "黎明": "Liming",
  "北屯": "Beitun",
  "總管理處": "General Administration",
  // Departments / teams (second level)
  // The preschool group's own history: 幼教學組 (code-only, no live members) was
  // consolidated onto 幼教教學組 on 2026-09-04, which was then renamed 幼教主管 on
  // 2026-09-11. Both old spellings stay listed so terminated agents and any old
  // scope string still translate instead of rendering raw Chinese.
  // Renamed 2026-09-11: the top-level group is the supervisor layer, its
  // sub-teams (幼教教學／幼教行政) are unchanged. Old names kept as aliases.
  "幼教主管": "Preschool Leads",
  "幼教教學組": "Preschool Leads",
  "幼教學組": "Preschool Leads",
  "幼教教學": "Preschool Instruction",
  "幼教行政": "Preschool Administration",
  "ESL教學": "ESL Instruction",
  "ESL行政": "ESL Administration",
  "外師教學組": "Foreign Teachers",
  "ESL主管": "ESL Leads",
  "ESL教學組": "ESL Leads",
  "註冊組": "Registration",
  "總務管理組": "General Affairs",
  "跨校巡輔": "Cross-Campus Support",
  "園務": "School Leadership",
  "處長室": "Director's Office",
  "秘書室": "Secretariat",
  "行銷部": "Marketing",
  "視覺部": "Visual Design",
  // 資訊部 / 人發部 are the canonical names (renamed 2026-09-03, owner's call).
  // The long spellings stay listed because existing agents and team-scoped
  // skills still carry them, and an unmapped name renders raw Chinese to
  // English users.
  "資訊部": "IT",
  "數位資訊部": "IT",
  "人發部": "Talent Development",
  "人才發展部": "Talent Development",
  "品牌發展部": "Brand Development",
  "基金會": "Foundation",
  "採購工程部": "Procurement & Engineering",
  "財務部": "Finance",
  "餐飲部": "Food & Beverage",
};

/** Display label for a team name under the given language. */
export function localizeTeamName(name: string, lang: string | null | undefined): string {
  const isEn = !(lang ?? "").toLowerCase().startsWith("zh");
  return isEn ? (TEAM_EN[name] ?? name) : name;
}

/**
 * Human label for a sharing token (plain or scoped 校區／部門), localized. A
 * scoped token reads "校區 · 部門"; a plain token is just the localized name.
 */
export function formatTeamToken(token: string, lang: string | null | undefined): string {
  const parsed = parseTeamToken(token);
  if (!parsed.scoped || !parsed.department) return localizeTeamName(parsed.campus, lang);
  return `${localizeTeamName(parsed.campus, lang)} · ${localizeTeamName(parsed.department, lang)}`;
}

/**
 * Every team, whether or not anyone is in it yet.
 *
 * Derived-from-agents alone means a team only exists once somebody is filed
 * into it, so a newly declared group (行銷部／視覺部) would be invisible
 * until its first hire — and you cannot file the first hire into a team you
 * cannot see. The declared campuses and departments are unioned in so an empty
 * team still appears, with a count of zero.
 */
export function listAllTeams(agents: Pick<Agent, "metadata">[]): string[] {
  const set = new Set<string>();
  for (const a of agents) for (const t of agentTeams(a)) set.add(t);
  for (const campus of CAMPUS_ORDER) {
    set.add(campus);
    for (const dept of CAMPUS_DEPARTMENTS[campus] ?? []) set.add(dept);
  }
  return Array.from(set).sort(compareTeams);
}

// The campus (top) level of the team hierarchy. The sidebar nests
// department › under these; the Virtual Office intentionally ignores the campus
// level and groups by department only, so it filters these out of its chips.
export const CAMPUS_TEAMS = new Set(["仁美", "市政", "西屯", "黎明", "北屯", "總管理處"]);

// Campus → its departments (from doc/sa-campus-roster.md). Drives the cascading
// team-scope picker so you can target a specific campus's department (e.g.
// 北屯／幼教主管) even before that team has any agent. Keep in sync with the roster.
export const CAMPUS_DEPARTMENTS: Record<string, string[]> = {
  "仁美": ["幼教主管", "外師教學組", "ESL主管", "註冊組", "總務管理組", "跨校巡輔"],
  "市政": ["幼教主管", "外師教學組", "ESL主管", "註冊組", "總務管理組"],
  "西屯": ["幼教主管", "外師教學組", "ESL主管", "註冊組", "總務管理組"],
  "黎明": ["幼教主管", "外師教學組", "ESL主管", "註冊組", "總務管理組"],
  "北屯": ["幼教主管", "外師教學組", "ESL主管", "註冊組", "總務管理組"],
  "總管理處": ["行銷部", "視覺部", "處長室", "秘書室", "資訊部", "人發部", "品牌發展部", "基金會", "採購工程部", "財務部", "餐飲部"],
};

// Ordered campus list for the picker.
export const CAMPUS_ORDER = ["仁美", "市政", "西屯", "黎明", "北屯", "總管理處"];

// Teams whose agents are infrastructure / non-user (e.g. 系統自動化 → Reflection
// Coach, Wiki Maintainer). We always prioritize user-owned teams, so these sort
// LAST wherever teams are listed or grouped.
export const DEPRIORITIZED_TEAMS = new Set(["系統自動化"]);

/** 0 for normal (user) teams, 1 for infrastructure teams → infra sorts last. */
export function teamPriorityRank(name: string): number {
  return DEPRIORITIZED_TEAMS.has(name) ? 1 : 0;
}

function compareTeams(a: string, b: string): number {
  return teamPriorityRank(a) - teamPriorityRank(b)
    || a.localeCompare(b, undefined, { sensitivity: "base" });
}

const SUBTEAM_SEP = "\0";

export type TwoLevelTeamGroup<T> = {
  key: string;
  team: string; // raw team name (e.g. Chinese) — localize at the display edge
  items: T[]; // everything under this top (campus / cross-campus group)
  directItems: T[]; // items with no second-level (department) team
  subGroups: { key: string; team: string; items: T[] }[];
};

/**
 * Two-level campus›department grouping shared by the sidebar and the skill
 * team-share picker. teams[0] is the top (a campus, or a cross-campus group like
 * 領導團隊 / 系統自動化); teams[1] is the nested department. Each item lands in
 * EXACTLY ONE place, so the top-level groups are disjoint — selecting one campus
 * never bleeds a partial state into another. Items with no team are omitted
 * (callers surface those individually). Sorted by teamPriorityRank (infra last),
 * stable within a rank. Mirrors SidebarAgents' groupAgentsByTeam, minus the
 * ungrouped bucket, and generalized off the concrete Agent type.
 */
export function groupItemsByTeam<T>(
  items: readonly T[],
  getTeams: (item: T) => readonly string[],
): TwoLevelTeamGroup<T>[] {
  type TopAcc = { all: T[]; direct: T[]; subs: Map<string, T[]>; subOrder: string[] };
  const tops = new Map<string, TopAcc>();
  const topOrder: string[] = [];
  const ensureTop = (key: string): TopAcc => {
    let acc = tops.get(key);
    if (!acc) {
      acc = { all: [], direct: [], subs: new Map(), subOrder: [] };
      tops.set(key, acc);
      topOrder.push(key);
    }
    return acc;
  };
  for (const item of items) {
    const teams = getTeams(item);
    if (teams.length === 0) continue; // no team → not a team-share target
    const topKey = teams[0]!;
    const subKey = teams.length >= 2 ? teams[1]! : null;
    const top = ensureTop(topKey);
    top.all.push(item);
    if (subKey) {
      let list = top.subs.get(subKey);
      if (!list) {
        list = [];
        top.subs.set(subKey, list);
        top.subOrder.push(subKey);
      }
      list.push(item);
    } else {
      top.direct.push(item);
    }
  }
  const result: TwoLevelTeamGroup<T>[] = topOrder.map((key) => {
    const acc = tops.get(key)!;
    return {
      key,
      team: key,
      items: acc.all,
      directItems: acc.direct,
      subGroups: acc.subOrder.map((sk) => ({ key: `${key}${SUBTEAM_SEP}${sk}`, team: sk, items: acc.subs.get(sk)! })),
    };
  });
  result.sort((a, b) => teamPriorityRank(a.team) - teamPriorityRank(b.team));
  return result;
}

/**
 * The leadership ranks. Until 2026-09-11 these were the second level under a
 * 園長團隊 root; that group was disbanded and they are top-level groups now, so
 * this list survives only for labelling data written before the split.
 */
export const LEADERSHIP_SUBTEAMS = ["總園長", "園長", "處長"];

// Cross-campus groups — not scoped to any campus. Shown in the picker's 跨校/全部
// section. The three leadership groups are cross-campus by nature: a principal
// belongs to a rank, and their campuses ride along as trailing tokens.
export const CROSS_CAMPUS_GROUPS = ["創辦人", "總園長", "園長 & 處長", "系統自動化"];

// The distinct department names across all campuses — for the "this dept in every
// campus" (plain department token) options in the 跨校/全部 section.
export const ALL_DEPARTMENTS = Array.from(
  new Set(Object.values(CAMPUS_DEPARTMENTS).flat()),
);

/**
 * Department-level teams only (campus names excluded) — for surfaces that group
 * by department rather than campus, e.g. the Virtual Office. Cross-campus groups
 * like 領導團隊 / 系統自動化 are departments here (not campuses), so they stay.
 */
export function listDepartments(agents: Pick<Agent, "metadata">[]): string[] {
  const set = new Set<string>();
  for (const a of agents) for (const t of agentTeams(a)) if (!CAMPUS_TEAMS.has(t)) set.add(t);
  return Array.from(set).sort(compareTeams);
}

export const OFFICE_UNGROUPED_KEY = "__ungrouped__";

// The Virtual Office floor has a fixed set of baked rooms keyed by the original
// department names. The org has renamed/expanded departments repeatedly
// (數位資訊部 → 資訊部, 人發部, 幼教教學組 → 幼教主管, ESL教學組 → ESL主管/…), so map every
// spelling, current and historical, onto the room
// that represents it. Unmapped departments fall through to the floor's spare
// room. Keep the right-hand values in sync with the room `team` keys in
// LivingOfficeFloor / office-rooms.
const DEPARTMENT_ROOM: Record<string, string> = {
  // IT — 資訊部 is the current name; 數位資訊部 is the pre-rename spelling
  "資訊部": "資訊部",
  "數位資訊部": "資訊部",
  // Teaching room absorbs the preschool group + 跨校巡輔 (and legacy/roomless
  // teaching depts). 幼教學組 is the pre-2026-09-04 spelling.
  "教學組": "教學組",
  "幼教主管": "教學組",
  "幼教教學組": "教學組",
  "幼教教學": "教學組",
  "幼教行政": "教學組",
  "幼教學組": "教學組",
  "跨校巡輔": "教學組",
  "外師教學組": "教學組",
  "註冊組": "教學組",
  // Own rooms
  "ESL主管": "ESL教學組",
  "ESL教學組": "ESL教學組",
  "總務管理組": "總務管理組",
  // 人發部 is the current name; the two long spellings are pre-rename
  "人發部": "人發部",
  "人才發展": "人發部",
  "人才發展部": "人發部",
  "品牌發展部": "品牌發展部",
  // All three leadership groups share the one baked leadership room.
  "創辦人": "領導團隊",
  "總園長": "領導團隊",
  "園長 & 處長": "領導團隊",
  "園長團隊": "領導團隊",
  "領導團隊": "領導團隊",
  "系統自動化": "系統自動化",
};

/**
 * The office room an agent belongs to. The office groups by DEPARTMENT, not
 * campus, so pick the agent's first non-campus team (its department), then
 * canonicalize renamed departments onto their baked room. Falls back to the raw
 * department, then to the ungrouped key.
 */
export function officeTeamKey(agent: Pick<Agent, "metadata">): string {
  const teams = agentTeams(agent);
  const department = teams.find((t) => !CAMPUS_TEAMS.has(t)) ?? teams[0];
  if (!department) return OFFICE_UNGROUPED_KEY;
  return DEPARTMENT_ROOM[department] ?? department;
}

/** An empty selection means "no filter" (everyone passes). */
export function agentMatchesTeams(agent: Pick<Agent, "metadata">, selected: string[]): boolean {
  if (selected.length === 0) return true;
  const teams = agentTeams(agent);
  return teams.some((t) => selected.includes(t));
}

const STORAGE_PREFIX = "paperclip.agentTeamFilter.";
const FILTER_EVENT = "paperclip:agent-team-filter";

function storageKey(companyId: string | null | undefined): string {
  return `${STORAGE_PREFIX}${companyId ?? "none"}`;
}

function readFilter(companyId: string | null | undefined): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(storageKey(companyId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Cross-page team filter, persisted per company in localStorage. The Agents
 * page and the Virtual Office both use this hook, so a selection made on one
 * carries over when you switch to the other (and back). A same-tab custom event
 * keeps every mounted consumer (e.g. the office strip + the agent list) in sync
 * instantly; the storage event syncs other tabs.
 */
export function useAgentTeamFilter(companyId: string | null | undefined): {
  selected: string[];
  setSelected: (next: string[]) => void;
  toggle: (team: string) => void;
  clear: () => void;
} {
  const [selected, setSelectedState] = useState<string[]>(() => readFilter(companyId));

  useEffect(() => {
    setSelectedState(readFilter(companyId));
  }, [companyId]);

  useEffect(() => {
    const key = storageKey(companyId);
    const onStorage = (e: StorageEvent) => {
      if (e.key === key) setSelectedState(readFilter(companyId));
    };
    const onCustom = (e: Event) => {
      const detail = (e as CustomEvent<{ companyId: string | null | undefined }>).detail;
      if (detail?.companyId === (companyId ?? null) || detail?.companyId === companyId) {
        setSelectedState(readFilter(companyId));
      }
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener(FILTER_EVENT, onCustom as EventListener);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(FILTER_EVENT, onCustom as EventListener);
    };
  }, [companyId]);

  const setSelected = useCallback(
    (next: string[]) => {
      setSelectedState(next);
      try {
        window.localStorage.setItem(storageKey(companyId), JSON.stringify(next));
      } catch {
        /* storage may be unavailable */
      }
      window.dispatchEvent(
        new CustomEvent(FILTER_EVENT, { detail: { companyId: companyId ?? null } }),
      );
    },
    [companyId],
  );

  const toggle = useCallback(
    (team: string) => {
      const cur = readFilter(companyId);
      setSelected(cur.includes(team) ? cur.filter((t) => t !== team) : [...cur, team]);
    },
    [companyId, setSelected],
  );

  const clear = useCallback(() => setSelected([]), [setSelected]);

  return { selected, setSelected, toggle, clear };
}
