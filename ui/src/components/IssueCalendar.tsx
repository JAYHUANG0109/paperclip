import { useMemo, useState } from "react";
import { Link } from "@/lib/router";
import { ChevronLeft, ChevronRight, Flag } from "lucide-react";
import { useTranslation } from "@/i18n";
import type { Issue } from "@paperclipai/shared";
import { cn } from "../lib/utils";
import { createIssueDetailPath } from "../lib/issueDetailBreadcrumb";

const PRIORITY_DOT: Record<string, string> = {
  critical: "bg-red-500",
  high: "bg-orange-500",
  medium: "bg-yellow-500",
  low: "bg-neutral-400",
};

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

type CalendarIssue = Pick<Issue, "id" | "title" | "status" | "priority" | "dueDate"> & {
  identifier?: string | null;
};

export interface ProjectCalendarEvent {
  id: string;
  name: string;
  date: string; // YYYY-MM-DD (project target date)
  urlKey?: string | null;
}

export interface AsanaCalendarEvent {
  gid: string;
  name: string;
  date: string; // YYYY-MM-DD (Asana due date)
  permalinkUrl?: string | null;
  completed?: boolean;
}

export interface GoogleCalendarEvent {
  id: string;
  title: string;
  date: string; // YYYY-MM-DD (local date key)
  htmlLink?: string | null;
  allDay?: boolean;
  calendarName?: string | null;
}

/**
 * Month-grid calendar that plots issues on their dueDate.
 * Reused by the top-level "My Calendar" page and the per-project Issues calendar view.
 * Optionally overlays project target dates (projectEvents) as distinct chips.
 */
