import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarRange, CheckCircle2, Circle, ExternalLink, ListTodo, Loader2 } from "lucide-react";
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

/**
 * Per-user Asana digest on the Dashboard: TODAY and THIS WEEK. Read-only data is
 * produced by the user's own agent (their token); here a person can check a task
 * off — that's routed back through their agent to complete it in Asana, with an
 * optimistic local update so the row + progress bar respond instantly. Each task
 * has a clickable progress bar that expands a rich Asana detail panel, and the
 * row links out to the task in Asana.
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

  const toggle = useMutation({
    mutationFn: ({ gid, completed }: { gid: string; completed: boolean }) =>
      dashboardApi.completeAsanaTask(companyId, gid, completed),
    onMutate: async ({ gid, completed }) => {
      await queryClient.cancelQueries({ queryKey: DIGEST_KEY(companyId) });
      const prev = queryClient.getQueryData<AsanaDigest>(DIGEST_KEY(companyId));
      if (prev) {
        const apply = (list: AsanaDigestTask[]) =>
          (list ?? []).map((tk) => (tk.gid === gid ? { ...tk, completed } : tk));
        queryClient.setQueryData<AsanaDigest>(DIGEST_KEY(companyId), {
          ...prev,
          daily: apply(prev.daily),
          weekly: apply(prev.weekly),
        });
      }
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(DIGEST_KEY(companyId), ctx.prev);
    },
    onSettled: (res) => {
      if (res?.digest) queryClient.setQueryData(DIGEST_KEY(companyId), res.digest);
    },
  });

  const pendingGid = toggle.isPending ? toggle.variables?.gid : undefined;

  const hasAnything = !!data && !data.empty && (data.daily.length > 0 || data.weekly.length > 0);
  if (!hasAnything) return null;

  const generated = data?.generatedAt ? new Date(data.generatedAt) : null;
  const onToggle = (gid: string, completed: boolean) => toggle.mutate({ gid, completed });

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
          icon={ListTodo}
          title={t("asana.today", { defaultValue: "Today" })}
          tasks={data!.daily}
          emptyText={t("asana.noToday", { defaultValue: "Nothing due today. 🎉" })}
          onToggle={onToggle}
          pendingGid={pendingGid}
        />
        <TaskCard
          icon={CalendarRange}
          title={t("asana.thisWeek", { defaultValue: "This week" })}
          tasks={data!.weekly}
          emptyText={t("asana.noWeek", { defaultValue: "No tasks this week." })}
          onToggle={onToggle}
          pendingGid={pendingGid}
        />
      </div>
    </div>
  );
}

function TaskCard({
  icon: Icon,
  title,
  tasks,
  emptyText,
  onToggle,
  pendingGid,
}: {
  icon: typeof ListTodo;
  title: string;
  tasks: AsanaDigestTask[];
  emptyText: string;
  onToggle: (gid: string, completed: boolean) => void;
  pendingGid?: string;
}) {
  const { t } = useTranslation();
  const total = tasks.length;
  const done = tasks.filter((tk) => tk.completed).length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 px-5 pt-5 pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Icon className="h-4 w-4 text-muted-foreground" />
          {title}
        </CardTitle>
        <span className="text-xs tabular-nums text-muted-foreground">
          {t("asana.progressDone", { done, total, defaultValue: "{{done}}/{{total}} done" })}
        </span>
      </CardHeader>
      {total > 0 && (
        <div className="mx-5 mb-1 h-1 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} />
        </div>
      )}
      <CardContent className="px-5 pb-5 pt-1">
        {tasks.length === 0 ? (
          <p className="py-3 text-sm text-muted-foreground">{emptyText}</p>
        ) : (
          <ul className="divide-y divide-border">
            {tasks.map((task) => (
              <AsanaTaskRow key={task.gid} task={task} onToggle={onToggle} pending={pendingGid === task.gid} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function AsanaTaskRow({
  task,
  onToggle,
  pending,
}: {
  task: AsanaDigestTask;
  onToggle: (gid: string, completed: boolean) => void;
  pending: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const due = task.dueOn ? new Date(task.dueOn) : null;
  const prClass = task.priority ? PRIORITY_STYLE[task.priority.toLowerCase()] : undefined;

  return (
    <li className="py-2">
      <div className="flex items-center gap-2.5 text-sm">
        {/* Check-off button (routes the completion through the user's agent) */}
        <button
          type="button"
          onClick={() => onToggle(task.gid, !task.completed)}
          disabled={pending}
          aria-label={task.completed ? t("asana.markIncomplete", { defaultValue: "Mark incomplete" }) : t("asana.markComplete", { defaultValue: "Mark complete" })}
          className="shrink-0 disabled:opacity-50"
        >
          {pending ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
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
            className={cn("group min-w-0 flex-1 truncate hover:underline", task.completed && "text-muted-foreground line-through")}
          >
            {task.name}
            <ExternalLink className="ml-1 inline h-3 w-3 align-text-top text-muted-foreground/0 transition-colors group-hover:text-muted-foreground" />
          </a>
        ) : (
          <span className={cn("min-w-0 flex-1 truncate", task.completed && "text-muted-foreground line-through")}>{task.name}</span>
        )}

        {task.priority && prClass && (
          <span className={cn("shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium", prClass)}>{task.priority}</span>
        )}
        {due && (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {due.toLocaleDateString(undefined, { month: "numeric", day: "numeric" })}
          </span>
        )}
      </div>

      {/* Clickable progress bar → expands the detail panel */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={t("asana.toggleDetails", { defaultValue: "Toggle details" })}
        className="mt-1 ml-[26px] block w-[calc(100%-26px)] rounded py-1 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <span className="block h-1 overflow-hidden rounded-full bg-muted">
          <span
            className={cn("block h-full rounded-full transition-all", task.completed ? "bg-emerald-500" : "bg-primary/30")}
            style={{ width: task.completed ? "100%" : "0%" }}
          />
        </span>
      </button>

      {open && (
        <div className="ml-[26px] mt-2 space-y-2">
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
