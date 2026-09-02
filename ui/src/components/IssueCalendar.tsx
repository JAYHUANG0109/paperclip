import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useTranslation } from "@/i18n";
import type { Issue } from "@paperclipai/shared";
import { cn } from "../lib/utils";
import { createIssueDetailPath } from "../lib/issueDetailBreadcrumb";
import {
  CalendarDayDetail,
  CalendarEntryChip,
  type CalendarDayEntry,
} from "./CalendarDayDetail";

/** How many entries a month cell previews before collapsing the rest into "+N more". */
const MONTH_PREVIEW_LIMIT = 4;

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** "09:30" for a timed event; null for all-day ones, which need no time column. */
export function eventTimeLabel(start?: string | null, allDay?: boolean): string | null {
  if (allDay || !start) return null;
  // All-day events arrive as a bare YYYY-MM-DD; only RFC3339 carries a clock.
  if (!start.includes("T")) return null;
  const date = new Date(start);
  if (Number.isNaN(date.getTime())) return null;
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
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
  resourceSubtype?: string | null; // default_task | milestone | approval
}

export interface GoogleCalendarEvent {
  id: string;
  title: string;
  date: string; // YYYY-MM-DD (local date key)
  htmlLink?: string | null;
  allDay?: boolean;
  calendarName?: string | null;
  /** RFC3339 start, or YYYY-MM-DD when all-day. Drives the chip's time label. */
  start?: string | null;
}

/**
 * Month-grid calendar that plots issues on their dueDate.
 * Reused by the top-level "My Calendar" page and the per-project Issues calendar view.
 * Optionally overlays project target dates, Asana tasks, and Google events.
 *
 * A day cell shows a preview; clicking anywhere in the cell that is not an item
 * opens the full day (see CalendarDayDetail), which is the only place long
 * titles are readable in full.
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
  const [openDay, setOpenDay] = useState<string | null>(null);

  // One normalised list per day, built from every source, so the grid and the
  // day dialog can never disagree about what is on a date.
  const entriesByDay = useMemo(() => {
    const map = new Map<string, CalendarDayEntry[]>();
    const push = (date: string | null | undefined, entry: CalendarDayEntry) => {
      if (!date) return;
      const key = date.slice(0, 10);
      const list = map.get(key);
      if (list) list.push(entry);
      else map.set(key, [entry]);
    };
    for (const proj of projectEvents) {
      push(proj.date, {
        id: `project-${proj.id}`,
        kind: "project",
        title: proj.name,
        to: `/projects/${proj.urlKey ?? proj.id}/overview`,
      });
    }
    for (const issue of issues) {
      push(issue.dueDate, {
        id: `issue-${issue.id}`,
        kind: "issue",
        title: issue.title,
        to: createIssueDetailPath(issue.identifier ?? issue.id),
        done: issue.status === "done" || issue.status === "cancelled",
        priority: issue.priority,
        meta: issue.status,
      });
    }
    for (const ev of asanaEvents) {
      push(ev.date, {
        id: `asana-${ev.gid}`,
        kind: "asana",
        title: ev.name,
        href: ev.permalinkUrl ?? null,
        done: ev.completed,
        resourceSubtype: ev.resourceSubtype,
      });
    }
    for (const ev of googleEvents) {
      push(ev.date, {
        id: `gcal-${ev.id}`,
        kind: "google",
        title: ev.title,
        href: ev.htmlLink ?? null,
        timeLabel: eventTimeLabel(ev.start, ev.allDay),
        meta: ev.calendarName ?? null,
      });
    }
    return map;
  }, [issues, projectEvents, asanaEvents, googleEvents]);

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
        <h2 className="text-base font-semibold tabular-nums">{monthLabel}</h2>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}
            className="inline-flex h-8 w-8 items-center justify-center rounded hover:bg-accent/50 text-muted-foreground hover:text-foreground transition-colors"
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
            className="inline-flex h-8 w-8 items-center justify-center rounded hover:bg-accent/50 text-muted-foreground hover:text-foreground transition-colors"
            aria-label={t("calendar.nextMonth", { defaultValue: "Next month" })}
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Phones can't fit 7 legible columns; scroll horizontally at a readable
          width rather than clipping every day's events. */}
      <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <div className="grid min-w-[720px] grid-cols-7 gap-px overflow-hidden rounded-lg border border-border bg-border sm:min-w-0">
        {weekdayKeys.map((key, i) => (
          <div
            key={key}
            className="bg-muted/40 px-2 py-1.5 text-center text-xs font-medium text-muted-foreground"
          >
            {t(`calendar.weekday.${key}`, { defaultValue: weekdayFallback[i] })}
          </div>
        ))}
        {weeks.flat().map((day) => {
          const key = ymd(day);
          const inMonth = day.getMonth() === cursor.getMonth();
          const isToday = key === todayKey;
          const entries = entriesByDay.get(key) ?? [];
          const overflow = entries.length - MONTH_PREVIEW_LIMIT;
          return (
            <div
              key={key}
              className={cn(
                // Grows with the viewport: a month on a 27" display should not be
                // the same size as one on a laptop.
                "relative min-h-[120px] bg-background transition-colors sm:min-h-[140px] xl:min-h-[164px] 2xl:min-h-[188px]",
                inMonth ? "hover:bg-accent/30" : "bg-muted/20 text-muted-foreground/50",
              )}
            >
              {/* Full-bleed hit target: clicking the BOX (not an item) opens the
                  day. Sitting behind the content — rather than wrapping it —
                  keeps links out of a nested-interactive trap and needs no
                  stopPropagation on every chip. */}
              <button
                type="button"
                onClick={() => setOpenDay(key)}
                className="absolute inset-0 z-0 h-full w-full cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                <span className="sr-only">
                  {t("calendar.day.open", { defaultValue: "Open {{date}}", date: key })}
                </span>
              </button>
              <div className="pointer-events-none relative z-10 flex flex-col gap-1 p-2">
                <div
                  className={cn(
                    "inline-flex h-6 min-w-6 w-fit items-center justify-center rounded-full px-1.5 text-xs tabular-nums",
                    isToday
                      ? "bg-primary text-primary-foreground font-semibold"
                      : "text-muted-foreground",
                  )}
                >
                  {day.getDate()}
                </div>
                <div className="space-y-1">
                  {entries.slice(0, MONTH_PREVIEW_LIMIT).map((entry) => (
                    <CalendarEntryChip key={entry.id} entry={entry} />
                  ))}
                  {overflow > 0 && (
                    <button
                      type="button"
                      onClick={() => setOpenDay(key)}
                      className="pointer-events-auto w-full rounded px-1.5 py-0.5 text-left text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    >
                      {t("calendar.moreCount", { defaultValue: "+{{count}} more", count: overflow })}
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      </div>

      <CalendarDayDetail
        dateKey={openDay}
        entries={openDay ? entriesByDay.get(openDay) ?? [] : []}
        onOpenChange={(open) => { if (!open) setOpenDay(null); }}
      />
    </div>
  );
}