export function IssueCalendar({
  issues,
  projectEvents = [],
  asanaEvents = [],
  googleEvents = [],
}: {
  issues: CalendarIssue[];
  projectEvents?: ProjectCalendarEvent[];
  asanaEvents?: AsanaCalendarEvent[];
  googleEvents?: GoogleCalendarEvent[];
}) {
  const { t } = useTranslation();
  const [cursor, setCursor] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });

  const issuesByDay = useMemo(() => {
    const map = new Map<string, CalendarIssue[]>();
    for (const issue of issues) {
      if (!issue.dueDate) continue;
      const key = issue.dueDate.slice(0, 10);
      const list = map.get(key);
      if (list) list.push(issue);
      else map.set(key, [issue]);
    }
    return map;
  }, [issues]);

  const projectsByDay = useMemo(() => {
    const map = new Map<string, ProjectCalendarEvent[]>();
    for (const ev of projectEvents) {
      if (!ev.date) continue;
      const key = ev.date.slice(0, 10);
      const list = map.get(key);
      if (list) list.push(ev);
      else map.set(key, [ev]);
    }
    return map;
  }, [projectEvents]);

  const asanaByDay = useMemo(() => {
    const map = new Map<string, AsanaCalendarEvent[]>();
    for (const ev of asanaEvents) {
      if (!ev.date) continue;
      const key = ev.date.slice(0, 10);
      const list = map.get(key);
      if (list) list.push(ev);
      else map.set(key, [ev]);
    }
    return map;
  }, [asanaEvents]);

  const googleByDay = useMemo(() => {
    const map = new Map<string, GoogleCalendarEvent[]>();
    for (const ev of googleEvents) {
      if (!ev.date) continue;
      const key = ev.date.slice(0, 10);
      const list = map.get(key);
      if (list) list.push(ev);
      else map.set(key, [ev]);
    }
    return map;
  }, [googleEvents]);

  const { weeks, monthLabel } = useMemo(() => {
    const monthStart = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    // Sunday-start grid.
    const gridStart = new Date(monthStart);
    gridStart.setDate(monthStart.getDate() - monthStart.getDay());
    const days: Date[] = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(gridStart);
      d.setDate(gridStart.getDate() + i);
      days.push(d);
    }
    const weeksOut: Date[][] = [];
    for (let i = 0; i < 6; i++) weeksOut.push(days.slice(i * 7, i * 7 + 7));
    const label = `${cursor.getFullYear()}/${String(cursor.getMonth() + 1).padStart(2, "0")}`;
    return { weeks: weeksOut, monthLabel: label };
  }, [cursor]);

  const todayKey = ymd(new Date());
  const weekdayKeys = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const weekdayFallback = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold tabular-nums">{monthLabel}</h2>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}
            className="inline-flex h-7 w-7 items-center justify-center rounded hover:bg-accent/50 text-muted-foreground hover:text-foreground transition-colors"
            aria-label={t("calendar.prevMonth", { defaultValue: "Previous month" })}
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => {
              const now = new Date();
              setCursor(new Date(now.getFullYear(), now.getMonth(), 1));
            }}
            className="rounded px-2 py-1 text-xs font-medium hover:bg-accent/50 text-muted-foreground hover:text-foreground transition-colors"
          >
            {t("calendar.today", { defaultValue: "Today" })}
          </button>
          <button
            type="button"
            onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}
            className="inline-flex h-7 w-7 items-center justify-center rounded hover:bg-accent/50 text-muted-foreground hover:text-foreground transition-colors"
            aria-label={t("calendar.nextMonth", { defaultValue: "Next month" })}
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-px overflow-hidden rounded-lg border border-border bg-border">
        {weekdayKeys.map((key, i) => (
          <div
            key={key}
            className="bg-muted/40 px-2 py-1 text-center text-[11px] font-medium text-muted-foreground"
          >
            {t(`calendar.weekday.${key}`, { defaultValue: weekdayFallback[i] })}
          </div>
        ))}
        {weeks.flat().map((day) => {
          const key = ymd(day);
          const inMonth = day.getMonth() === cursor.getMonth();
          const isToday = key === todayKey;
          const dayIssues = issuesByDay.get(key) ?? [];
          const dayProjects = projectsByDay.get(key) ?? [];
          const dayAsana = asanaByDay.get(key) ?? [];
          const dayGoogle = googleByDay.get(key) ?? [];
          return (
            <div
              key={key}
              className={cn(
                "min-h-[88px] bg-background p-1.5 align-top",
                !inMonth && "bg-muted/20 text-muted-foreground/50",
              )}
            >
              <div
                className={cn(
                  "mb-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[11px] tabular-nums",
                  isToday ? "bg-primary text-primary-foreground font-semibold" : "text-muted-foreground",
                )}
              >
                {day.getDate()}
              </div>
              <div className="space-y-0.5">
                {dayProjects.map((proj) => (
                  <Link
                    key={proj.id}
                    to={`/projects/${proj.urlKey ?? proj.id}/overview`}
                    title={proj.name}
                    className="flex items-center gap-1 rounded bg-violet-500/15 px-1 py-0.5 text-[11px] text-violet-700 no-underline transition-colors hover:bg-violet-500/25 dark:text-violet-300"
                  >
                    <Flag className="h-3 w-3 shrink-0" />
                    <span className="truncate font-medium">{proj.name}</span>
                  </Link>
                ))}
                {dayIssues.slice(0, 4).map((issue) => (
                  <Link
                    key={issue.id}
                    to={createIssueDetailPath(issue.identifier ?? issue.id)}
                    title={issue.title}
                    className={cn(
                      "flex items-center gap-1 rounded px-1 py-0.5 text-[11px] no-underline transition-colors hover:bg-accent",
                      issue.status === "done" || issue.status === "cancelled"
                        ? "text-muted-foreground line-through"
                        : "text-foreground",
                    )}
                  >
                    <span
                      className={cn(
                        "h-1.5 w-1.5 shrink-0 rounded-full",
                        PRIORITY_DOT[issue.priority] ?? "bg-neutral-400",
                      )}
                    />
                    <span className="truncate">{issue.title}</span>
                  </Link>
                ))}
                {dayIssues.length > 4 && (
                  <div className="px-1 text-[10px] text-muted-foreground">
                    {t("calendar.moreCount", {
                      defaultValue: "+{{count}} more",
                      count: dayIssues.length - 4,
                    })}
                  </div>
                )}
                {dayAsana.slice(0, 3).map((ev) => {
                  const Chip = ev.permalinkUrl ? "a" : "div";
                  return (
                    <Chip
                      key={ev.gid}
                      {...(ev.permalinkUrl ? { href: ev.permalinkUrl, target: "_blank", rel: "noreferrer" } : {})}
                      title={ev.name}
                      className={cn(
                        "flex items-center gap-1 rounded bg-sky-500/15 px-1 py-0.5 text-[11px] text-sky-700 no-underline transition-colors hover:bg-sky-500/25 dark:text-sky-300",
                        ev.completed && "line-through opacity-70",
                      )}
                    >
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-sky-500" />
                      <span className="truncate">{ev.name}</span>
                    </Chip>
                  );
                })}
                {dayAsana.length > 3 && (
                  <div className="px-1 text-[10px] text-sky-600/80 dark:text-sky-400/80">
                    {t("calendar.moreCount", { defaultValue: "+{{count}} more", count: dayAsana.length - 3 })}
                  </div>
                )}
                {dayGoogle.slice(0, 3).map((ev) => {
                  const Chip = ev.htmlLink ? "a" : "div";
                  return (
                    <Chip
                      key={ev.id}
                      {...(ev.htmlLink ? { href: ev.htmlLink, target: "_blank", rel: "noreferrer" } : {})}
                      title={ev.calendarName ? `${ev.title} · ${ev.calendarName}` : ev.title}
                      className="flex items-center gap-1 rounded bg-emerald-500/15 px-1 py-0.5 text-[11px] text-emerald-700 no-underline transition-colors hover:bg-emerald-500/25 dark:text-emerald-300"
                    >
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
                      <span className="truncate">{ev.title}</span>
                    </Chip>
                  );
                })}
                {dayGoogle.length > 3 && (
                  <div className="px-1 text-[10px] text-emerald-600/80 dark:text-emerald-400/80">
                    {t("calendar.moreCount", { defaultValue: "+{{count}} more", count: dayGoogle.length - 3 })}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
