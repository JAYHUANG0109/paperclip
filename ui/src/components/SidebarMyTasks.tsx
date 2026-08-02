import { useQuery } from "@tanstack/react-query";
import { NavLink } from "react-router-dom";
import { useTranslation } from "@/i18n";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { cn, issueUrl } from "../lib/utils";

/**
 * The signed-in person's own recent tasks, nested under "Tasks" in the sidebar.
 *
 * "Own" means the tasks of the agent this user is paired with, which makes the
 * list per-user by construction: two people in one company see different tasks
 * because `agents/mine` resolves to different agents. Nothing here widens what
 * anyone can read.
 *
 * Uses the same query as the agent page's "Recent Tasks" — `participantAgentId`
 * with no status filter — so the two lists agree. Filtering to open work only
 * made the sidebar disagree with the agent page, which read as "these aren't my
 * tasks".
 *
 * Hidden for an unpaired user and while empty, so the sidebar never grows a
 * permanently blank section.
 */

/** Enough to be useful, short enough to stay a sidebar and not a page. */
const MAX_TASKS = 6;

const STATUS_DOT: Record<string, string> = {
  in_progress: "bg-blue-500",
  in_review: "bg-purple-500",
  blocked: "bg-destructive",
  done: "bg-emerald-500",
  todo: "bg-muted-foreground/40",
  backlog: "bg-muted-foreground/40",
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
    queryFn: () => issuesApi.list(companyId!, { participantAgentId: agentId! }),
    enabled: Boolean(companyId && agentId),
  });

  // The rail is icon-only; a list of titles has nothing to show there.
  if (rail) return null;
  if (!companyId || !agentId) return null;
  if (!tasks || tasks.length === 0) return null;

  // Same ordering as the agent page: pinned first, then most-recently-updated.
  // Taking the API's default order instead was the whole bug — same query, same
  // agent, different slice, so the sidebar surfaced stale routine runs while
  // the agent page showed the genuinely recent work.
  const recent = [...tasks].sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });

  return (
    <div className="flex flex-col">
      {recent.slice(0, MAX_TASKS).map((task) => (
        <NavLink
          key={task.id}
          to={issueUrl(task)}
          title={task.title}
          className={({ isActive }) =>
            cn(
              // Same rhythm as SidebarNavItem — mx-2, rounded-lg, the shared
              // compact type scale — so these read as real sidebar rows rather
              // than footnotes. The extra left padding indents them under
              // "Tasks" the way a file sits under its folder.
              "flex items-center gap-2.5 mx-2 rounded-lg py-1.5 pl-8 pr-2 pointer-coarse:py-1 text-(length:--text-compact) font-medium transition-colors",
              isActive
                ? "bg-accent text-foreground"
                : "text-foreground/80 hover:bg-accent/50 hover:text-foreground",
            )
          }
        >
          <span
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              STATUS_DOT[task.status] ?? "bg-muted-foreground/40",
            )}
            aria-hidden="true"
          />
          <span className="truncate">{task.title}</span>
        </NavLink>
      ))}
      {recent.length > MAX_TASKS ? (
        <NavLink
          to="/issues"
          className="mx-2 rounded-lg py-1.5 pl-8 pr-2 pointer-coarse:py-1 text-(length:--text-compact) text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
        >
          {t("nav.myTasksSeeAll", { defaultValue: "See all tasks" })}
        </NavLink>
      ) : null}
    </div>
  );
}

export default SidebarMyTasks;
