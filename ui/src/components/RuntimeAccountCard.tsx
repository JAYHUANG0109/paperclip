import type { QuotaWindow, RuntimeAccountPoolEntry, RuntimeAccountsResult } from "@paperclipai/shared";
import type { TFunction } from "i18next";
import { useTranslation } from "@/i18n";
import { cn } from "@/lib/utils";

/** Threshold colours per the design guide's budget bar: green <60, yellow 60-85, red >85. */
function barColorClass(usedPercent: number): string {
  if (usedPercent > 85) return "bg-red-400";
  if (usedPercent >= 60) return "bg-yellow-400";
  return "bg-green-400";
}

function resetsAtText(resetsAt: string, t: TFunction): string | null {
  const minutes = Math.round((new Date(resetsAt).getTime() - Date.now()) / 60_000);
  if (Number.isNaN(minutes) || minutes <= 0) return null;
  if (minutes < 60) return t("runtimeAccount.quota.inMinutes", { minutes, defaultValue: "{{minutes}}m" });
  const hours = Math.floor(minutes / 60);
  return hours < 24
    ? t("runtimeAccount.quota.inHours", { hours, defaultValue: "{{hours}}h" })
    : t("runtimeAccount.quota.inDays", { days: Math.floor(hours / 24), defaultValue: "{{days}}d" });
}

/**
 * Provider-reported usage windows for one account.
 *
 * Renders nothing when `windows` is null — that means "could not read", not "0% used",
 * and a 0%-looking bar would be a lie. Windows the provider reported without a
 * percentage (credit-style rows) are skipped for the same reason.
 */
