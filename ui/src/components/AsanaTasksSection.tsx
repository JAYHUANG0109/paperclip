import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarRange, CheckCircle2, ChevronRight, Circle, ExternalLink, ListTodo, Loader2, MessageSquare, XCircle } from "lucide-react";
import { useTranslation } from "@/i18n";
import { dashboardApi, type AsanaDigest, type AsanaDigestTask } from "../api/dashboard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "../lib/utils";

const DIGEST_KEY = (companyId: string) => ["asana-digest", companyId];

const PRIORITY_STYLE: Record<string, string> = {
  high: "text-red-500 border-red-500/40",
  medium: "text-amber-500 border-amber-500/40",
  low: "text-muted-foreground border-border",
};

// Per-row check-off lifecycle: click → "pending" (agent working, crossed off) →
// on confirmed Asana success the row "leaves" (fades out) then is removed; on
// failure it flips to "error" (red) and stays so the user can retry.
type RowPhase = "pending" | "leaving" | "error";

/**
 * Per-user Asana digest on the Dashboard: TODAY and THIS WEEK. Read-only data is
 * produced by the user's own agent (their token). Checking a task off is written
 * to Asana server-direct with the user's own token (no agent LLM run): the row
 * crosses off while pending, disappears once Asana confirms, or turns red on
 * failure. Titles link out to Asana; expanding a row lazily pulls that task's
 * comments (server-direct, on-demand — never in the bulk digest).
 */
export function AsanaTasksSection({ companyId }: { companyId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: DIGEST_KEY(companyId),
    queryFn: () => dashboardApi.asanaDigest(companyId),
    enabled: !!companyId,
    staleTime: 60_000,
  });

  // Row lifecycle state, keyed by task gid. `removed` rows are filtered out.
  const [phase, setPhase] = useState<Record<string, RowPhase>>({});
  const [removed, setRemoved] = useState<Set<string>>(new Set());

  const setRowPhase = (gid: string, next: RowPhase | null) =>
    setPhase((prev) => {
      const copy = { ...prev };
      if (next === null) delete copy[gid];
      else copy[gid] = next;
      return copy;
    });

  const onToggle = async (gid: string, completed: boolean) => {
    setRowPhase(gid, "pending");
    try {
      const res = await dashboardApi.completeAsanaTask(companyId, gid, completed);
      if (res.ok && res.confirmed) {
        if (res.digest) queryClient.setQueryData<AsanaDigest>(DIGEST_KEY(companyId), res.digest);
        // Success → fade the row out, then drop it from the list.
        setRowPhase(gid, "leaving");
        window.setTimeout(() => {
          setRemoved((prev) => new Set(prev).add(gid));
          setRowPhase(gid, null);
        }, 400);
      } else {
        setRowPhase(gid, "error");
      }
    } catch {
      setRowPhase(gid, "error");
    }
  };

  const visible = (list: AsanaDigestTask[]) => (list ?? []).filter((tk) => !removed.has(tk.gid));

  const hasAnything =
    !!data && !data.empty && (visible(data.daily).length > 0 || visible(data.weekly).length > 0);
  if (!hasAnything) return null;

  const generated = data?.generatedAt ? new Date(data.generatedAt) : null;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground/80">
          <ListTodo className="h-4 w-4 text-muted-foreground" />
          {t("asana.myTasks", { defaultValue: "My tasks (Asana)" })}
          {data?.sample && (
            <span className="rounded-full border border-amber-500/40 px-1.5 py-0.5 text-[10px] font-medium text-amber-500">
              {t("asana.sample", { defaultValue: "Sample" })}
            </span>
          )}
        </h2>
        {generated && (
          <span className="text-[11px] text-muted-foreground">
            {t("asana.updatedAt", { defaultValue: "Updated" })} {generated.toLocaleString()}
          </span>
        )}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <TaskCard
          companyId={companyId}
          icon={ListTodo}
          title={t("asana.today", { defaultValue: "Today" })}
          tasks={visible(data!.daily)}
          emptyText={t("asana.noToday", { defaultValue: "Nothing due today. 🎉" })}
          onToggle={onToggle}
          phase={phase}
        />
        <TaskCard
          companyId={companyId}
          icon={CalendarRange}
          title={t("asana.thisWeek", { defaultValue: "This week" })}
          tasks={visible(data!.weekly)}
          emptyText={t("asana.noWeek", { defaultValue: "No tasks this week." })}
          onToggle={onToggle}
          phase={phase}
        />
      </div>
    </div>
  );
}

