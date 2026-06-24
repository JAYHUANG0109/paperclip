import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { CalendarDays, ChevronLeft, ChevronRight, AlertTriangle } from "lucide-react";
import { issuesApi } from "../api/issues";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useTranslation } from "@/i18n";
import { queryKeys } from "../lib/queryKeys";
import { IssueCalendar } from "../components/IssueCalendar";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { cn } from "../lib/utils";
import { createIssueDetailPath } from "../lib/issueDetailBreadcrumb";
import type { Issue } from "@paperclipai/shared";

const CALENDAR_ISSUE_LIMIT = 1000;

const PRIORITY_DOT: Record<string, string> = {
  critical: "bg-red-500",
  high: "bg-orange-500",
  medium: "bg-yellow-500",
  low: "bg-neutral-400",
};

const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const WEEKDAY_FALLBACK = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

type CalIssue = Pick<Issue, "id" | "title" | "status" | "priority" | "dueDate"> & {
  identifier?: string | null;
};

/* ---------- Issue chip (shared by week + list) ---------- */
function IssueChip({ issue }: { issue: CalIssue }) {
  const done = issue.status === "done" || issue.status === "cancelled";
  return (
    <Link
      to={createIssueDetailPath(issue.identifier ?? issue.id)}
      title={issue.title}
      className={cn(
        "flex items-center gap-1.5 rounded px-1.5 py-1 text-xs no-underline transition-colors hover:bg-accent",
        done ? "text-muted-foreground line-through" : "text-foreground",
      )}
    >
      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", PRIORITY_DOT[issue.priority] ?? "bg-neutral-400")} />
      <span className="truncate">{issue.title}</span>
    </Link>
  );
}

