import type { Agent } from "@paperclipai/shared";

export const AGENT_ORDER_UPDATED_EVENT = "paperclip:agent-order-updated";
export const AGENT_SORT_MODE_UPDATED_EVENT = "paperclip:agent-sort-mode-updated";
const AGENT_ORDER_STORAGE_PREFIX = "paperclip.agentOrder";
const AGENT_SORT_MODE_STORAGE_PREFIX = "paperclip.agentSortMode";
const ANONYMOUS_USER_ID = "anonymous";

export type AgentSidebarSortMode = "top" | "alphabetical" | "recent";

type AgentOrderUpdatedDetail = {
  storageKey: string;
  orderedIds: string[];
};

export type AgentSortModeUpdatedDetail = {
  storageKey: string;
  sortMode: AgentSidebarSortMode;
};

function normalizeIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function normalizeSortMode(value: unknown): AgentSidebarSortMode {
  return value === "alphabetical" || value === "recent" || value === "top" ? value : "top";
}

function resolveUserId(userId: string | null | undefined): string {
  if (!userId) return ANONYMOUS_USER_ID;
  const trimmed = userId.trim();
  return trimmed.length > 0 ? trimmed : ANONYMOUS_USER_ID;
}

export function getAgentOrderStorageKey(companyId: string, userId: string | null | undefined): string {
  return `${AGENT_ORDER_STORAGE_PREFIX}:${companyId}:${resolveUserId(userId)}`;
}

export function getAgentSortModeStorageKey(companyId: string, userId: string | null | undefined): string {
  return `${AGENT_SORT_MODE_STORAGE_PREFIX}:${companyId}:${resolveUserId(userId)}`;
}

export function readAgentOrder(storageKey: string): string[] {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return [];
    return normalizeIdList(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function readAgentSortMode(storageKey: string): AgentSidebarSortMode {
  try {
    return normalizeSortMode(localStorage.getItem(storageKey));
  } catch {
    return "top";
  }
}

export function writeAgentOrder(storageKey: string, orderedIds: string[]) {
  const normalized = normalizeIdList(orderedIds);
  try {
    localStorage.setItem(storageKey, JSON.stringify(normalized));
  } catch {
    // Ignore storage write failures in restricted browser contexts.
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent<AgentOrderUpdatedDetail>(AGENT_ORDER_UPDATED_EVENT, {
        detail: { storageKey, orderedIds: normalized },
      }),
    );
  }
}

export function writeAgentSortMode(storageKey: string, sortMode: AgentSidebarSortMode) {
  const normalized = normalizeSortMode(sortMode);
  try {
    localStorage.setItem(storageKey, normalized);
  } catch {
    // Ignore storage write failures in restricted browser contexts.
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent<AgentSortModeUpdatedDetail>(AGENT_SORT_MODE_UPDATED_EVENT, {
        detail: { storageKey, sortMode: normalized },
      }),
    );
  }
}

// Leadership roles surface at the top of each sibling group so the company's
// lead (typically the freshly-hired CEO) is visible without scrolling the
// sidebar (PAP-52). Anything outside this list falls back to alphabetical.
// Opt-in via `leadershipFirst` — gated on the Conference Room Chat experimental
// flag (PAP-139); the default keeps master's plain alphabetical sibling order.
const ROLE_SORT_PRIORITY: Record<string, number> = {
  ceo: 0,
  cto: 1,
  cfo: 2,
  cmo: 3,
};

function rolePriority(agent: Agent): number {
  const role = typeof agent.role === "string" ? agent.role.toLowerCase() : "";
  return ROLE_SORT_PRIORITY[role] ?? Number.MAX_SAFE_INTEGER;
}

export interface AgentSidebarOrderOptions {
  /** Surface leadership roles (CEO/CTO/...) first within each sibling group. */
  leadershipFirst?: boolean;
}

export function sortAgentsByDefaultSidebarOrder(
  agents: Agent[],
  options?: AgentSidebarOrderOptions,
): Agent[] {
  if (agents.length === 0) return [];

  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const childrenOf = new Map<string | null, Agent[]>();
  for (const agent of agents) {
    const parentId = agent.reportsTo && byId.has(agent.reportsTo) ? agent.reportsTo : null;
    const siblings = childrenOf.get(parentId) ?? [];
    siblings.push(agent);
    childrenOf.set(parentId, siblings);
  }

  const leadershipFirst = options?.leadershipFirst === true;
  for (const siblings of childrenOf.values()) {
    siblings.sort((left, right) => {
      if (leadershipFirst) {
        const priorityDiff = rolePriority(left) - rolePriority(right);
        if (priorityDiff !== 0) return priorityDiff;
      }
      return left.name.localeCompare(right.name);
    });
  }

  const sorted: Agent[] = [];
  const queue = [...(childrenOf.get(null) ?? [])];
  while (queue.length > 0) {
    const agent = queue.shift();
    if (!agent) continue;
    sorted.push(agent);
    const children = childrenOf.get(agent.id);
    if (children) queue.push(...children);
  }

  return sorted;
}

