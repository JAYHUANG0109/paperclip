import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, ExternalLink, Settings2, Loader2, Plus } from "lucide-react";
import { useTranslation } from "@/i18n";
import { dashboardApi, type GoogleCalendarEventDto } from "../api/dashboard";
import { authApi } from "../api/auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "../lib/utils";

const SCHEDULE_KEY = (companyId: string) => ["google-calendar-mine", companyId];
const ALIASES_KEY = (companyId: string) => ["google-calendar-aliases", companyId];

/**
 * Dashboard "My Schedule" — the caller's own Google Calendar events that concern
 * them. Because the team types attendee NAMES into event titles (no real
 * attendees), the server filters to: events the user owns/attends OR whose title
 * matches one of the user's name-aliases. Results are "likely related" (heuristic),
 * not authoritative. The gear opens an inline editor for the user's name-aliases.
 */
export function MyScheduleSection({ companyId }: { companyId: string }) {
  const { t } = useTranslation();
  const [showSettings, setShowSettings] = useState(false);
  const [showNewEvent, setShowNewEvent] = useState(false);

  const { data } = useQuery({
    queryKey: SCHEDULE_KEY(companyId),
    queryFn: () => dashboardApi.googleCalendar(companyId, { mine: true }),
    enabled: !!companyId,
    staleTime: 60_000,
  });

  const connectGoogle = async () => {
    try {
      const { url } = await authApi.signInSocial({ provider: "google", callbackURL: window.location.pathname });
      window.location.href = url;
    } catch {
      /* banner stays; nothing destructive */
    }
  };

  // Upcoming events from today onward, grouped by date.
  const groups = useMemo(() => {
    const events = data?.connected ? data.events : [];
    const todayKey = localDateKey(new Date());
    const upcoming = events
      .filter((e) => e.dateKey >= todayKey)
      .sort((a, b) => a.start.localeCompare(b.start));
    const byDay = new Map<string, GoogleCalendarEventDto[]>();
    for (const e of upcoming.slice(0, 50)) {
      const list = byDay.get(e.dateKey);
      if (list) list.push(e);
      else byDay.set(e.dateKey, [e]);
    }
    return [...byDay.entries()];
  }, [data]);

  const needsConnect = data?.connected === false && data.reason === "auth_required";
  // Hide entirely when calendar isn't configured for the instance at all.
  if (data?.connected === false && data.reason === "not_configured") return null;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground/80">
          <CalendarClock className="h-4 w-4 text-muted-foreground" />
          {t("schedule.title", { defaultValue: "My Schedule" })}
          <span className="rounded-full border border-border px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            {t("schedule.likelyRelated", { defaultValue: "likely related" })}
          </span>
        </h2>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setShowNewEvent((v) => !v)}
            aria-expanded={showNewEvent}
            className="inline-flex h-7 items-center gap-1 rounded border border-border px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
          >
            <Plus className="h-3.5 w-3.5" />
            {t("schedule.newEvent", { defaultValue: "New event" })}
          </button>
          <button
            type="button"
            onClick={() => setShowSettings((v) => !v)}
            aria-expanded={showSettings}
            aria-label={t("schedule.nameMatching", { defaultValue: "Calendar name matching" })}
            className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
          >
            <Settings2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      {showNewEvent && (
        <NewEventForm
          companyId={companyId}
          onDone={() => setShowNewEvent(false)}
          onNeedsConnect={connectGoogle}
        />
      )}
      {showSettings && <AliasEditor companyId={companyId} />}

      <Card className="min-w-0 overflow-hidden">
        <CardHeader className="px-5 pt-5 pb-2">
          <CardTitle className="text-base">{t("schedule.upcoming", { defaultValue: "Upcoming" })}</CardTitle>
        </CardHeader>
        <CardContent className="px-5 pb-5 pt-1">
          {needsConnect ? (
            <div className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="text-sm text-muted-foreground">
                {t("calendar.google.connectHint", { defaultValue: "Connect Google Calendar to see your events here." })}
              </span>
              <button
                type="button"
                onClick={connectGoogle}
                className="rounded-md border border-emerald-500/40 px-2 py-1 text-xs font-medium text-emerald-700 transition-colors hover:bg-emerald-500/15 dark:text-emerald-300"
              >
                {t("calendar.google.connect", { defaultValue: "Connect Google Calendar" })}
              </button>
            </div>
          ) : groups.length === 0 ? (
            <p className="py-3 text-sm text-muted-foreground">
              {t("schedule.empty", { defaultValue: "Nothing coming up with your name on it." })}
            </p>
          ) : (
            <div className="space-y-3">
              {groups.map(([dateKey, events]) => (
                <div key={dateKey} className="space-y-1">
                  <div className="text-xs font-semibold text-muted-foreground">{dateKey}</div>
                  <ul className="divide-y divide-border">
                    {events.map((ev) => (
                      <li key={ev.id} className="flex items-center gap-2.5 py-2 text-sm">
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
                        {ev.htmlLink ? (
                          <a
                            href={ev.htmlLink}
                            target="_blank"
                            rel="noreferrer"
                            className="group min-w-0 flex-1 truncate hover:underline"
                          >
                            {ev.title}
                            <ExternalLink className="ml-1 inline h-3 w-3 align-text-top text-muted-foreground/0 transition-colors group-hover:text-muted-foreground" />
                          </a>
                        ) : (
                          <span className="min-w-0 flex-1 truncate">{ev.title}</span>
                        )}
                        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                          {formatEventTime(ev)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/** Inline "New event" form — creates on the user's own Google Calendar via the
 *  server-side write endpoint (no MCP). Needs the calendar.events scope, so on
 *  auth_required it prompts a one-time Google re-consent. */
function NewEventForm({
  companyId,
  onDone,
  onNeedsConnect,
}: {
  companyId: string;
  onDone: () => void;
  onNeedsConnect: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [allDay, setAllDay] = useState(false);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [description, setDescription] = useState("");
  const [authNeeded, setAuthNeeded] = useState(false);
  const [calendarId, setCalendarId] = useState<string>("");

  const { data: calList } = useQuery({
    queryKey: ["google-calendar-list", companyId],
    queryFn: () => dashboardApi.googleCalendarList(companyId),
    enabled: !!companyId,
    staleTime: 300_000,
  });
  // Default the target to the shared cross-campus calendar (most events go there).
  const writable = useMemo(() => (calList?.calendars ?? []).filter((c) => c.canWrite), [calList]);
  const effectiveCalendarId = calendarId || calList?.defaultCalendarId || "";

  const create = useMutation({
    mutationFn: () =>
      dashboardApi.createCalendarEvent(companyId, {
        summary: title.trim(),
        // datetime-local gives "YYYY-MM-DDTHH:mm"; append seconds. All-day uses the
        // bare date. timeZone lets Google interpret a no-offset dateTime correctly.
        start: allDay ? start : start ? `${start}:00` : "",
        end: end ? (allDay ? end : `${end}:00`) : undefined,
        description: description.trim() || undefined,
        timeZone: allDay ? undefined : "Asia/Taipei",
        calendarId: effectiveCalendarId || undefined,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: SCHEDULE_KEY(companyId) });
      onDone();
    },
    onError: (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (/auth_required/i.test(msg)) setAuthNeeded(true);
    },
  });
  const isForbidden = create.error instanceof Error && /forbidden|writer access|requiredAccessLevel/i.test(create.error.message);

  const valid = title.trim().length > 0 && start.length > 0;
  const errorMsg = create.error instanceof Error ? create.error.message : null;

  return (
    <div className="rounded-md border border-border bg-muted/30 p-3">
      <div className="space-y-2">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t("schedule.eventTitle", { defaultValue: "Event title" })}
          className="h-8 w-full rounded border border-border bg-background px-2 text-sm"
        />
        {calList?.connected && (writable.length > 0 || calList.defaultCalendarId) && (
          <label className="block text-xs text-muted-foreground">
            {t("schedule.calendar", { defaultValue: "Calendar" })}
            <select
              value={effectiveCalendarId}
              onChange={(e) => setCalendarId(e.target.value)}
              className="mt-0.5 h-8 w-full rounded border border-border bg-background px-2 text-sm"
            >
              {/* Ensure the shared default is always selectable, even if the user's
                  writable list doesn't include it (they may still have edit rights). */}
              {calList.defaultCalendarId && !writable.some((c) => c.id === calList.defaultCalendarId) && (
                <option value={calList.defaultCalendarId}>跨校共用行事曆</option>
              )}
              {writable.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.primary ? `${c.name ?? c.id}（我）` : c.name ?? c.id}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
          {t("schedule.allDay", { defaultValue: "All day" })}
        </label>
        <div className="flex flex-wrap gap-2">
          <label className="flex-1 text-xs text-muted-foreground">
            {t("schedule.start", { defaultValue: "Start" })}
            <input
              type={allDay ? "date" : "datetime-local"}
              value={start}
              onChange={(e) => setStart(e.target.value)}
              className="mt-0.5 h-8 w-full rounded border border-border bg-background px-2 text-sm"
            />
          </label>
          <label className="flex-1 text-xs text-muted-foreground">
            {t("schedule.end", { defaultValue: "End (optional)" })}
            <input
              type={allDay ? "date" : "datetime-local"}
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              className="mt-0.5 h-8 w-full rounded border border-border bg-background px-2 text-sm"
            />
          </label>
        </div>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t("schedule.eventDescription", { defaultValue: "Description (optional)" })}
          rows={2}
          className="w-full rounded border border-border bg-background px-2 py-1 text-sm"
        />
        {authNeeded ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5">
            <span className="text-xs text-amber-700 dark:text-amber-300">
              {t("schedule.writeAuthNeeded", {
                defaultValue: "Google needs re-authorization to create events. Reconnect once, then try again.",
              })}
            </span>
            <button
              type="button"
              onClick={onNeedsConnect}
              className="rounded-md border border-emerald-500/40 px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-500/15 dark:text-emerald-300"
            >
              {t("calendar.google.connect", { defaultValue: "Connect Google Calendar" })}
            </button>
          </div>
        ) : isForbidden ? (
          <p className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-700 dark:text-amber-300">
            {t("schedule.writerAclNeeded", {
              defaultValue:
                "This account only has view access to that calendar. Set it to “Make changes to events” (變更活動) in the calendar's sharing settings, or pick a calendar you can edit.",
            })}
          </p>
        ) : errorMsg ? (
          <p className="text-xs text-destructive">{errorMsg}</p>
        ) : null}
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onDone}
            className="rounded px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
          >
            {t("common.cancel", { defaultValue: "Cancel" })}
          </button>
          <button
            type="button"
            disabled={!valid || create.isPending}
            onClick={() => { setAuthNeeded(false); create.mutate(); }}
            className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {create.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
            {t("schedule.createEvent", { defaultValue: "Create event" })}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Inline editor for the user's calendar name-aliases (title matching). */
function AliasEditor({ companyId }: { companyId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ALIASES_KEY(companyId),
    queryFn: () => dashboardApi.calendarAliases(companyId),
    enabled: !!companyId,
  });
  const [draft, setDraft] = useState<string | null>(null);
  const current = draft ?? (data ? (data.usingDefaults ? data.derived : data.aliases).join(", ") : "");

  const save = useMutation({
    mutationFn: (aliases: string[]) => dashboardApi.saveCalendarAliases(companyId, aliases),
    onSuccess: (res) => {
      queryClient.setQueryData(ALIASES_KEY(companyId), res);
      queryClient.invalidateQueries({ queryKey: SCHEDULE_KEY(companyId) });
      setDraft(null);
    },
  });

  return (
    <div className="space-y-2 rounded-md border border-border bg-muted/20 p-3">
      <p className="text-xs text-muted-foreground">
        {t("schedule.aliasHint", {
          defaultValue:
            "Names to match in event titles (comma-separated). Events whose title contains any of these show up as yours.",
        })}
      </p>
      <input
        type="text"
        value={current}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={t("schedule.aliasPlaceholder", { defaultValue: "e.g. 黃睦傑, 睦傑, Jay" })}
        className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={save.isPending}
          onClick={() =>
            save.mutate(
              current
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            )
          }
          className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium transition-colors hover:bg-accent disabled:opacity-50"
        >
          {save.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
          {t("common.save", { defaultValue: "Save" })}
        </button>
        <button
          type="button"
          disabled={save.isPending}
          onClick={() => save.mutate([])}
          className="rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
        >
          {t("schedule.aliasReset", { defaultValue: "Reset to defaults" })}
        </button>
      </div>
    </div>
  );
}

function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatEventTime(ev: GoogleCalendarEventDto): string {
  if (ev.allDay) return "";
  const d = new Date(ev.start);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
