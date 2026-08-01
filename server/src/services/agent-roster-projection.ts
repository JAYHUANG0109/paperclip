/**
 * The Virtual Office roster projection — PURE, and a security boundary.
 *
 * `GET /companies/:companyId/agents/office-roster` is the ONE agent listing
 * with no visibility filter: the office floor has to be populated for
 * everyone, including members who under PAPERCLIP_RESTRICT_AGENT_VISIBILITY can
 * otherwise see only their own agent. That makes this the company's widest
 * agent disclosure, so the field list is a decision, not a detail.
 *
 * It is an ALLOWLIST. It used to spread the whole row and blank three fields,
 * which meant every column added to `agents` was published here by default. By
 * the time restricted visibility was switched on, that included:
 *
 *   - `budgetMonthlyCents` / `spentMonthlyCents` — spend, to every member
 *   - `permissions` — what each agent is allowed to do
 *   - `reportsTo` — the full org chart, which lets any member reconstruct the
 *     hierarchy the restriction exists to scope
 *
 * None of those is display data. Adding a field below is a deliberate decision
 * to publish it company-wide.
 */

/**
 * Scope an agent-keyed map (skill counts, progression) to what the caller may
 * see, mirroring the agent list rather than publishing the whole company.
 *
 * `visibleAgentIds === null` means UNRESTRICTED — a privileged viewer or an
 * agent actor. Callers must pass null explicitly rather than an empty set, so
 * "sees everything" and "sees nothing" can never be confused: an empty set
 * legitimately means a member with no agents, and silently treating that as
 * unrestricted would publish the company.
 */
export function scopeAgentKeyedRecord<T>(
  record: Record<string, T>,
  visibleAgentIds: ReadonlySet<string> | null,
): Record<string, T> {
  if (visibleAgentIds === null) return record;
  const scoped: Record<string, T> = {};
  for (const [agentId, value] of Object.entries(record)) {
    if (visibleAgentIds.has(agentId)) scoped[agentId] = value;
  }
  return scoped;
}

/**
 * Display name for a ranked user, without publishing their email address.
 *
 * The leaderboard is shown to every member, and it used to fall back to the
 * raw email when a user had no display name — turning a scoreboard into a
 * company address list. The local part identifies the colleague just as well
 * to the people who work with them.
 */
export function leaderboardDisplayName(
  user: { name?: string | null; email?: string | null } | undefined,
  userId: string,
): string {
  const name = user?.name?.trim();
  if (name) return name;
  const email = user?.email?.trim();
  if (email) {
    const localPart = email.split("@")[0]?.trim();
    if (localPart) return localPart;
  }
  return userId.slice(0, 8);
}

/** Metadata keys the office floor renders. Everything else is dropped. */
export const OFFICE_METADATA_KEYS = ["teams", "team", "officeCharacterId", "officeAvatarUrl"] as const;

export type RosterAgentInput = {
  id: string;
  companyId: string;
  name: string;
  urlKey?: string | null;
  role?: string | null;
  title?: string | null;
  icon?: string | null;
  status?: string | null;
  lastHeartbeatAt?: Date | string | null;
  pauseReason?: string | null;
  errorReason?: string | null;
  capabilities?: unknown;
  metadata?: unknown;
};

export type RosterAgentView = {
  id: string;
  companyId: string;
  name: string;
  urlKey: string | null;
  role: string | null;
  title: string | null;
  icon: string | null;
  status: string | null;
  lastHeartbeatAt: Date | string | null;
  pauseReason: string | null;
  errorReason: string | null;
  capabilities: unknown;
  metadata: Record<string, unknown>;
  /** Always empty. Present so clients reading these keys get {} not undefined. */
  adapterConfig: Record<string, never>;
  runtimeConfig: Record<string, never>;
};

export function redactForRosterView(agent: RosterAgentInput | null | undefined): RosterAgentView | null {
  if (!agent) return null;

  const raw = agent.metadata && typeof agent.metadata === "object" ? (agent.metadata as Record<string, unknown>) : {};
  const metadata: Record<string, unknown> = {};
  for (const key of OFFICE_METADATA_KEYS) {
    if (key in raw) metadata[key] = raw[key];
  }

  return {
    id: agent.id,
    companyId: agent.companyId,
    name: agent.name,
    urlKey: agent.urlKey ?? null,
    role: agent.role ?? null,
    title: agent.title ?? null,
    icon: agent.icon ?? null,
    status: agent.status ?? null,
    lastHeartbeatAt: agent.lastHeartbeatAt ?? null,
    pauseReason: agent.pauseReason ?? null,
    errorReason: agent.errorReason ?? null,
    capabilities: agent.capabilities ?? null,
    metadata,
    adapterConfig: {},
    runtimeConfig: {},
  };
}
