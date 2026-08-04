import { useMemo } from "react";
import type {
  Agent,
  IssueRecoveryAction,
  IssueRecoveryActionKind,
  IssueRecoveryActionOutcome,
  IssueRecoveryActionStatus,
} from "@paperclipai/shared";
import { Eye, OctagonAlert, RefreshCw, Sparkles, TriangleAlert } from "lucide-react";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { agentUrl } from "@/lib/utils";
import { cn } from "@/lib/utils";
import {
  deriveRecoveryDisplayState,
  type RecoveryDisplayState,
} from "@/lib/recovery-display";
import { t, useTranslation } from "@/i18n";

export type RecoveryCardCardState = RecoveryDisplayState;
export const deriveRecoveryCardState = deriveRecoveryDisplayState;

export type RecoveryResolveOutcome =
  | "todo"
  | "done"
  | "in_review"
  | "false_positive_done"
  | "false_positive_in_review";

/**
 * What a caller needs to re-issue stalled work onto an isolated git worktree: the live
 * branch to base it on, and the branch the run had recorded, when they diverged.
 */
export interface RecoveryReissueRequest {
  baseRef: string;
  expectedBranch?: string | null;
}

/**
 * Read the workspace-validation evidence a `workspace_validation` recovery action carries.
 *
 * This is what turns "the run was refused" into something an operator can act on: which
 * branch was recorded, which one is actually checked out, and whether the tree is dirty.
 * Returns null for any other recovery kind, so the diagnosis simply does not render.
 */
/**
 * Whether the live branch can be reconciled by fast-forward, in the operator's terms.
 * "Diverged" is the case where accepting the live branch would silently drop commits.
 */
function ancestryVerdictLabel(verdict: string | null): string | null {
  if (!verdict) return null;
  if (verdict === "ancestor") return t("recoveryCard.workspace.verdictForwardOnly", { defaultValue: "Forward-only" });
  if (verdict === "diverged") return t("recoveryCard.workspace.verdictDiverged", { defaultValue: "Diverged" });
  return verdict;
}

function workspaceValidationEvidence(action: IssueRecoveryAction): {
  expectedBranch: string | null;
  actualBranch: string | null;
  cleanliness: string | null;
  dirtyCount: number | null;
  reason: string | null;
  expectedHeadSha: string | null;
  actualHeadSha: string | null;
  ancestryVerdict: string | null;
} | null {
  if (action.kind !== "workspace_validation") return null;
  const ev = action.evidence as Record<string, unknown> | null | undefined;
  const wv = ev && typeof ev.workspaceValidation === "object" && ev.workspaceValidation !== null
    ? (ev.workspaceValidation as Record<string, unknown>)
    : null;
  if (!wv) return null;
  const prov = typeof wv.provenance === "object" && wv.provenance !== null
    ? (wv.provenance as Record<string, unknown>)
    : null;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    expectedBranch: str(wv.expectedBranch),
    actualBranch: str(wv.actualBranch),
    cleanliness: str(wv.cleanliness),
    dirtyCount: num(wv.statusEntryCount),
    reason: str(prov?.plainLanguageReason) ?? str(wv.reason),
    expectedHeadSha: str(prov?.expectedHeadSha),
    actualHeadSha: str(prov?.actualHeadSha),
    ancestryVerdict: str(prov?.ancestryVerdict),
  };
}

