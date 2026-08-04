import type { ReactNode } from "react";
import { Avatar, AvatarFallback } from "./ui/avatar";
import type { Issue } from "@paperclipai/shared";
import { Columns3 } from "lucide-react";
import { pickTextColorForPillBg } from "@/lib/color-contrast";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatAssigneeUserLabel } from "../lib/assignees";
import type { InboxIssueColumn } from "../lib/inbox";
import { cn } from "../lib/utils";
import { t, useTranslation } from "@/i18n";
import { timeAgo } from "../lib/timeAgo";
import { Identity } from "./Identity";
import { StatusIcon } from "./StatusIcon";

export const issueTrailingColumns: InboxIssueColumn[] = ["assignee", "project", "workspace", "parent", "labels", "updated"];

function issueColumnLabel(column: InboxIssueColumn): string {
  return t(`issueColumns.label.${column}`);
}

function issueColumnDescription(column: InboxIssueColumn): string {
  return t(`issueColumns.description.${column}`);
}

export function issueActivityText(issue: Issue): string {
  return t("issueColumns.updatedAgo", { time: timeAgo(issue.lastActivityAt ?? issue.lastExternalCommentAt ?? issue.updatedAt) });
}

function issueTrailingGridTemplate(columns: InboxIssueColumn[]): string {
  return columns
    .map((column) => {
      if (column === "assignee") return "minmax(6rem, 8rem)";
      if (column === "kickedOffBy") return "minmax(6rem, 9rem)";
      if (column === "project") return "minmax(4.5rem, 7rem)";
      if (column === "workspace") return "minmax(6rem, 9rem)";
      if (column === "parent") return "minmax(3.5rem, 5.5rem)";
      if (column === "labels") return "minmax(3rem, 6rem)";
      return "minmax(3.5rem, 4.5rem)";
    })
    .join(" ");
}

