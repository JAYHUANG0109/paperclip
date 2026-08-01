import { useQuery } from "@tanstack/react-query";
import { NavLink } from "react-router-dom";
import { useTranslation } from "@/i18n";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { cn, issueUrl, SIDEBAR_RAIL_HIDDEN_LABEL } from "../lib/utils";

/**
 * The signed-in person's own open tasks, listed in the sidebar.
 *
 * "Own" means assigned to the agent this user is paired with, which makes the
 * list per-user by construction: two people looking at the same company see
 * different tasks, because they are mapped to different agents. Nothing here
 * widens what anyone can read — the list route already scopes by company and
 * the agent id is the user's own.
 *
 * Hidden entirely for an unpaired user, and while empty, so the sidebar does
 * not grow a permanently blank section.
 */

/** Open work only. A finished task is not something to keep staring at. */
const ACTIVE_STATUSES = "todo,in_progress,in_review,blocked";

/** Enough to be useful, short enough to stay a sidebar and not a page. */
const MAX_TASKS = 6;

const STATUS_DOT: Record<string, string> = {
  in_progress: "bg-blue-500",
  in_review: "bg-purple-500",
  blocked: "bg-destructive",
  todo: "bg-muted-foreground/40",
};

export function SidebarMyTasks({
  companyId,
  agentId,
  rail,
}: {
  companyId: string | null | undefined;
  agentId: string | null | undefined;
  rail?: boolean;
}) {
  const { t } = useTranslation();

  const { data: tasks } = useQuery({
    queryKey: queryKeys.issues.listByAssignee(companyId!, agentId!),
    queryFn: () =>
      issuesApi.list(companyId!, {
        assigneeAgentId: agentId!,
        status: ACTIVE_STATUSES,
        limit: MAX_TASKS,
      }),
    enabled: Boolean(companyId && agentId),
  });

  // The rail is icon-only; a list of titles has nothing to show there.
  if (rail) return null;
  if (!companyId || !agentId) return null;
  if (!tasks || tasks.length === 0) return null;

  return (
    <div className="mt-0.5 flex flex-col gap-px pl-7 pr-1">
      {tasks.slice(0, MAX_TASKS).map((task) => (
        <NavLink
          key={task.id}
          to={issueUrl(task)}
          className={({ isActive }) =>
            cn(
              "group flex items-center gap-2 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground",
              isActive && "bg-accent/60 text-foreground",
            )
          }
          title={task.title}
        >
          <span
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              STATUS_DOT[task.status] ?? "bg-muted-foreground/40",
            )}
          />
          <span className={cn("truncate", rail ? SIDEBAR_RAIL_HIDDEN_LABEL : undefined)}>
            {task.title}
          </span>
        </NavLink>
      ))}
      {tasks.length >= MAX_TASKS ? (
        <NavLink
          to="/issues"
          className="rounded-md px-2 py-1 text-xs text-muted-foreground/70 transition-colors hover:bg-accent/50 hover:text-foreground"
        >
          {t("nav.myTasksSeeAll", { defaultValue: "See all tasks" })}
        </NavLink>
      ) : null}
    </div>
  );
}

export default SidebarMyTasks;