export interface IssueRecoveryActionCardProps {
  action: IssueRecoveryAction;
  agentMap?: ReadonlyMap<string, Agent>;
  /** Preferred state hint (e.g. observe_only when watchdog tone is requested). Falls back to derived state. */
  forcedState?: RecoveryCardCardState;
  /** Optional click handler for resolve menu actions. If omitted, the buttons are not rendered. */
  onResolve?: (outcome: RecoveryResolveOutcome) => void;
  /** Whether the viewer can run destructive board-only actions (e.g. false-positive dismissal). */
  canFalsePositive?: boolean;
  className?: string;
  /**
   * "compact" trims the card for embedding inside another surface that already supplies
   * its own heading and context.
   */
  variant?: "default" | "compact";
  /**
   * Workspace-divergence remedies, wired by `RunWorkspaceRecoverySurface`.
   *
   * NOT YET RENDERED. These exist so the caller type-checks against the card it was
   * written for; this fork's card does not draw the controls. `RunWorkspaceRecoverySurface`
   * is currently unreferenced outside its own test, so nothing regresses — but do not
   * assume passing a handler makes a button appear. Drawing them needs a UX decision
   * about where they sit relative to the resolve menu.
   */
  onReissueIsolated?: (request: RecoveryReissueRequest) => void;
  reissuePending?: boolean;
  onReconcileForward?: () => void;
  onBreakGlassOverride?: (reason: string) => void;
  onQuarantineRestore?: () => void;
  /** In-flight flags so the caller's mutation state can disable the matching control. */
  reconcilePending?: boolean;
  quarantineRestorePending?: boolean;
  /** Break-glass override is board-only; the caller decides whether to offer it. */
  canBreakGlass?: boolean;
}

const kindLabel = (kind: IssueRecoveryActionKind): string =>
  t(`recoveryCard.kindLabel.${kind}`);

const kindHeadline = (kind: IssueRecoveryActionKind): string =>
  t(`recoveryCard.kindHeadline.${kind}`);

const STATE_TONE: Record<RecoveryCardCardState, {
  labelKey: string;
  containerClass: string;
  iconWrapClass: string;
  iconClass: string;
  labelClass: string;
  Icon: typeof TriangleAlert;
  divider: string;
}> = {
  needed: {
    labelKey: "recoveryCard.tone.needed",
    containerClass:
      "border-amber-300/70 bg-amber-50/85 text-amber-950 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100",
    iconWrapClass: "bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200",
    iconClass: "text-amber-700 dark:text-amber-300",
    labelClass: "text-amber-900 dark:text-amber-200",
    Icon: TriangleAlert,
    divider: "border-amber-300/60 dark:border-amber-500/30",
  },
  in_progress: {
    labelKey: "recoveryCard.tone.in_progress",
    containerClass:
      "border-sky-300/70 bg-sky-50/80 text-sky-950 dark:border-sky-500/40 dark:bg-sky-500/10 dark:text-sky-100",
    iconWrapClass: "bg-sky-100 text-sky-800 dark:bg-sky-500/20 dark:text-sky-200",
    iconClass: "text-sky-700 dark:text-sky-300",
    labelClass: "text-sky-900 dark:text-sky-200",
    Icon: RefreshCw,
    divider: "border-sky-300/60 dark:border-sky-500/30",
  },
  observe_only: {
    labelKey: "recoveryCard.tone.observe_only",
    containerClass:
      "border-border bg-muted/40 text-foreground dark:bg-muted/20",
    iconWrapClass: "bg-muted text-foreground/70",
    iconClass: "text-muted-foreground",
    labelClass: "text-muted-foreground",
    Icon: Eye,
    divider: "border-border/70",
  },
  escalated: {
    labelKey: "recoveryCard.tone.escalated",
    containerClass:
      "border-red-400/60 bg-red-50/85 text-red-950 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-100",
    iconWrapClass: "bg-red-100 text-red-800 dark:bg-red-500/20 dark:text-red-200",
    iconClass: "text-red-700 dark:text-red-300",
    labelClass: "text-red-900 dark:text-red-200",
    Icon: OctagonAlert,
    divider: "border-red-400/50 dark:border-red-500/30",
  },
  resolved: {
    labelKey: "recoveryCard.tone.resolved",
    containerClass:
      "border-emerald-300/70 bg-emerald-50/80 text-emerald-950 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-100",
    iconWrapClass: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200",
    iconClass: "text-emerald-700 dark:text-emerald-300",
    labelClass: "text-emerald-900 dark:text-emerald-200",
    Icon: Sparkles,
    divider: "border-emerald-300/60 dark:border-emerald-500/30",
  },
};

