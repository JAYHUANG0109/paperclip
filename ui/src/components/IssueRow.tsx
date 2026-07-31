import type { ReactNode } from "react";
import type { ExternalObjectSummary, Issue, IssueRecoveryAction } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { useTranslation } from "@/i18n";
import { Eye, Flag, X } from "lucide-react";
import {
  createIssueDetailPath,
  rememberIssueDetailLocationState,
  withIssueDetailHeaderSeed,
} from "../lib/issueDetailBreadcrumb";
import { cn } from "../lib/utils";
import {
  deriveActiveRecoveryDisplayState,
  RECOVERY_CHIP_DEFAULT_TONE,
  recoveryChipLabel,
} from "../lib/recovery-display";
import { StatusIcon } from "./StatusIcon";
import { productivityReviewTriggerLabel } from "./ProductivityReviewBadge";
import { hasAssignedBacklogBlocker } from "../lib/issue-blockers";
import { ExternalObjectStatusSummary } from "./ExternalObjectStatusSummary";

type UnreadState = "hidden" | "visible" | "fading";

interface IssueRowProps {
  issue: Issue;
  issueLinkState?: unknown;
  selected?: boolean;
  mobileLeading?: ReactNode;
  desktopMetaLeading?: ReactNode;
  desktopLeadingSpacer?: boolean;
  mobileMeta?: ReactNode;
  desktopTrailing?: ReactNode;
  /**
   * Optional pre-fetched external-object summary. Renders a compact severity
   * marker before the rest of `desktopTrailing` on desktop only.
   */
  externalObjectSummary?: ExternalObjectSummary | null;
  trailingMeta?: ReactNode;
  titleSuffix?: ReactNode;
  titleClassName?: string;
  checklistStepNumber?: number | string | null;
  checklistCurrentStep?: boolean;
  checklistDependencyChips?: ReactNode;
  checklistRowId?: string;
  unreadState?: UnreadState | null;
  /**
   * Nested-issue tree rendering (upstream 2026-07). `treeGuides` is the row's
   * depth — one vertical guide slot is drawn per ancestor level;
   * `chevronInGuide` breaks the innermost guide around this row's own chevron;
   * `hideDivider` drops the bottom border so an expanded parent reads as one
   * block with its children. Passed by IssuesList and Inbox.
   */
  treeGuides?: number;
  chevronInGuide?: boolean;
  hideDivider?: boolean;
  onMarkRead?: () => void;
  onArchive?: () => void;
  archiveDisabled?: boolean;
  className?: string;
}

