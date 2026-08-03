/** a single rate-limit or usage window returned by a provider quota API */
export interface QuotaWindow {
  /** human label, e.g. "5h", "7d", "Sonnet 7d", "Credits" */
  label: string;
  /** percent of the window already consumed (0-100), null when not reported */
  usedPercent: number | null;
  /** iso timestamp when this window resets, null when not reported */
  resetsAt: string | null;
  /** free-form value label for credit-style windows, e.g. "$4.20 remaining" */
  valueLabel: string | null;
  /** optional supporting text, e.g. reset details or provider-specific notes */
  detail?: string | null;
}

/**
 * One pre-authenticated credential directory in the Claude rotation pool.
 *
 * Each dir is a separate account with its own subscription quota — Claude Code
 * namespaces its credential store per config dir, so these do not share tokens.
 */
export interface RuntimeAccountPoolEntry {
  /** absolute credential directory (CLAUDE_CONFIG_DIR) */
  dir: string;
  /** true for the account the next local subscription run would use */
  active: boolean;
  /** iso timestamp this account becomes usable again, null when healthy */
  coolingDownUntil: string | null;
  /** account email, null when the directory could not be read */
  email: string | null;
  /** plan, e.g. "team" / "max", null when unknown */
  subscriptionType: string | null;
  /** organization name reported by the provider, null when unknown */
  orgName: string | null;
  /** false when the directory has no usable credentials */
  loggedIn: boolean;
  /** true when an operator pinned runs to this account */
  pinned: boolean;
}

/** which provider account the platform is currently running on */
export interface RuntimeAccountsResult {
  provider: string;
  /**
   * True once a run in this server process has picked an account. While false,
   * `entries[].active` marks the account the NEXT run would use — the sticky
   * pointer is in-process state and resets when the server restarts.
   */
  activeResolved: boolean;
  /** rotation pool, in configured order; empty when no pool is configured */
  entries: RuntimeAccountPoolEntry[];
  /** how many claude_local agents are configured with this pool */
  agentCount: number;
  /** why the caller was allowed to see this, for auditability */
  viewerReason: string | null;
  /** operator-pinned credential dir, or null when rotation is fully automatic */
  pinnedDir: string | null;
  /** true when the caller may change the pinned account, not just see it */
  canSwitch: boolean;
  /** set when the pool could not be described */
  error?: string | null;
}

/** result for one provider from the quota-windows endpoint */
export interface ProviderQuotaResult {
  /** provider slug, e.g. "anthropic", "openai" */
  provider: string;
  /** source label when the provider reports where the quota data came from */
  source?: string | null;
  /** true when the fetch succeeded and windows is populated */
  ok: boolean;
  /** machine-readable error family when ok is false */
  errorFamily?: string | null;
  /** error message when ok is false */
  error?: string;
  windows: QuotaWindow[];
}