const outcomeLabel = (outcome: IssueRecoveryActionOutcome): string =>
  t(`recoveryCard.outcome.${outcome}`);

function readEvidenceString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > 240 ? `${trimmed.slice(0, 237)}…` : trimmed;
}

function pickEvidenceSummary(action: IssueRecoveryAction): string | null {
  const evidence = action.evidence ?? {};
  const candidates = [
    "summary",
    "detectedProgressSummary",
    "missingDisposition",
    "retryReason",
    "latestRunErrorCode",
    "latestRunStatus",
    "latestIssueStatus",
  ] as const;
  for (const key of candidates) {
    const next = readEvidenceString(evidence[key]);
    if (next) return next;
  }
  return null;
}

function readEvidenceRunId(action: IssueRecoveryAction, key: "sourceRunId" | "correctiveRunId" | "latestRunId") {
  const evidence = action.evidence ?? {};
  const next = readEvidenceString(evidence[key]);
  return next;
}

function readWakePolicySummary(action: IssueRecoveryAction): string | null {
  const policy = action.wakePolicy;
  if (!policy) return null;
  const type = readEvidenceString(policy.type);
  if (!type) return null;
  if (type === "wake_owner") return t("recoveryCard.wake.correctiveQueued");
  if (type === "board_escalation") return t("recoveryCard.wake.escalatedToBoard");
  if (type === "manual") return t("recoveryCard.wake.manual");
  if (type === "monitor") {
    const interval = readEvidenceString(policy.intervalLabel);
    return interval
      ? t("recoveryCard.wake.monitorScheduledWithInterval", { interval })
      : t("recoveryCard.wake.monitorScheduled");
  }
  return type.replaceAll("_", " ");
}

function formatTimeShort(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  try {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    const now = Date.now();
    const diffMs = date.getTime() - now;
    const absMin = Math.round(Math.abs(diffMs) / 60_000);
    if (absMin < 60) {
      return diffMs >= 0
        ? t("recoveryCard.time.inMinutes", { count: absMin })
        : t("recoveryCard.time.minutesAgo", { count: absMin });
    }
    return date.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return null;
  }
}

function shortenRunId(runId: string | null | undefined) {
  if (!runId) return null;
  if (runId.length <= 12) return runId;
  return runId.slice(0, 8);
}

function MetadataRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[7.5rem_1fr] gap-x-3 gap-y-0 px-3 py-1.5 text-xs sm:px-4">
      <dt className="truncate text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
        {label}
      </dt>
      <dd className="min-w-0 break-words text-foreground/90">{children}</dd>
    </div>
  );
}

function MissingValue() {
  return <span className="text-muted-foreground">—</span>;
}

function AgentLink({
  agentId,
  agentMap,
  fallback,
}: {
  agentId: string | null | undefined;
  agentMap?: ReadonlyMap<string, Agent>;
  fallback?: string | null;
}) {
  if (!agentId) {
    return fallback ? <span>{fallback}</span> : <MissingValue />;
  }
  const agent = agentMap?.get(agentId);
  const label = agent?.name ?? t("recoveryCard.agentShort", { id: agentId.slice(0, 8) });
  if (agent) {
    return (
      <Link
        to={agentUrl(agent)}
        className="rounded-sm font-medium underline-offset-2 hover:underline"
      >
        {label}
      </Link>
    );
  }
  return <span className="font-medium">{label}</span>;
}

function RunChip({
  runId,
  agentId,
  status,
}: {
  runId: string | null;
  agentId: string | null | undefined;
  status?: string | null;
}) {
  if (!runId) return <MissingValue />;
  const short = shortenRunId(runId);
  const inner = (
    <>
      <code className="rounded bg-background/80 px-1.5 py-0.5 font-mono text-[11px] text-foreground/80">
        {t("recoveryCard.runShort", { id: short })}
      </code>
      {status ? (
        <span className="font-sans text-[11px] text-muted-foreground">{status}</span>
      ) : null}
    </>
  );
  if (agentId) {
    return (
      <Link
        to={`/agents/${agentId}/runs/${runId}`}
        className="inline-flex items-center gap-2 rounded-sm underline-offset-2 hover:underline"
      >
        {inner}
      </Link>
    );
  }
  return <span className="inline-flex items-center gap-2">{inner}</span>;
}