function QuotaBars({ windows, t }: { windows: QuotaWindow[] | null; t: TFunction }) {
  const usable = (windows ?? []).filter((w) => typeof w.usedPercent === "number");
  if (usable.length === 0) return null;
  return (
    <div className="mt-2.5 space-y-1.5 border-t border-border pt-2.5">
      {usable.map((w) => {
        const pct = Math.max(0, Math.min(100, w.usedPercent as number));
        const resets = w.resetsAt ? resetsAtText(w.resetsAt, t) : null;
        return (
          <div key={w.label}>
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate text-xs text-muted-foreground">{w.label}</span>
              <span className="shrink-0 text-xs tabular-nums text-foreground">
                {pct}%
                {resets ? (
                  <span className="ml-1.5 text-muted-foreground">
                    {t("runtimeAccount.quota.resetsIn", { value: resets, defaultValue: "resets in {{value}}" })}
                  </span>
                ) : null}
              </span>
            </div>
            <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={cn("h-full rounded-full", barColorClass(pct))}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

interface RuntimeAccountCardProps {
  result: RuntimeAccountsResult;
  loading?: boolean;
  /** Pin runs to a dir, or null to return to automatic rotation. */
  onPin?: (dir: string | null) => void;
  pinPending?: boolean;
  pinError?: string | null;
}

/** Trailing path segment — the pool entry's short name, e.g. "acct2". */
function shortDirName(dir: string): string {
  const parts = dir.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? dir;
}

function resetsInText(coolingDownUntil: string, t: TFunction): string {
  const until = new Date(coolingDownUntil);
  const minutes = Math.round((until.getTime() - Date.now()) / 60_000);
  if (Number.isNaN(minutes)) return t("runtimeAccount.quotaLimitedShort", { defaultValue: "quota-limited" });
  if (minutes <= 0) return t("runtimeAccount.resettingNow", { defaultValue: "resetting now" });
  if (minutes < 60)
    return t("runtimeAccount.resetsInMinutes", { minutes, defaultValue: "resets in {{minutes}}m" });
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0
    ? t("runtimeAccount.resetsInHoursMinutes", {
        hours,
        minutes: rest,
        defaultValue: "resets in {{hours}}h {{minutes}}m",
      })
    : t("runtimeAccount.resetsInHours", { hours, defaultValue: "resets in {{hours}}h" });
}

function entryState(
  entry: RuntimeAccountPoolEntry,
  t: TFunction,
): {
  label: string;
  dotClass: string;
  detail: string | null;
} {
  if (!entry.loggedIn) {
    return {
      label: t("runtimeAccount.state.signedOut", { defaultValue: "Signed out" }),
      dotClass: "bg-(--status-agent-error)",
      detail: t("runtimeAccount.state.signedOutDetail", {
        defaultValue: "This directory has no usable credentials — rotation will skip past it.",
      }),
    };
  }
  if (entry.coolingDownUntil) {
    return {
      label: t("runtimeAccount.state.quotaLimited", { defaultValue: "Quota-limited" }),
      dotClass: "bg-(--status-task-blocked)",
      detail: resetsInText(entry.coolingDownUntil, t),
    };
  }
  if (entry.active) {
    return {
      label: t("runtimeAccount.state.inUse", { defaultValue: "In use" }),
      dotClass: "bg-(--status-agent-running)",
      detail: null,
    };
  }
  return {
    label: t("runtimeAccount.state.standby", { defaultValue: "Standby" }),
    dotClass: "bg-(--status-agent-idle)",
    detail: null,
  };
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
export function RuntimeAccountCard({
  result,
  loading = false,
  onPin,
  pinPending = false,
  pinError = null,
}: RuntimeAccountCardProps) {
  const { t } = useTranslation();
  const active = result.entries.find((entry) => entry.active) ?? null;
  const hasPool = result.entries.length > 0;
  const canSwitch = result.canSwitch && !!onPin;

  return (
    <div className="border border-border px-4 py-4">
      <div className="flex items-start justify-between gap-3 border-b border-border pb-3">
        <div className="min-w-0">
          <div className="text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-caps) text-muted-foreground">
            {t("runtimeAccount.accountInUse", { defaultValue: "Account in use" })}
          </div>
          <div className="mt-1 text-sm text-muted-foreground">
            {t("runtimeAccount.description", {
              defaultValue: "Which Claude account Paperclip is running on.",
            })}
          </div>
        </div>
        {result.agentCount > 0 ? (
          <span className="shrink-0 border border-border px-2.5 py-1 text-(length:--text-nano) font-semibold uppercase tracking-(--tracking-eyebrow) text-muted-foreground">
            {t("runtimeAccount.agentCount", {
              count: result.agentCount,
              defaultValue: "{{count}} agent",
              defaultValue_other: "{{count}} agents",
            })}
          </span>
        ) : null}
      </div>

      {result.error ? (
        <div className="mt-4 border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {result.error}
        </div>
      ) : null}

      {loading && !hasPool ? (
        <div className="mt-4 text-sm text-muted-foreground">
          {t("runtimeAccount.loading", { defaultValue: "Loading accounts…" })}
        </div>
      ) : null}

      {!loading && !hasPool && !result.error ? (
        <div className="mt-4 text-sm text-muted-foreground">
          {t("runtimeAccount.noPool", {
            defaultValue:
              "No account-rotation pool is configured, so every agent runs on this host's default Claude login and shares one quota.",
          })}
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
                    ? t("runtimeAccount.currentlyInUse", { defaultValue: "Currently in use" })
                    : t("runtimeAccount.nextRunUses", {
                        defaultValue:
                          "No run yet since the last restart — the next run will use this account",
                      })}
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

          {pinError ? (
            <div className="mt-4 border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {pinError}
            </div>
          ) : null}

          <div className="mt-4 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div className="text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-caps) text-muted-foreground">
                {t("runtimeAccount.rotationPool", { defaultValue: "Rotation pool" })}
              </div>
              {canSwitch && result.pinnedDir ? (
                <button
                  type="button"
                  disabled={pinPending}
                  onClick={() => onPin?.(null)}
                  className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground disabled:opacity-50 disabled:pointer-events-none"
                >
                  {t("runtimeAccount.backToAutomatic", { defaultValue: "Back to automatic" })}
                </button>
              ) : null}
            </div>
            {canSwitch ? (
              <div className="text-xs text-muted-foreground">
                {result.pinnedDir
                  ? t("runtimeAccount.pinnedHelp", {
                      defaultValue:
                        "Pinned to one account. If it runs out of quota, Paperclip rotates on and returns here when it resets.",
                    })
                  : t("runtimeAccount.rotatingHelp", {
                      defaultValue: "Rotating automatically. Choose an account to pin runs to it.",
                    })}
              </div>
            ) : null}
            {result.entries.map((entry) => {
              const state = entryState(entry, t);
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
                      <div className="flex items-center justify-end gap-2">
                        {entry.pinned ? (
                          <span className="border border-border px-1.5 py-0.5 text-(length:--text-nano) font-semibold uppercase tracking-(--tracking-eyebrow) text-muted-foreground">
                            {t("runtimeAccount.pinned", { defaultValue: "Pinned" })}
                          </span>
                        ) : null}
                        <div className="text-xs font-medium text-foreground">{state.label}</div>
                      </div>
                      {state.detail ? (
                        <div className="mt-0.5 text-xs text-muted-foreground">{state.detail}</div>
                      ) : null}
                      {canSwitch && !entry.pinned ? (
                        <button
                          type="button"
                          disabled={pinPending || !entry.loggedIn}
                          onClick={() => onPin?.(entry.dir)}
                          title={
                            entry.loggedIn
                              ? undefined
                              : t("runtimeAccount.noCredentialsTitle", {
                                  defaultValue: "This directory has no usable credentials",
                                })
                          }
                          className="mt-1 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground disabled:opacity-50 disabled:pointer-events-none"
                        >
                          {t("runtimeAccount.useThisAccount", { defaultValue: "Use this account" })}
                        </button>
                      ) : null}
                    </div>
                  </div>
                  <QuotaBars windows={entry.quotaWindows} t={t} />
                </div>
              );
            })}
          </div>
        </>
      ) : null}
    </div>
  );
}