/* ---------- Week view ---------- */
function WeekView({ issues }: { issues: CalIssue[] }) {
  const { t } = useTranslation();
  const [cursor, setCursor] = useState(() => {
    const now = new Date();
    const s = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    s.setDate(s.getDate() - s.getDay()); // Sunday
    return s;
  });

  const byDay = useMemo(() => {
    const m = new Map<string, CalIssue[]>();
    for (const i of issues) {
      if (!i.dueDate) continue;
      const k = i.dueDate.slice(0, 10);
      (m.get(k) ?? m.set(k, []).get(k)!).push(i);
    }
    return m;
  }, [issues]);

  const days = useMemo(() => {
    return Array.from({ length: 7 }, (_, idx) => {
      const d = new Date(cursor);
      d.setDate(cursor.getDate() + idx);
      return d;
    });
  }, [cursor]);

  const todayKey = ymd(new Date());
  const rangeLabel = `${ymd(days[0]!)} – ${ymd(days[6]!)}`;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold tabular-nums">{rangeLabel}</h2>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => { const n = new Date(cursor); n.setDate(cursor.getDate() - 7); setCursor(n); }}
            className="inline-flex h-7 w-7 items-center justify-center rounded hover:bg-accent/50 text-muted-foreground hover:text-foreground transition-colors"
            aria-label={t("calendar.prevWeek", { defaultValue: "Previous week" })}
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => { const now = new Date(); const s = new Date(now.getFullYear(), now.getMonth(), now.getDate()); s.setDate(s.getDate() - s.getDay()); setCursor(s); }}
            className="rounded px-2 py-1 text-xs font-medium hover:bg-accent/50 text-muted-foreground hover:text-foreground transition-colors"
          >
            {t("calendar.today", { defaultValue: "Today" })}
          </button>
          <button
            type="button"
            onClick={() => { const n = new Date(cursor); n.setDate(cursor.getDate() + 7); setCursor(n); }}
            className="inline-flex h-7 w-7 items-center justify-center rounded hover:bg-accent/50 text-muted-foreground hover:text-foreground transition-colors"
            aria-label={t("calendar.nextWeek", { defaultValue: "Next week" })}
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div className="grid grid-cols-7 gap-px overflow-hidden rounded-lg border border-border bg-border">
        {days.map((day, idx) => {
          const key = ymd(day);
          const isToday = key === todayKey;
          const dayIssues = byDay.get(key) ?? [];
          return (
            <div key={key} className="min-h-[260px] bg-background">
              <div className={cn("border-b border-border px-2 py-1.5 text-center", isToday && "bg-primary/10")}>
                <div className="text-[11px] text-muted-foreground">
                  {t(`calendar.weekday.${WEEKDAY_KEYS[idx]}`, { defaultValue: WEEKDAY_FALLBACK[idx] })}
                </div>
                <div className={cn("text-sm tabular-nums", isToday ? "font-semibold text-primary" : "text-foreground")}>
                  {day.getDate()}
                </div>
              </div>
              <div className="space-y-0.5 p-1">
                {dayIssues.map((issue) => <IssueChip key={issue.id} issue={issue} />)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------- List / agenda view ---------- */
function AgendaList({ issues }: { issues: CalIssue[] }) {
  const { t } = useTranslation();
  const todayKey = ymd(new Date());

  const { overdue, groups } = useMemo(() => {
    const open = (i: CalIssue) => i.status !== "done" && i.status !== "cancelled";
    const sorted = [...issues]
      .filter((i) => i.dueDate)
      .sort((a, b) => (a.dueDate! < b.dueDate! ? -1 : a.dueDate! > b.dueDate! ? 1 : 0));
    const overdueList = sorted.filter((i) => i.dueDate!.slice(0, 10) < todayKey && open(i));
    const rest = sorted.filter((i) => !(i.dueDate!.slice(0, 10) < todayKey && open(i)));
    const grouped = new Map<string, CalIssue[]>();
    for (const i of rest) {
      const k = i.dueDate!.slice(0, 10);
      (grouped.get(k) ?? grouped.set(k, []).get(k)!).push(i);
    }
    return { overdue: overdueList, groups: Array.from(grouped.entries()) };
  }, [issues, todayKey]);

  return (
    <div className="space-y-5">
      {overdue.length > 0 && (
        <div className="space-y-1">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-red-600 dark:text-red-400">
            <AlertTriangle className="h-3.5 w-3.5" />
            {t("calendar.overdue", { defaultValue: "Overdue" })} ({overdue.length})
          </div>
          <div className="rounded-lg border border-red-500/30">
            {overdue.map((issue) => (
              <div key={issue.id} className="flex items-center justify-between border-b border-border/50 px-2 py-1.5 last:border-0">
                <IssueChip issue={issue} />
                <span className="shrink-0 text-[11px] tabular-nums text-red-600 dark:text-red-400">{issue.dueDate}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {groups.map(([date, dayIssues]) => (
        <div key={date} className="space-y-1">
          <div className={cn("text-xs font-semibold", date === todayKey ? "text-primary" : "text-muted-foreground")}>
            {date === todayKey ? t("calendar.todaySection", { defaultValue: "Today" }) : date}
            <span className="ml-1 font-normal text-muted-foreground/60">({dayIssues.length})</span>
          </div>
          <div className="rounded-lg border border-border">
            {dayIssues.map((issue) => (
              <div key={issue.id} className="flex items-center justify-between border-b border-border/50 px-2 py-1.5 last:border-0">
                <IssueChip issue={issue} />
                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{issue.status}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Top-level personal calendar with Month / Week / List tabs.
 * The issues list is scoped server-side (operators see their own + their joined
 * agents' work; admins see all), so this shows "my + my agents' deadlines".
 */
export function MyCalendar() {
  const { t } = useTranslation();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [tab, setTab] = useState("month");

  useEffect(() => {
    setBreadcrumbs([{ label: t("nav.calendar", { defaultValue: "Calendar" }) }]);
  }, [setBreadcrumbs, t]);

  const { data: issues } = useQuery({
    queryKey: [...queryKeys.issues.list(selectedCompanyId ?? "__none__"), "calendar"],
    queryFn: () => issuesApi.list(selectedCompanyId!, { limit: CALENDAR_ISSUE_LIMIT }),
    enabled: !!selectedCompanyId,
  });

  const dated = useMemo(() => (issues ?? []).filter((i: Issue) => Boolean(i.dueDate)), [issues]);

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <CalendarDays className="h-5 w-5 text-muted-foreground" />
            <h1 className="text-lg font-semibold">{t("calendar.myCalendar", { defaultValue: "My Calendar" })}</h1>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("calendar.myCalendarHint", { defaultValue: "Deadlines of issues assigned to you and your agents." })}
          </p>
        </div>
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="month">{t("calendar.tab.month", { defaultValue: "Month" })}</TabsTrigger>
            <TabsTrigger value="week">{t("calendar.tab.week", { defaultValue: "Week" })}</TabsTrigger>
            <TabsTrigger value="list">{t("calendar.tab.list", { defaultValue: "List" })}</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {dated.length === 0 && (
        <div className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
          {t("calendar.empty.message", { defaultValue: "No issues have a due date yet. Set a due date on an issue to see it here." })}
        </div>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsContent value="month" className="mt-0">
          <IssueCalendar issues={dated} />
        </TabsContent>
        <TabsContent value="week" className="mt-0">
          <WeekView issues={dated} />
        </TabsContent>
        <TabsContent value="list" className="mt-0">
          {dated.length > 0 ? (
            <AgendaList issues={dated} />
          ) : (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {t("calendar.empty.message", { defaultValue: "No issues have a due date yet." })}
            </p>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
