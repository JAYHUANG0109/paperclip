import { useCallback, useEffect, useState } from "react";
import type { Agent } from "@paperclipai/shared";

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

/** Unique, sorted list of every team present across the given agents. */
export function listAllTeams(agents: Pick<Agent, "metadata">[]): string[] {
  const set = new Set<string>();
  for (const a of agents) for (const t of agentTeams(a)) set.add(t);
  return Array.from(set).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
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
