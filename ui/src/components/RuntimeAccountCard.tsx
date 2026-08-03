import type { RuntimeAccountPoolEntry, RuntimeAccountsResult } from "@paperclipai/shared";
import { cn } from "@/lib/utils";

interface RuntimeAccountCardProps {
  result: RuntimeAccountsResult;
  loading?: boolean;
}

/** Trailing path segment — the pool entry's short name, e.g. "acct2". */
function shortDirName(dir: string): string {
  const parts = dir.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? dir;
}

function resetsInText(coolingDownUntil: string): string {
  const until = new Date(coolingDownUntil);
  const minutes = Math.round((until.getTime() - Date.now()) / 60_000);
  if (Number.isNaN(minutes)) return "quota-limited";
  if (minutes <= 0) return "resetting now";
  if (minutes < 60) return `resets in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `resets in ${hours}h ${rest}m` : `resets in ${hours}h`;
}

function entryState(entry: RuntimeAccountPoolEntry): {
  label: string;
  dotClass: string;
  detail: string | null;
} {
  if (!entry.loggedIn) {
    return {
      label: "Signed out",
      dotClass: "bg-(--status-agent-error)",
      detail: "This directory has no usable credentials — rotation will skip past it.",
    };
  }
  if (entry.coolingDownUntil) {
    return {
      label: "Quota-limited",
      dotClass: "bg-(--status-task-blocked)",
      detail: resetsInText(entry.coolingDownUntil),
    };
  }
  if (entry.active) {
    return { label: "In use", dotClass: "bg-(--status-agent-running)", detail: null };
  }
  return { label: "Standby", dotClass: "bg-(--status-agent-idle)", detail: null };
}

/**
 * Which provider account the platform is currently running on, plus the rest of
 * the credential-rotation pool.
 *
 * Read-only and deliberately explicit about uncertainty: until a run has picked
 * an account in the current server process the pointer is unresolved, so the
 * card says which account the NEXT run would use rather than implying a
 * confirmed one.
 */
export function RuntimeAccountCard({ result, loading = false }: RuntimeAccountCardProps) {
  const active = result.entries.find((entry) => entry.active) ?? null;
  const hasPool = result.entries.length > 0;

  return (
    <div className="border border-border px-4 py-4">
      <div className="flex items-start justify-between gap-3 border-b border-border pb-3">
        <div className="min-w-0">
          <div className="text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-caps) text-muted-foreground">
            Account in use
          </div>
          <div className="mt-1 text-sm text-muted-foreground">
            Which Claude account Paperclip is running on.
          </div>
        </div>
        {result.agentCount > 0 ? (
          <span className="shrink-0 border border-border px-2.5 py-1 text-(length:--text-nano) font-semibold uppercase tracking-(--tracking-eyebrow) text-muted-foreground">
            {result.agentCount} {result.agentCount === 1 ? "agent" : "agents"}
          </span>
        ) : null}
      </div>

      {result.error ? (
        <div className="mt-4 border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {result.error}
        </div>
      ) : null}

      {loading && !hasPool ? (
        <div className="mt-4 text-sm text-muted-foreground">Loading accounts…</div>
      ) : null}

      {!loading && !hasPool && !result.error ? (
        <div className="mt-4 text-sm text-muted-foreground">
          No account-rotation pool is configured, so every agent runs on this host's default Claude
          login and shares one quota.
        </div>
      ) : null}

      {hasPool ? (
        <>
          <div className="mt-4 border border-border px-3.5 py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-foreground">
                  {active?.email ?? shortDirName(active?.dir ?? "")}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {result.activeResolved
                    ? "Currently in use"
                    : "No run yet since the last restart — the next run will use this account"}
                </div>
              </div>
              {active?.subscriptionType ? (
                <div className="shrink-0 text-sm font-semibold uppercase tabular-nums text-foreground">
                  {active.subscriptionType}
                </div>
              ) : null}
            </div>
            {active?.orgName ? (
              <div className="mt-2 truncate text-xs text-muted-foreground">{active.orgName}</div>
            ) : null}
          </div>

          <div className="mt-4 space-y-2">
            <div className="text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-caps) text-muted-foreground">
              Rotation pool
            </div>
            {result.entries.map((entry) => {
              const state = entryState(entry);
              return (
                <div key={entry.dir} className="border border-border px-3.5 py-2.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <span
                        className={cn(
                          "size-2 shrink-0 rounded-full",
                          state.dotClass,
                          entry.active && entry.loggedIn && !entry.coolingDownUntil && "animate-pulse",
                        )}
                      />
                      <div className="min-w-0">
                        <div className="truncate text-sm text-foreground">
                          {entry.email ?? shortDirName(entry.dir)}
                        </div>
                        <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                          {entry.dir}
                        </div>
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="text-xs font-medium text-foreground">{state.label}</div>
                      {state.detail ? (
                        <div className="mt-0.5 text-xs text-muted-foreground">{state.detail}</div>
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      ) : null}
    </div>
  );
}