const RESOLVE_OPTIONS: Array<{
  outcome: RecoveryResolveOutcome;
  destructive?: boolean;
  boardOnly?: boolean;
}> = [
  {
    outcome: "todo",
  },
  {
    outcome: "done",
  },
  {
    outcome: "in_review",
  },
  {
    outcome: "false_positive_done",
    destructive: true,
    boardOnly: true,
  },
  {
    outcome: "false_positive_in_review",
    destructive: true,
    boardOnly: true,
  },
];

export function IssueRecoveryActionCard({
  action,
  agentMap,
  forcedState,
  onResolve,
  variant = "default",
  onReissueIsolated,
  reissuePending = false,
  onReconcileForward,
  onBreakGlassOverride,
  onQuarantineRestore,
  reconcilePending = false,
  quarantineRestorePending = false,
  canBreakGlass = false,
  canFalsePositive = false,
  className,
}: IssueRecoveryActionCardProps) {
  const { t } = useTranslation();
  const cardState: RecoveryCardCardState = forcedState ?? deriveRecoveryCardState(action);
  const tone = STATE_TONE[cardState];
  const ToneIcon = tone.Icon;

  const headline = useMemo(() => {
    if (cardState === "resolved" && action.outcome) {
      return t("recoveryCard.resolvedAs", {
        outcome: outcomeLabel(action.outcome) ?? action.outcome,
      });
    }
    return kindHeadline(action.kind) ?? kindHeadline("missing_disposition");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action.kind, action.outcome, cardState, t]);

  const wakeSummary = readWakePolicySummary(action);
  const evidenceSummary = pickEvidenceSummary(action);
  const sourceRunId = readEvidenceRunId(action, "sourceRunId") ?? readEvidenceRunId(action, "latestRunId");
  const correctiveRunId = readEvidenceRunId(action, "correctiveRunId");
  const showAttempt = action.attemptCount > 1 && action.maxAttempts !== null;
  const showTimeoutInline = (() => {
    if (!action.timeoutAt) return false;
    try {
      const date = action.timeoutAt instanceof Date ? action.timeoutAt : new Date(action.timeoutAt);
      const diffMs = date.getTime() - Date.now();
      return diffMs > 0 && diffMs < 60 * 60 * 1000;
    } catch {
      return false;
    }
  })();
  const updatedAtLabel = formatTimeShort(action.updatedAt);

  const ariaState = t(`recoveryCard.ariaState.${cardState}`);

  const showResolveActions = onResolve !== undefined && cardState !== "resolved";
  const wv = workspaceValidationEvidence(action);
  // Only offer remedies the caller can actually perform.
  const showWorkspaceRemedies =
    cardState !== "resolved"
    // Only for a workspace-validation action with readable evidence: these remedies are
    // all git operations, so offering them for any other recovery kind would be a button
    // that cannot mean anything.
    && wv !== null
    && (onQuarantineRestore !== undefined
      || onReconcileForward !== undefined
      || onReissueIsolated !== undefined
      || (onBreakGlassOverride !== undefined && canBreakGlass));
  const visibleResolveOptions = RESOLVE_OPTIONS.filter((option) => {
    if (option.boardOnly && !canFalsePositive) return false;
    return true;
  });

  return (
    <section
      role="status"
      aria-label={t("recoveryCard.ariaLabel", { state: ariaState })}
      data-recovery-state={cardState}
      data-recovery-kind={action.kind}
      className={cn(
        "relative w-full overflow-hidden rounded-lg border text-sm shadow-[0_1px_0_rgba(15,23,42,0.02)]",
        tone.containerClass,
        className,
      )}
    >
      <header className="flex items-start gap-3 px-3 py-2.5 sm:px-4">
        <span
          className={cn(
            "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md",
            tone.iconWrapClass,
          )}
          aria-hidden
        >
          <ToneIcon className={cn("h-4 w-4", tone.iconClass)} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] font-semibold uppercase tracking-[0.14em]">
            <span className={tone.labelClass}>{t(tone.labelKey)}</span>
            <span className="text-muted-foreground/60" aria-hidden>·</span>
            <code className="rounded bg-background/70 px-1.5 py-0.5 font-mono text-[11px] tracking-normal text-muted-foreground">
              {kindLabel(action.kind) ?? action.kind}
            </code>
            {updatedAtLabel ? (
              <>
                <span className="text-muted-foreground/60" aria-hidden>·</span>
                <span className="font-medium normal-case tracking-normal text-muted-foreground">
                  {updatedAtLabel}
                </span>
              </>
            ) : null}
          </div>
          <p className="mt-1 text-[14px] leading-6">{headline}</p>
        </div>
      </header>
      <dl className={cn("border-t bg-background/40 dark:bg-background/20", tone.divider)}>
        <MetadataRow label={t("recoveryCard.field.owner")}>
          <span className="inline-flex flex-wrap items-center gap-1.5">
            {action.ownerType === "agent" && action.ownerAgentId ? (
              <>
                <span className="text-muted-foreground">{t("recoveryCard.recoveryColon")}</span>
                <AgentLink agentId={action.ownerAgentId} agentMap={agentMap} />
              </>
            ) : action.ownerType === "board" ? (
              <span className="font-medium">{t("recoveryCard.board")}</span>
            ) : action.ownerType === "user" && action.ownerUserId ? (
              <span className="font-medium">{t("recoveryCard.userShort", { id: action.ownerUserId.slice(0, 6) })}</span>
            ) : action.ownerType === "system" ? (
              <span className="font-medium">{t("recoveryCard.system")}</span>
            ) : (
              <span className="text-muted-foreground">{t("recoveryCard.unassignedPickOne")}</span>
            )}
            {action.returnOwnerAgentId ? (
              <>
                <span className="text-muted-foreground">{t("recoveryCard.returnsTo")}</span>
                <AgentLink agentId={action.returnOwnerAgentId} agentMap={agentMap} />
              </>
            ) : null}
          </span>
        </MetadataRow>
        <MetadataRow label={t("recoveryCard.field.sourceRun")}>
          <RunChip runId={sourceRunId} agentId={action.previousOwnerAgentId} />
        </MetadataRow>
        {correctiveRunId ? (
          <MetadataRow label={t("recoveryCard.field.correctiveRun")}>
            <RunChip runId={correctiveRunId} agentId={action.previousOwnerAgentId} />
          </MetadataRow>
        ) : null}
        <MetadataRow label={t("recoveryCard.field.evidence")}>
          {evidenceSummary ? (
            <span className="break-words font-mono text-[11px] text-foreground/80">{evidenceSummary}</span>
          ) : (
            <MissingValue />
          )}
        </MetadataRow>
        {/*
          The compact variant is embedded in a surface that renders the remedy as an actual
          control, so repeating the instruction as prose ("Repair the workspace.") tells the
          operator to do something the button beside it already does. Trimmed there, kept
          everywhere else, where there is no button and the sentence is the only guidance.
        */}
        {variant === "compact" && showWorkspaceRemedies ? null : (
          <MetadataRow label={t("recoveryCard.field.nextAction")}>
            {action.nextAction ? <span>{action.nextAction}</span> : <MissingValue />}
          </MetadataRow>
        )}
        <MetadataRow label={t("recoveryCard.field.wake")}>
          <span className="inline-flex flex-wrap items-center gap-1.5">
            {wakeSummary ? <span>{wakeSummary}</span> : <MissingValue />}
            {showAttempt ? (
              <span className="rounded-md border border-border/50 bg-background/60 px-1.5 py-0.5 text-[11px] text-muted-foreground">
                {t("recoveryCard.attemptOf", { count: action.attemptCount, max: action.maxAttempts })}
              </span>
            ) : null}
            {showTimeoutInline ? (
              <span className="rounded-md border border-border/50 bg-background/60 px-1.5 py-0.5 text-[11px] text-muted-foreground">
                {t("recoveryCard.timesOut", { time: formatTimeShort(action.timeoutAt) ?? t("recoveryCard.soon") })}
              </span>
            ) : null}
          </span>
        </MetadataRow>
        {cardState === "resolved" && action.outcome ? (
          <MetadataRow label={t("recoveryCard.field.resolution")}>
            <span className={cn("font-medium", tone.labelClass)}>
              {t("recoveryCard.resolvedAsShort", { outcome: outcomeLabel(action.outcome) })}
              {action.resolvedAt ? ` · ${formatTimeShort(action.resolvedAt) ?? ""}` : ""}
            </span>
          </MetadataRow>
        ) : null}
      </dl>
      {wv ? (
        <div
          data-testid="recovery-divergence-diagnosis"
          className={cn("border-t px-3 py-2.5 text-xs leading-5 sm:px-4", tone.divider)}
        >
          {wv.reason ? <p className="font-medium">{wv.reason}</p> : null}
          <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2">
            {wv.expectedBranch ? (
              <>
                <dt className="text-muted-foreground">
                  {t("recoveryCard.workspace.recordedBranch", { defaultValue: "Recorded branch" })}
                </dt>
                <dd className="min-w-0 truncate font-mono">{wv.expectedBranch}</dd>
              </>
            ) : null}
            {wv.actualBranch ? (
              <>
                <dt className="text-muted-foreground">
                  {t("recoveryCard.workspace.liveBranch", { defaultValue: "Live branch" })}
                </dt>
                <dd className="min-w-0 truncate font-mono">{wv.actualBranch}</dd>
              </>
            ) : null}
            {wv.expectedHeadSha || wv.actualHeadSha ? (
              <>
                <dt className="text-muted-foreground">
                  {t("recoveryCard.workspace.heads", { defaultValue: "Heads" })}
                </dt>
                <dd className="min-w-0 truncate font-mono">
                  {(wv.expectedHeadSha ?? "").slice(0, 10)}
                  {wv.expectedHeadSha && wv.actualHeadSha ? " → " : ""}
                  {(wv.actualHeadSha ?? "").slice(0, 10)}
                </dd>
              </>
            ) : null}
            {ancestryVerdictLabel(wv.ancestryVerdict) ? (
              <>
                <dt className="text-muted-foreground">
                  {t("recoveryCard.workspace.ancestry", { defaultValue: "Ancestry" })}
                </dt>
                <dd data-testid="recovery-ancestry-verdict">{ancestryVerdictLabel(wv.ancestryVerdict)}</dd>
              </>
            ) : null}
            {wv.cleanliness ? (
              <>
                <dt className="text-muted-foreground">
                  {t("recoveryCard.workspace.tree", { defaultValue: "Working tree" })}
                </dt>
                <dd>
                  {wv.cleanliness === "dirty"
                    ? t("recoveryCard.workspace.dirtyWithCount", {
                        count: wv.dirtyCount ?? 0,
                        defaultValue: "uncommitted changes ({{count}})",
                      })
                    : wv.cleanliness}
                </dd>
              </>
            ) : null}
          </dl>
        </div>
      ) : null}

      {showWorkspaceRemedies ? (
        <div className={cn("flex flex-wrap items-center gap-2 border-t px-3 py-2.5 sm:px-4", tone.divider)}>
          {/* Repair sets aside uncommitted work; with a clean tree there is nothing to set aside. */}
          {onQuarantineRestore && wv.cleanliness === "dirty" ? (
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  data-testid="recovery-action-repair-trigger"
                  disabled={quarantineRestorePending}
                >
                  {t("recoveryCard.workspace.repair", { defaultValue: "Repair workspace" })}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-72 space-y-2 p-3 text-xs">
                <p>
                  {t("recoveryCard.workspace.repairExplain", {
                    defaultValue:
                      "Moves the uncommitted changes aside and restores the workspace to the recorded branch. Nothing is deleted — the set-aside changes stay recoverable.",
                  })}
                </p>
                <Button
                  type="button"
                  size="sm"
                  data-testid="recovery-action-repair-confirm"
                  disabled={quarantineRestorePending}
                  onClick={() => onQuarantineRestore()}
                >
                  {t("recoveryCard.workspace.repairConfirm", { defaultValue: "Set aside and restore" })}
                </Button>
              </PopoverContent>
            </Popover>
          ) : null}
          {onReconcileForward ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="recovery-action-reconcile-forward"
              disabled={reconcilePending}
              onClick={() => onReconcileForward()}
            >
              {t("recoveryCard.workspace.reconcileForward", { defaultValue: "Accept live branch" })}
            </Button>
          ) : null}
          {onReissueIsolated && wv?.actualBranch ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="recovery-action-reissue-isolated"
              disabled={reissuePending}
              onClick={() =>
                onReissueIsolated({
                  baseRef: wv.actualBranch as string,
                  expectedBranch: wv.expectedBranch,
                })
              }
            >
              {t("recoveryCard.workspace.reissueIsolated", { defaultValue: "Re-issue on a worktree" })}
            </Button>
          ) : null}
          {onBreakGlassOverride && canBreakGlass ? (
            <Popover>
              <PopoverTrigger asChild>
                <Button type="button" size="sm" variant="ghost" className="text-destructive"
                  data-testid="recovery-action-break-glass-trigger" disabled={reconcilePending}>
                  {t("recoveryCard.workspace.breakGlass", { defaultValue: "Override" })}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-72 space-y-2 p-3 text-xs">
                <p>
                  {t("recoveryCard.workspace.breakGlassExplain", {
                    defaultValue:
                      "Forces the workspace to proceed as-is. Recorded for audit, and the divergence is not repaired.",
                  })}
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  data-testid="recovery-action-break-glass-confirm"
                  onClick={() =>
                    onBreakGlassOverride(
                      t("recoveryCard.workspace.breakGlassReason", {
                        defaultValue: "Operator override from the run recovery surface",
                      }),
                    )
                  }
                >
                  {t("recoveryCard.workspace.breakGlassConfirm", { defaultValue: "Override anyway" })}
                </Button>
              </PopoverContent>
            </Popover>
          ) : null}
        </div>
      ) : null}

      {showResolveActions ? (
        <div className={cn("flex flex-wrap items-center gap-2 border-t px-3 py-2.5 sm:px-4", tone.divider)}>
          <Popover>
            <PopoverTrigger asChild>
              <Button
                type="button"
                size="sm"
                variant="default"
                data-testid="recovery-action-resolve-trigger"
                aria-label={t("recoveryCard.resolveRecovery")}
              >
                {t("recoveryCard.resolveEllipsis")}
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              sideOffset={6}
              className="w-72 p-1.5"
            >
              <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                {t("recoveryCard.resolveRecovery")}
              </div>
              <div className="flex flex-col">
                {visibleResolveOptions.map((option) => (
                  <button
                    key={option.outcome}
                    type="button"
                    onClick={() => onResolve?.(option.outcome)}
                    className={cn(
                      "flex flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                      "hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                      option.destructive ? "text-destructive" : null,
                    )}
                  >
                    <span className="font-medium leading-5">{t(`recoveryCard.resolveOption.${option.outcome}.label`)}</span>
                    <span className="text-[11px] leading-4 text-muted-foreground">{t(`recoveryCard.resolveOption.${option.outcome}.description`)}</span>
                  </button>
                ))}
              </div>
            </PopoverContent>
          </Popover>
          {cardState === "observe_only" ? (
            <span className="text-[11px] text-muted-foreground">
              {t("recoveryCard.observingNote")}
            </span>
          ) : (
            <span className="text-[11px] text-muted-foreground">
              {t("recoveryCard.staysOpenNote")}
            </span>
          )}
        </div>
      ) : null}
    </section>
  );
}

export type { IssueRecoveryActionStatus };

export default IssueRecoveryActionCard;