// Generic, unassigned C-suite placeholder agents (CEO_agent, COO_agent,
// CMO_agent, …) — scaffolding, not real colleagues.
const PLACEHOLDER_CSUITE = /^(CEO|COO|CMO|CTO|CFO|CIO)_agent$/i;

function isPlaceholderCsuite(agent: Pick<Agent, "name">): boolean {
  return PLACEHOLDER_CSUITE.test(agent.name.trim());
}

// An agent that maps to no real person/user (bots, scaffolding). Detected by the
// knowledge-maintainer role (the Wiki bot) or an explicit metadata.nonUser flag
// (set by an admin for placeholders like generic consultants/specialists).
function isNonUserAgent(agent: Pick<Agent, "role" | "metadata">): boolean {
  const role = typeof agent.role === "string" ? agent.role.toLowerCase() : "";
  if (role === "knowledge-maintainer") return true;
  const md = agent.metadata as Record<string, unknown> | null;
  return Boolean(md && md.nonUser === true);
}

/**
 * Sort tier for the default agent ordering (lower = higher up the page):
 *   0 — real colleagues (ranked among themselves by access level)
 *   1 — generic C-suite placeholder agents (CEO/CMO/COO/…)
 *   2 — other non-user agents (Wiki bot, flagged scaffolding) — the very bottom
 */
export function agentSortTier(agent: Pick<Agent, "name" | "role" | "metadata">): number {
  if (isPlaceholderCsuite(agent)) return 1;
  if (isNonUserAgent(agent)) return 2;
  return 0;
}

// Depth in the reportsTo tree: 0 = root (no manager), +1 per hop up. Shallower
// = higher up the org = more access. Cycle- and missing-parent-safe.
function computeAccessDepths(universe: Agent[]): Map<string, number> {
  const byId = new Map(universe.map((a) => [a.id, a]));
  const depth = new Map<string, number>();
  for (const a of universe) {
    let d = 0;
    let cur: Agent | undefined = a;
    const seen = new Set<string>();
    while (cur?.reportsTo && !seen.has(cur.id)) {
      seen.add(cur.id);
      const parent = byId.get(cur.reportsTo);
      if (!parent) break;
      d += 1;
      cur = parent;
      if (d > 50) break;
    }
    depth.set(a.id, d);
  }
  return depth;
}

/**
 * Rank agents by access level (org seniority): higher up the reportsTo chain
 * first, ties broken by name. Generic C-suite placeholder agents
 * (CEO_agent/COO_agent/CMO_agent/…) are pushed to the end regardless of depth,
 * since they're unassigned scaffolding rather than real colleagues.
 *
 * `universe` is the full agent set used to resolve the reportsTo chain — pass it
 * when `toSort` is a filtered subset so a manager filtered out of the view still
 * contributes to depth. Defaults to `toSort`.
 */
export function sortAgentsByAccessLevel(toSort: Agent[], universe: Agent[] = toSort): Agent[] {
  const depth = computeAccessDepths(universe.length ? universe : toSort);
  return [...toSort].sort((a, b) => {
    const ta = agentSortTier(a);
    const tb = agentSortTier(b);
    if (ta !== tb) return ta - tb; // real → C-suite → other non-user
    const da = depth.get(a.id) ?? 99;
    const db = depth.get(b.id) ?? 99;
    if (da !== db) return da - db; // within a tier, higher in the org first
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

export function sortAgentsByStoredOrder(
  agents: Agent[],
  orderedIds: string[],
  options?: AgentSidebarOrderOptions,
): Agent[] {
  if (agents.length === 0) return [];

  const defaultSorted = sortAgentsByDefaultSidebarOrder(agents, options);
  if (orderedIds.length === 0) return defaultSorted;

  const byId = new Map(defaultSorted.map((agent) => [agent.id, agent]));
  const sorted: Agent[] = [];

  for (const id of orderedIds) {
    const agent = byId.get(id);
    if (!agent) continue;
    sorted.push(agent);
    byId.delete(id);
  }

  for (const agent of defaultSorted) {
    if (byId.has(agent.id)) {
      sorted.push(agent);
      byId.delete(agent.id);
    }
  }

  return sorted;
}