export function IssueColumnPicker({
  availableColumns,
  visibleColumnSet,
  onToggleColumn,
  onResetColumns,
  title,
  iconOnly = false,
}: {
  availableColumns: InboxIssueColumn[];
  visibleColumnSet: ReadonlySet<InboxIssueColumn>;
  onToggleColumn: (column: InboxIssueColumn, enabled: boolean) => void;
  onResetColumns: () => void;
  title: string;
  iconOnly?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant={iconOnly ? "outline" : "ghost"}
          size={iconOnly ? "icon" : "sm"}
          className={iconOnly ? "h-8 w-8 shrink-0" : "hidden h-8 shrink-0 px-2 text-xs sm:inline-flex"}
          title={t("issueColumns.columns")}
        >
          <Columns3 className={iconOnly ? "h-3.5 w-3.5" : "mr-1 h-3.5 w-3.5"} />
          {!iconOnly && t("issueColumns.columns")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[300px] rounded-xl border-border/70 p-1.5 shadow-xl shadow-black/10">
        <DropdownMenuLabel className="px-2 pb-1 pt-1.5">
          <div className="space-y-1">
            <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
              {t("issueColumns.desktopIssueRows")}
            </div>
            <div className="text-sm font-medium text-foreground">
              {title}
            </div>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {availableColumns.map((column) => (
          <DropdownMenuCheckboxItem
            key={column}
            checked={visibleColumnSet.has(column)}
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={(checked) => onToggleColumn(column, checked === true)}
            className="items-start rounded-lg px-3 py-2.5 pl-8"
          >
            <span className="flex flex-col gap-0.5">
              <span className="text-sm font-medium text-foreground">
                {issueColumnLabel(column)}
              </span>
              <span className="text-xs leading-relaxed text-muted-foreground">
                {issueColumnDescription(column)}
              </span>
            </span>
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={onResetColumns}
          className="rounded-lg px-3 py-2 text-sm"
        >
          {t("issueColumns.resetDefaults")}
          <span className="ml-auto text-xs text-muted-foreground">{t("issueColumns.resetDefaultsHint")}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function InboxIssueMetaLeading({
  issue,
  isLive,
  subtreeLiveCount = 0,
  showSubtreeLiveChip = true,
  showStatus = true,
  showIdentifier = true,
  statusSlot,
  checklistStepNumber = null,
}: {
  issue: Issue;
  isLive: boolean;
  subtreeLiveCount?: number;
  /**
   * Suppress the "N live below" chip. Callers whose status glyph already conveys
   * descendant liveness pass false, so the same fact is not stated twice in one row.
   */
  showSubtreeLiveChip?: boolean;
  showStatus?: boolean;
  showIdentifier?: boolean;
  statusSlot?: ReactNode;
  checklistStepNumber?: number | string | null;
}) {
  const { t } = useTranslation();
  return (
    <>
      {showStatus ? (
        <span className="hidden shrink-0 items-center sm:inline-flex">
          {statusSlot ?? <StatusIcon status={issue.status} blockerAttention={issue.blockerAttention} />}
        </span>
      ) : null}
      {checklistStepNumber !== null ? (
        <span className="shrink-0 font-mono text-xs text-muted-foreground" aria-hidden="true">
          {checklistStepNumber}.
        </span>
      ) : null}
      {showIdentifier ? (
        <span className="shrink-0 font-mono text-xs text-muted-foreground">
          {issue.identifier ?? issue.id.slice(0, 8)}
        </span>
      ) : null}
      {isLive && (
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 sm:gap-1.5 sm:px-2",
            "bg-blue-500/10",
          )}
        >
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-pulse rounded-full bg-blue-400 opacity-75" />
            <span
              className={cn(
                "relative inline-flex h-2 w-2 rounded-full",
                "bg-blue-500",
              )}
            />
          </span>
          <span
            className={cn(
              "hidden text-[11px] font-medium sm:inline",
              "text-blue-600 dark:text-blue-400",
            )}
          >
            {t("kanban.live")}
          </span>
        </span>
      )}
      {showSubtreeLiveChip && !isLive && subtreeLiveCount > 0 && (
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 sm:gap-1.5 sm:px-2",
            "border-border bg-transparent",
          )}
          title={`${subtreeLiveCount} sub-task${subtreeLiveCount === 1 ? "" : "s"} running below`}
        >
          <span
            className={cn(
              "h-2 w-2 shrink-0 rounded-full border",
              "border-muted-foreground/60 bg-transparent",
            )}
            aria-hidden="true"
          />
          <span className="hidden text-[11px] font-medium text-muted-foreground sm:inline">
            {subtreeLiveCount} live below
          </span>
        </span>
      )}
    </>
  );
}

export function InboxIssueTrailingColumns({
  issue,
  columns,
  projectName,
  projectColor,
  workspaceId,
  workspaceName,
  assigneeName,
  assigneeUserName,
  assigneeUserAvatarUrl,
  currentUserId,
  parentIdentifier,
  parentTitle,
  assigneeContent,
  onFilterWorkspace,
  creatorAgentName,
  creatorUserName,
  viaAgentName,
}: {
  issue: Issue;
  columns: InboxIssueColumn[];
  projectName: string | null;
  projectColor: string | null;
  workspaceId?: string | null;
  workspaceName: string | null;
  assigneeName: string | null;
  assigneeUserName?: string | null;
  assigneeUserAvatarUrl?: string | null;
  currentUserId: string | null;
  parentIdentifier: string | null;
  parentTitle: string | null;
  assigneeContent?: ReactNode;
  onFilterWorkspace?: (workspaceId: string) => void;
  /** Display name of the agent that created the issue, resolved by the caller. */
  creatorAgentName?: string | null;
  /**
   * Display name of the PERSON behind the issue — the responsible user when there is one,
   * otherwise the creating user. Resolved by the caller, which owns the user directory.
   */
  creatorUserName?: string | null;
  /** Agent that acted for the responsible user, shown as secondary context. */
  viaAgentName?: string | null;
}) {
  const { t } = useTranslation();
  const activityText = timeAgo(issue.lastActivityAt ?? issue.lastExternalCommentAt ?? issue.updatedAt);
  const userLabel = assigneeUserName ?? formatAssigneeUserLabel(issue.assigneeUserId, currentUserId) ?? t("issueColumns.user");

  return (
    <span
      className="grid items-center gap-2"
      style={{ gridTemplateColumns: issueTrailingGridTemplate(columns) }}
    >
      {columns.map((column) => {
        if (column === "kickedOffBy") {
          // Who is answerable for this issue existing. The responsible user WINS over the
          // creating agent: when an agent files work on someone's behalf, the person is
          // who a colleague needs, and the agent is only how it happened. A routine
          // execution has no creator at all but still carries a responsible user, which is
          // the case that used to render as nothing.
          const person = issue.responsibleUserId || issue.createdByUserId ? creatorUserName ?? null : null;
          const agentOnly = !person && issue.createdByAgentId ? creatorAgentName ?? null : null;
          const label = person ?? agentOnly;
          if (!label) {
            return <span key={column} className="min-w-0 truncate text-muted-foreground">—</span>;
          }
          const via = person && viaAgentName ? viaAgentName : null;
          return (
            <span key={column} className="flex min-w-0 items-center gap-1.5">
              <Avatar size="xs" shape={person ? "circle" : "square"}>
                <AvatarFallback>{label.slice(0, 1).toUpperCase()}</AvatarFallback>
              </Avatar>
              <span className="min-w-0 truncate">
                {label}
                {via ? (
                  <span className="text-muted-foreground">
                    {" "}
                    {t("issueColumns.viaAgent", { name: via, defaultValue: "via {{name}}" })}
                  </span>
                ) : null}
              </span>
            </span>
          );
        }
        if (column === "assignee") {
          if (assigneeContent) {
            return <span key={column} className="min-w-0">{assigneeContent}</span>;
          }

          if (issue.assigneeAgentId) {
            return (
              <span key={column} className="min-w-0 text-xs text-foreground">
                <Identity
                  name={assigneeName ?? issue.assigneeAgentId.slice(0, 8)}
                  size="sm"
                  className="min-w-0"
                />
              </span>
            );
          }

          if (issue.assigneeUserId) {
            return (
              <span key={column} className="min-w-0 text-xs text-foreground">
                <Identity
                  name={userLabel}
                  avatarUrl={assigneeUserAvatarUrl}
                  size="sm"
                  className="min-w-0"
                />
              </span>
            );
          }

          return (
            <span key={column} className="min-w-0 truncate text-xs text-muted-foreground">
              {t("issues.props.unassigned")}
            </span>
          );
        }

        if (column === "project") {
          if (projectName) {
            const accentColor = projectColor ?? "#64748b";
            return (
              <span
                key={column}
                className="inline-flex min-w-0 items-center gap-2 text-xs font-medium"
                style={{ color: pickTextColorForPillBg(accentColor, 0.12) }}
              >
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: accentColor }}
                />
                <span className="truncate">{projectName}</span>
              </span>
            );
          }

          return (
            <span key={column} className="min-w-0 truncate text-xs text-muted-foreground">
              {t("issues.props.noProject")}
            </span>
          );
        }

        if (column === "labels") {
          if ((issue.labels ?? []).length > 0) {
            return (
              <span key={column} className="flex min-w-0 items-center gap-1 overflow-hidden">
                {(issue.labels ?? []).slice(0, 2).map((label) => (
                  <span
                    key={label.id}
                    className="inline-flex min-w-0 max-w-full shrink-0 items-center rounded-full border px-1.5 py-0 text-[10px] font-medium"
                    style={{
                      borderColor: label.color,
                      color: pickTextColorForPillBg(label.color, 0.12),
                      backgroundColor: `${label.color}1f`,
                    }}
                  >
                    <span className="truncate">{label.name}</span>
                  </span>
                ))}
                {(issue.labels ?? []).length > 2 ? (
                  <span className="shrink-0 text-[10px] font-medium text-muted-foreground">
                    +{(issue.labels ?? []).length - 2}
                  </span>
                ) : null}
              </span>
            );
          }

          return <span key={column} className="min-w-0" aria-hidden="true" />;
        }

        if (column === "workspace") {
          if (!workspaceName) {
            return <span key={column} className="min-w-0" aria-hidden="true" />;
          }

          return (
            <span key={column} className="min-w-0 truncate text-xs text-muted-foreground">
              {workspaceId && onFilterWorkspace ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className="truncate rounded-sm text-left text-xs text-muted-foreground transition-colors hover:text-foreground hover:underline"
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        onFilterWorkspace(workspaceId);
                      }}
                    >
                      {workspaceName}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" sideOffset={6}>
                    {t("issueColumns.filterByWorkspace")}
                  </TooltipContent>
                </Tooltip>
              ) : (
                workspaceName
              )}
            </span>
          );
        }

        if (column === "parent") {
          if (!issue.parentId) {
            return <span key={column} className="min-w-0" aria-hidden="true" />;
          }

          return (
            <span key={column} className="min-w-0 truncate text-xs text-muted-foreground" title={parentTitle ?? undefined}>
              {parentIdentifier ? (
                <span className="font-mono">{parentIdentifier}</span>
              ) : (
                <span className="italic">{t("issueColumns.subIssue")}</span>
              )}
            </span>
          );
        }

        if (column === "updated") {
          return (
            <span key={column} className="min-w-0 truncate text-right text-[11px] font-medium text-muted-foreground">
              {activityText}
            </span>
          );
        }

        return null;
      })}
    </span>
  );
}
