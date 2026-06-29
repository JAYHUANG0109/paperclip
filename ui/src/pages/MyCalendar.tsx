import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { CalendarDays, ChevronLeft, ChevronRight, AlertTriangle, Search } from "lucide-react";
import { issuesApi } from "../api/issues";
import { projectsApi } from "../api/projects";
import { dashboardApi } from "../api/dashboard";
import { authApi } from "../api/auth";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useTranslation } from "@/i18n";
import { queryKeys } from "../lib/queryKeys";
import {
  IssueCalendar,
  type AsanaCalendarEvent,
  type GoogleCalendarEvent,
} from "../components/IssueCalendar";
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
  /** When set, this row is an Asana task and links out to Asana instead of an issue. */
  asanaUrl?: string | null;
  /** When set, this row is a Google Calendar event and links out to Google. */
  googleUrl?: string | null;
};

/* ---------- Issue chip (shared by week + list) ---------- */
function IssueChip({ issue }: { issue: CalIssue }) {
  const done = issue.status === "done" || issue.status === "cancelled";
  const className = cn(
    "flex items-center gap-1.5 rounded px-1.5 py-1 text-xs no-underline transition-colors hover:bg-accent",
    done ? "text-muted-foreground line-through" : "text-foreground",
  );
  const dot = (
    <span
      className={cn(
        "h-1.5 w-1.5 shrink-0 rounded-full",
        issue.googleUrl
          ? "bg-emerald-500"
          : issue.asanaUrl
            ? "bg-sky-500"
            : PRIORITY_DOT[issue.priority] ?? "bg-neutral-400",
      )}
    />
  );
  // Asana tasks + Google events deep-link out; native issues go to the detail page.
  if (issue.googleUrl || issue.asanaUrl) {
    return (
      <a href={issue.googleUrl ?? issue.asanaUrl ?? "#"} target="_blank" rel="noreferrer" title={issue.title} className={className}>
        {dot}
        <span className="truncate">{issue.title}</span>
      </a>
    );
  }
  return (
    <Link to={createIssueDetailPath(issue.identifier ?? issue.id)} title={issue.title} className={className}>
      {dot}
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
  const [search, setSearch] = useState("");

  useEffect(() => {
    setBreadcrumbs([{ label: t("nav.calendar", { defaultValue: "Calendar" }) }]);
  }, [setBreadcrumbs, t]);

  const { data: issues } = useQuery({
    queryKey: [...queryKeys.issues.list(selectedCompanyId ?? "__none__"), "calendar"],
    queryFn: () => issuesApi.list(selectedCompanyId!, { limit: CALENDAR_ISSUE_LIMIT }),
    enabled: !!selectedCompanyId,
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId ?? "__none__"),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  // The user's own Asana tasks (read-only digest) overlaid onto the calendar.
  const { data: digest } = useQuery({
    queryKey: ["asana-digest", selectedCompanyId ?? "__none__"],
    queryFn: () => dashboardApi.asanaDigest(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    staleTime: 60_000,
  });

  // The user's own Google Calendar events across all calendars they can see
  // (read-only, fetched with their own SSO token). `connected:false` →
  // re-consent needed; surfaced as a banner below.
  const { data: google } = useQuery({
    queryKey: ["google-calendar", selectedCompanyId ?? "__none__"],
    queryFn: () => dashboardApi.googleCalendar(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    staleTime: 60_000,
  });
  const googleNeedsConnect = google?.connected === false && google.reason === "auth_required";

  // Re-run the Google OAuth flow (with the calendar scope) and return here.
  const handleConnectGoogle = async () => {
    try {
      const { url } = await authApi.signInSocial({
        provider: "google",
        callbackURL: window.location.pathname,
      });
      window.location.href = url;
    } catch {
      /* surfaced by the banner staying put; nothing destructive */
    }
  };

  const dated = useMemo(() => (issues ?? []).filter((i: Issue) => Boolean(i.dueDate)), [issues]);
  const projectEvents = useMemo(
    () =>
      (projects ?? [])
        .filter((p) => p.targetDate && !p.archivedAt)
        .map((p) => ({ id: p.id, name: p.name, date: p.targetDate as string, urlKey: p.urlKey })),
    [projects],
  );
  // Asana tasks with a due date → month overlay events + week/list rows.
  const asanaEvents = useMemo<AsanaCalendarEvent[]>(
    () =>
      (digest?.weekly ?? [])
        .filter((tk) => tk.dueOn)
        .map((tk) => ({
          gid: tk.gid,
          name: tk.name,
          date: tk.dueOn as string,
          permalinkUrl: tk.permalinkUrl,
          completed: tk.completed,
        })),
    [digest],
  );
  const asanaCalIssues = useMemo<CalIssue[]>(
    () =>
      asanaEvents.map((ev) => ({
        id: `asana-${ev.gid}`,
        title: ev.name,
        status: ev.completed ? "done" : "todo",
        priority: "medium",
        dueDate: ev.date,
        asanaUrl: ev.permalinkUrl,
      })),
    [asanaEvents],
  );
  // Google events → month-grid overlay + week/list rows (green, deep-link out).
  const googleEvents = useMemo<GoogleCalendarEvent[]>(
    () =>
      (google?.connected ? google.events : []).map((ev) => ({
        id: ev.id,
        title: ev.title,
        date: ev.dateKey,
        htmlLink: ev.htmlLink,
        allDay: ev.allDay,
        calendarName: ev.calendarName,
      })),
    [google],
  );
  const googleCalIssues = useMemo<CalIssue[]>(
    () =>
      googleEvents.map((ev) => ({
        id: `gcal-${ev.id}`,
        title: ev.title,
        status: "todo",
        priority: "medium",
        dueDate: ev.date,
        googleUrl: ev.htmlLink ?? null,
      })),
    [googleEvents],
  );

  // Title search across every source (the team's "find my name in the title" flow).
  const q = search.trim().toLowerCase();
  const matchesQuery = (title: string) => !q || title.toLowerCase().includes(q);
  const filteredGoogleEvents = useMemo(
    () => googleEvents.filter((ev) => matchesQuery(ev.title)),
    [googleEvents, q],
  );
  const filteredProjectEvents = useMemo(
    () => projectEvents.filter((p) => matchesQuery(p.name)),
    [projectEvents, q],
  );
  const filteredAsanaEvents = useMemo(
    () => asanaEvents.filter((ev) => matchesQuery(ev.name)),
    [asanaEvents, q],
  );
  const filteredDatedIssues = useMemo(() => dated.filter((i) => matchesQuery(i.title)), [dated, q]);

  const datedWithAsana = useMemo(
    () => [
      ...filteredDatedIssues,
      ...asanaCalIssues.filter((i) => matchesQuery(i.title)),
      ...googleCalIssues.filter((i) => matchesQuery(i.title)),
    ],
    [filteredDatedIssues, asanaCalIssues, googleCalIssues, q],
  );
  const hasAnything = datedWithAsana.length > 0 || filteredProjectEvents.length > 0;

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

      {/* Title search — the team encodes meeting attendees in event titles, so
          searching the title is how people find what concerns them. */}
      <div className="relative max-w-xs">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("calendar.searchPlaceholder", { defaultValue: "Search by title…" })}
          className="h-9 w-full rounded-md border border-border bg-background pl-8 pr-3 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
      </div>

      {googleNeedsConnect && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs">
          <span className="text-emerald-700 dark:text-emerald-300">
            {t("calendar.google.connectHint", {
              defaultValue: "Connect Google Calendar to see your events here.",
            })}
          </span>
          <button
            type="button"
            onClick={handleConnectGoogle}
            className="rounded-md border border-emerald-500/40 px-2 py-1 font-medium text-emerald-700 transition-colors hover:bg-emerald-500/15 dark:text-emerald-300"
          >
            {t("calendar.google.connect", { defaultValue: "Connect Google Calendar" })}
          </button>
        </div>
      )}

      {!hasAnything && (
        <div className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
          {t("calendar.empty.message", { defaultValue: "No issues have a due date yet. Set a due date on an issue to see it here." })}
        </div>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsContent value="month" className="mt-0">
          <IssueCalendar
            issues={filteredDatedIssues}
            projectEvents={filteredProjectEvents}
            asanaEvents={filteredAsanaEvents}
            googleEvents={filteredGoogleEvents}
          />
        </TabsContent>
        <TabsContent value="week" className="mt-0">
          <WeekView issues={datedWithAsana} />
        </TabsContent>
        <TabsContent value="list" className="mt-0">
          {datedWithAsana.length > 0 ? (
            <AgendaList issues={datedWithAsana} />
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