export function IssueRow({
  issue,
  issueLinkState,
  selected = false,
  mobileLeading,
  desktopMetaLeading,
  desktopLeadingSpacer = false,
  mobileMeta,
  desktopTrailing,
  externalObjectSummary,
  trailingMeta,
  titleSuffix,
  titleClassName,
  checklistStepNumber = null,
  checklistCurrentStep = false,
  checklistDependencyChips,
  checklistRowId,
  unreadState = null,
  treeGuides = 0,
  chevronInGuide = false,
  hideDivider = false,
  onMarkRead,
  onArchive,
  archiveDisabled,
  className,
}: IssueRowProps) {
  const { t } = useTranslation();
  const issuePathId = issue.identifier ?? issue.id;
  const identifier = issue.identifier ?? issue.id.slice(0, 8);
  // A row participates in the unread system whenever `unreadState` is supplied
  // (inbox rows). It then reserves a fixed leading dot slot on all rows — read
  // and unread alike — so the mark-read dot sits in the far-left gutter without
  // shifting content, matching the sibling non-issue inbox rows.
  const showUnreadSlot = unreadState != null;
  const showUnreadDot = unreadState === "visible" || unreadState === "fading";
  const unreadDotButton = (
    <button
      type="button"
      data-slot="icon-button"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onMarkRead?.();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          event.stopPropagation();
          onMarkRead?.();
        }
      }}
      className={cn(
        "inline-flex h-4 w-4 items-center justify-center rounded-full transition-colors",
        selected ? "hover:bg-muted/80" : "hover:bg-blue-500/20",
      )}
      aria-label="Mark as read"
    >
      <span
        className={cn(
          "block h-2 w-2 rounded-full transition-opacity duration-300",
          selected ? "bg-muted-foreground/70" : "bg-blue-600 dark:bg-blue-400",
          unreadState === "fading" ? "opacity-0" : "opacity-100",
        )}
      />
    </button>
  );
  const selectedStatusClass = selected ? "!text-muted-foreground !border-muted-foreground" : undefined;
  const detailState = withIssueDetailHeaderSeed(issueLinkState, issue);
  const productivityReview = issue.productivityReview ?? null;
  const productivityReviewIndicator = productivityReview ? (
    <span
      className={cn(
        "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300",
        selected ? "border-muted-foreground text-muted-foreground" : null,
      )}
      title={`Productivity review: ${productivityReviewTriggerLabel(productivityReview.trigger)}`}
      aria-label={t("issues.productivityReviewOpen")}
    >
      <Eye className="h-2.5 w-2.5" aria-hidden />
    </span>
  ) : null;
  const hasChecklistStep = checklistStepNumber !== null;
  const checklistStep = hasChecklistStep ? (
    <span className="shrink-0 font-mono text-xs text-muted-foreground" aria-hidden="true">
      {checklistStepNumber}.
    </span>
  ) : null;
  const recoveryAction = issue.activeRecoveryAction ?? null;
  const recoveryIndicator = recoveryAction ? renderRecoveryChip(recoveryAction, selected) : null;
  const parkedBlockerIndicator = hasAssignedBacklogBlocker(issue.blockedBy) ? (
    <span
      data-testid="issue-row-parked-blocker"
      className="ml-1.5 inline-flex shrink-0 items-center gap-0.5 rounded-full border border-amber-500/60 bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300"
      title={t("issues.parkedBlockerTooltip")}
    >
      <Flag className="h-2.5 w-2.5" aria-hidden />
      {t("issues.parkedBlocker")}
    </span>
  ) : null;

  return (
    <Link
      to={createIssueDetailPath(issuePathId)}
      state={detailState}
      disableIssueQuicklook
      issuePrefetch={issue}
      data-inbox-issue-link
      id={checklistRowId}
      aria-current={checklistCurrentStep ? "step" : undefined}
      onClickCapture={() => rememberIssueDetailLocationState(issuePathId, detailState)}
      className={cn(
        // No color transition on the row band: hover/selection must snap
        // instantly. A fade (transition-colors) leaves a trail of fading bands
        // when scrubbing the mouse fast across the list.
        "group relative flex items-start gap-2 rounded-lg py-2.5 pl-2 pr-3 text-sm no-underline text-inherit sm:items-center sm:py-2 sm:pl-1",
        !hideDivider && "border-b border-border last:border-b-0",
        selected ? "hover:bg-transparent" : "hover:bg-accent/50",
        checklistCurrentStep ? "border-l-2 border-l-primary bg-primary/5 pl-[calc(theme(spacing.2)-2px)] sm:pl-[calc(theme(spacing.1)-2px)]" : null,
        className,
      )}
    >
      <span className="flex shrink-0 items-center gap-1 pt-px sm:hidden">
        {mobileLeading ?? <StatusIcon status={issue.status} blockerAttention={issue.blockerAttention} size="lg" className={selectedStatusClass} />}
        {productivityReviewIndicator}
        {parkedBlockerIndicator}
        {recoveryIndicator}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1 sm:contents">
        <span className={cn("line-clamp-2 text-sm sm:order-2 sm:min-w-0 sm:flex-1 sm:truncate sm:line-clamp-none", titleClassName)}>
          {issue.title}{titleSuffix}
        </span>
        {checklistDependencyChips ? (
          <span className="flex flex-wrap gap-1 sm:order-3 sm:ml-[calc(theme(spacing.3)+theme(spacing.2))]">
            {checklistDependencyChips}
          </span>
        ) : null}
        <span className="flex items-center gap-2 self-stretch sm:order-1 sm:shrink-0">
          {showUnreadSlot ? (
            // Reserved leftmost dot gutter (desktop). Present on read and unread
            // rows so the mark-read dot lives to the LEFT of any leading control
            // (a parent's collapse caret, a tree guide) without indenting the row
            // relative to its siblings, and aligns with the non-issue inbox rows
            // that reserve the same w-4 slot.
            <span
              data-testid="issue-row-unread-slot"
              className="hidden h-4 w-4 shrink-0 items-center justify-center self-center sm:inline-flex"
            >
              {showUnreadDot ? unreadDotButton : null}
            </span>
          ) : null}
          {treeGuides > 0
            ? Array.from({ length: treeGuides }, (_, level) => {
              // The innermost guide lands on THIS row's own chevron column; if
              // the row has a chevron, break the line around it so it isn't
              // crossed out.
              const gapForChevron = chevronInGuide && level === treeGuides - 1;
              return (
              // Tree guide: occupies the same flex slot as the parent's
              // chevron column so the line lands under the parent's status
              // column; stretched past the row padding so consecutive rows
              // read as one continuous line.
              <span key={`guide-${level}`} aria-hidden="true" className="relative hidden w-4 shrink-0 self-stretch sm:block">
                {/* The connector drops from under the ancestor's STATUS icon,
                    not its chevron: the status column sits one level (w-4 slot
                    + gap-2 = 2rem) right of this guide slot's left edge.
                    bg-background underlay: dark-mode --border is translucent,
                    so overlapping row segments would stack brighter without
                    an opaque base. */}
                <span className="absolute -inset-y-3 left-8 w-px bg-background">
                  {gapForChevron ? (
                    // Two border segments centering a 14px (h-3.5) transparent
                    // gap for the row's own chevron.
                    <span className="absolute inset-0 flex flex-col">
                      <span className="flex-1 bg-border" />
                      <span className="h-3.5 shrink-0" />
                      <span className="flex-1 bg-border" />
                    </span>
                  ) : (
                    <span className="absolute inset-0 bg-border" />
                  )}
                </span>
              </span>
              );
            })
            : null}
          {desktopLeadingSpacer ? (
            <span className="hidden w-3.5 shrink-0 sm:block" />
          ) : null}
          {desktopMetaLeading ?? (
            <>
              <span className="hidden shrink-0 items-center gap-1 sm:inline-flex">
                <StatusIcon status={issue.status} blockerAttention={issue.blockerAttention} size="lg" className={selectedStatusClass} />
                {productivityReviewIndicator}
              </span>
              {checklistStep}
              <span className="shrink-0 font-mono text-xs text-muted-foreground">
                {identifier}
              </span>
              {parkedBlockerIndicator}
              {recoveryIndicator}
            </>
          )}
          {mobileMeta ? (
            <>
              <span className="text-xs text-muted-foreground sm:hidden" aria-hidden="true">
                &middot;
              </span>
              <span className="text-xs text-muted-foreground sm:hidden">{mobileMeta}</span>
            </>
          ) : null}
        </span>
      </span>
      {(desktopTrailing || trailingMeta || externalObjectSummary) ? (
        <span className="ml-auto hidden shrink-0 items-center gap-2 sm:order-3 sm:flex sm:gap-3">
          {externalObjectSummary ? (
            <ExternalObjectStatusSummary summary={externalObjectSummary} compact />
          ) : null}
          {desktopTrailing}
          {trailingMeta ? (
            <span className="text-xs text-muted-foreground">{trailingMeta}</span>
          ) : null}
        </span>
      ) : null}
      {showUnreadSlot ? (
        <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center self-center">
          {showUnreadDot ? (
            <button
              type="button"
              data-slot="icon-button"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onMarkRead?.();
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  event.stopPropagation();
                  onMarkRead?.();
                }
              }}
              className={cn(
                "inline-flex h-4 w-4 items-center justify-center rounded-full transition-colors",
                selected ? "hover:bg-muted/80" : "hover:bg-blue-500/20",
              )}
              aria-label={t("issues.markAsRead")}
            >
              <span
                className={cn(
                  "block h-2 w-2 rounded-full transition-opacity duration-300",
                  selected ? "bg-muted-foreground/70" : "bg-blue-600 dark:bg-blue-400",
                  unreadState === "fading" ? "opacity-0" : "opacity-100",
                )}
              />
            </button>
          ) : onArchive ? (
            <button
              type="button"
              data-slot="icon-button"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onArchive();
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                event.stopPropagation();
                onArchive();
              }}
              disabled={archiveDisabled}
              className="inline-flex h-4 w-4 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100 disabled:pointer-events-none disabled:opacity-30"
              aria-label={t("issues.dismissFromInbox")}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}
          {externalObjectSummary ? (
            <ExternalObjectStatusSummary summary={externalObjectSummary} compact />
          ) : null}
          {desktopTrailing}
          {trailingMeta ? (
            <span className="text-xs text-muted-foreground">{trailingMeta}</span>
          ) : null}
        </span>
      ) : null}
      {showUnreadDot ? (
        // Mobile keeps the dot in flow as the leading item (mobile has no
        // reserved desktop dot gutter). Desktop renders the dot in the reserved
        // leading slot above instead, so this is mobile-only.
        <span className="order-first inline-flex h-4 w-4 shrink-0 items-center justify-center self-center sm:hidden">
          {unreadDotButton}
        </span>
      ) : null}
    </Link>
  );
}

function renderRecoveryChip(action: IssueRecoveryAction, selected: boolean): ReactNode {
  const state = deriveActiveRecoveryDisplayState(action);
  if (!state) return null;
  const tone = RECOVERY_CHIP_DEFAULT_TONE[state];
  const Icon = tone.icon;
  const label = recoveryChipLabel(state, action.kind);
  return (
    <span
      data-testid="issue-row-recovery-indicator"
      data-recovery-state={state}
      data-recovery-kind={action.kind}
      role="status"
      aria-label={label}
      className={cn(
        "ml-1.5 inline-flex shrink-0 items-center gap-0.5 rounded-full border px-2 py-0.5 text-[10px] font-medium",
        tone.className,
        selected ? "!border-muted-foreground !text-muted-foreground" : null,
      )}
      title={`${label} — open the source task to act.`}
    >
      <Icon className="h-2.5 w-2.5" aria-hidden />
      {label}
    </span>
  );
}