function TaskCard({
  companyId,
  icon: Icon,
  title,
  tasks,
  emptyText,
  onToggle,
  phase,
}: {
  companyId: string;
  icon: typeof ListTodo;
  title: string;
  tasks: AsanaDigestTask[];
  emptyText: string;
  onToggle: (gid: string, completed: boolean) => void;
  phase: Record<string, RowPhase>;
}) {
  const { t } = useTranslation();
  const total = tasks.length;
  return (
    <Card className="min-w-0 overflow-hidden">
      <CardHeader className="flex flex-row items-center justify-between gap-2 px-5 pt-5 pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Icon className="h-4 w-4 text-muted-foreground" />
          {title}
        </CardTitle>
        <span className="text-xs tabular-nums text-muted-foreground">
          {t("asana.openCount", { count: total, defaultValue: "{{count}} open" })}
        </span>
      </CardHeader>
      <CardContent className="px-5 pb-5 pt-1">
        {tasks.length === 0 ? (
          <p className="py-3 text-sm text-muted-foreground">{emptyText}</p>
        ) : (
          <ul className="divide-y divide-border">
            {tasks.map((task) => (
              <AsanaTaskRow
                key={task.gid}
                companyId={companyId}
                task={task}
                onToggle={onToggle}
                phase={phase[task.gid]}
              />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function AsanaTaskRow({
  companyId,
  task,
  onToggle,
  phase,
}: {
  companyId: string;
  task: AsanaDigestTask;
  onToggle: (gid: string, completed: boolean) => void;
  phase?: RowPhase;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [everOpened, setEverOpened] = useState(false);
  const due = task.dueOn ? new Date(task.dueOn) : null;
  const prClass = task.priority ? PRIORITY_STYLE[task.priority.toLowerCase()] : undefined;

  const pending = phase === "pending";
  const leaving = phase === "leaving";
  const errored = phase === "error";
  // Crossed off while the completion is in flight or done (pending/leaving);
  // stays normal on error so the user can retry.
  const struck = pending || leaving || task.completed;

  // On-demand comments: fetch only after the row has been opened at least once.
  const comments = useQuery({
    queryKey: ["asana-task-comments", companyId, task.gid],
    queryFn: () => dashboardApi.asanaTaskComments(companyId, task.gid),
    enabled: everOpened,
    staleTime: 60_000,
  });
  const commentCount = comments.data?.count;

  useEffect(() => {
    if (open) setEverOpened(true);
  }, [open]);

  return (
    <li
      className={cn(
        "py-2 transition-all duration-300",
        leaving && "pointer-events-none -translate-x-1 opacity-0",
      )}
    >
      <div className="flex items-center gap-2.5 text-sm">
        {/* Check-off button → writes to Asana server-direct with the user's token */}
        <button
          type="button"
          onClick={() => onToggle(task.gid, !task.completed)}
          disabled={pending || leaving}
          aria-label={
            errored
              ? t("asana.retryComplete", { defaultValue: "Couldn't update — retry" })
              : task.completed
                ? t("asana.markIncomplete", { defaultValue: "Mark incomplete" })
                : t("asana.markComplete", { defaultValue: "Mark complete" })
          }
          title={errored ? t("asana.updateFailed", { defaultValue: "Couldn't update in Asana — click to retry" }) : undefined}
          className="shrink-0 disabled:opacity-70"
        >
          {pending || leaving ? (
            <Loader2 className="h-4 w-4 animate-spin text-emerald-500" />
          ) : errored ? (
            <XCircle className="h-4 w-4 text-red-500" />
          ) : task.completed ? (
            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
          ) : (
            <Circle className="h-4 w-4 text-muted-foreground/50 transition-colors hover:text-emerald-500" />
          )}
        </button>

        {/* Name → opens the task in Asana */}
        {task.permalinkUrl ? (
          <a
            href={task.permalinkUrl}
            target="_blank"
            rel="noreferrer"
            className={cn(
              "group min-w-0 flex-1 truncate hover:underline",
              struck && "text-muted-foreground line-through",
              errored && "text-red-500",
            )}
          >
            {task.name}
            <ExternalLink className="ml-1 inline h-3 w-3 align-text-top text-muted-foreground/0 transition-colors group-hover:text-muted-foreground" />
          </a>
        ) : (
          <span className={cn("min-w-0 flex-1 truncate", struck && "text-muted-foreground line-through", errored && "text-red-500")}>
            {task.name}
          </span>
        )}

        {errored && (
          <span className="shrink-0 text-[11px] font-medium text-red-500">
            {t("asana.updateFailedShort", { defaultValue: "Failed" })}
          </span>
        )}
        {task.priority && prClass && (
          <span className={cn("shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium", prClass)}>{task.priority}</span>
        )}
        {due && (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {due.toLocaleDateString(undefined, { month: "numeric", day: "numeric" })}
          </span>
        )}
        {/* Expand → lazily loads this task's comments */}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={t("asana.toggleDetails", { defaultValue: "Toggle details" })}
          className="flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          {typeof commentCount === "number" && commentCount > 0 && (
            <span className="flex items-center gap-0.5 text-[11px] tabular-nums">
              <MessageSquare className="h-3 w-3" />
              {commentCount}
            </span>
          )}
          <ChevronRight className={cn("h-4 w-4 transition-transform", open && "rotate-90")} />
        </button>
      </div>

      {open && (
        <div className="ml-[26px] mt-2 space-y-3">
          {task.notes && (
            <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">{task.notes}</p>
          )}
          <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-xs">
            <DetailRow label={t("asana.detailStatus", { defaultValue: "Status" })} value={task.completed ? t("asana.statusDone", { defaultValue: "Completed" }) : t("asana.statusOpen", { defaultValue: "Open" })} />
            {task.projectName && <DetailRow label={t("asana.detailProject", { defaultValue: "Project" })} value={task.projectName} />}
            {task.priority && <DetailRow label={t("asana.detailPriority", { defaultValue: "Priority" })} value={task.priority} />}
            {due && <DetailRow label={t("asana.detailDue", { defaultValue: "Due" })} value={due.toLocaleDateString()} />}
            {task.permalinkUrl && (
              <DetailRow
                label={t("asana.detailLink", { defaultValue: "Link" })}
                value={
                  <a href={task.permalinkUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                    {t("asana.openInAsana", { defaultValue: "Open in Asana" })}
                  </a>
                }
              />
            )}
          </dl>

          {/* Comments (loaded on demand, server-direct) */}
          <div className="space-y-1.5">
            <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              <MessageSquare className="h-3 w-3" />
              {t("asana.comments", { defaultValue: "Comments" })}
              {typeof commentCount === "number" && <span className="tabular-nums">· {commentCount}</span>}
            </p>
            {comments.isLoading ? (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                {t("asana.loadingComments", { defaultValue: "Loading comments…" })}
              </p>
            ) : comments.isError ? (
              <p className="text-xs text-red-500">{t("asana.commentsError", { defaultValue: "Couldn't load comments." })}</p>
            ) : (comments.data?.comments.length ?? 0) === 0 ? (
              <p className="text-xs text-muted-foreground">{t("asana.noComments", { defaultValue: "No comments." })}</p>
            ) : (
              <ul className="space-y-2">
                {comments.data!.comments.map((c) => (
                  <li key={c.id} className="rounded-md border border-border/60 bg-muted/30 px-2.5 py-1.5">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-xs font-medium text-foreground">{c.author ?? t("asana.commentAuthorUnknown", { defaultValue: "Someone" })}</span>
                      {c.createdAt && (
                        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">{new Date(c.createdAt).toLocaleDateString()}</span>
                      )}
                    </div>
                    <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">{c.text}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-foreground">{value}</dd>
    </>
  );
}
