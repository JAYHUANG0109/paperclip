import { Link } from "@/lib/router";
import { Diamond, ExternalLink, Flag, Stamp } from "lucide-react";
import { useTranslation } from "@/i18n";
import { cn } from "../lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const PRIORITY_DOT: Record<string, string> = {
  critical: "bg-red-500",
  high: "bg-orange-500",
  medium: "bg-yellow-500",
  low: "bg-neutral-400",
};

/** Where a calendar row came from. Drives its colour, glyph, and link target. */
export type CalendarEntryKind = "project" | "issue" | "asana" | "google";

/**
 * One thing plotted on a calendar day, from any source.
 *
 * The month grid, the week grid, and the day dialog all render the same list, so
 * every source is normalised into this shape once by whoever owns the data. That
 * keeps "what is on this day?" a single answer instead of four parallel maps
 * that each view has to re-merge and re-cap independently.
 */
export interface CalendarDayEntry {
  id: string;
  kind: CalendarEntryKind;
  title: string;
  /** Internal route, for entries that live in Paperclip. */
  to?: string | null;
  /** External deep link (Asana / Google), opened in a new tab. */
  href?: string | null;
  /** Renders struck through — done issues, completed Asana tasks. */
  done?: boolean;
  /** Local time to lead with, e.g. "09:30". Absent for all-day/dateless entries. */
  timeLabel?: string | null;
  /** Secondary context shown in the day dialog only: status, calendar name, … */
  meta?: string | null;
  priority?: string | null;
  /** Asana subtype: milestone | approval | default_task. */
  resourceSubtype?: string | null;
}

const KIND_CHIP: Record<CalendarEntryKind, string> = {
  project:
    "bg-violet-500/15 text-violet-700 hover:bg-violet-500/25 dark:text-violet-300",
  asana: "bg-sky-500/15 text-sky-700 hover:bg-sky-500/25 dark:text-sky-300",
  google:
    "bg-emerald-500/15 text-emerald-700 hover:bg-emerald-500/25 dark:text-emerald-300",
  issue: "text-foreground hover:bg-accent",
};

/** The leading glyph: item type where it matters, otherwise a source/priority dot. */
export function CalendarEntryGlyph({ entry }: { entry: CalendarDayEntry }) {
  if (entry.kind === "project") return <Flag className="h-3.5 w-3.5 shrink-0" />;
  if (entry.resourceSubtype === "milestone")
    return <Diamond className="h-3.5 w-3.5 shrink-0 text-sky-500" />;
  if (entry.resourceSubtype === "approval")
    return <Stamp className="h-3.5 w-3.5 shrink-0 text-sky-500" />;
  return (
    <span
      className={cn(
        "h-2 w-2 shrink-0 rounded-full",
        entry.kind === "google"
          ? "bg-emerald-500"
          : entry.kind === "asana"
            ? "bg-sky-500"
            : PRIORITY_DOT[entry.priority ?? ""] ?? "bg-neutral-400",
      )}
    />
  );
}

/**
 * A calendar chip, as it appears inside a day cell.
 *
 * `pointer-events-auto` is deliberate and load-bearing: day cells sit under a
 * full-bleed "open this day" button, and the content above it is
 * `pointer-events-none` so clicks on empty space and the date number reach that
 * button. Only the chips opt back in, so clicking an item still follows its
 * link while clicking anywhere else in the box opens the day view.
 */
export function CalendarEntryChip({
  entry,
  className,
}: {
  entry: CalendarDayEntry;
  className?: string;
}) {
  const content = (
    <>
      <CalendarEntryGlyph entry={entry} />
      {entry.timeLabel ? (
        <span className="shrink-0 tabular-nums opacity-70">{entry.timeLabel}</span>
      ) : null}
      {/* Two lines, not one: a truncated Chinese meeting title shows so few
          characters that it cannot be told apart from the next one. */}
      <span className="line-clamp-2 break-words leading-snug">{entry.title}</span>
    </>
  );
  const chipClass = cn(
    "pointer-events-auto flex items-start gap-1.5 rounded px-1.5 py-1 text-left text-xs no-underline transition-colors",
    KIND_CHIP[entry.kind],
    entry.done && "line-through opacity-70",
    className,
  );
  const title = entry.meta ? `${entry.title} · ${entry.meta}` : entry.title;

  if (entry.href) {
    return (
      <a href={entry.href} target="_blank" rel="noreferrer" title={title} className={chipClass}>
        {content}
      </a>
    );
  }
  if (entry.to) {
    return (
      <Link to={entry.to} title={title} className={chipClass}>
        {content}
      </Link>
    );
  }
  return (
    <div title={title} className={chipClass}>
      {content}
    </div>
  );
}

function formatDayHeading(dateKey: string, locale: string): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  if (!y || !m || !d) return dateKey;
  const date = new Date(y, m - 1, d);
  try {
    return new Intl.DateTimeFormat(locale, {
      year: "numeric",
      month: "long",
      day: "numeric",
      weekday: "long",
    }).format(date);
  } catch {
    return dateKey;
  }
}

/**
 * Everything on one day, at full width and with nothing truncated.
 *
 * The grid can only ever show a preview — this is where a day is actually read.
 * Opened by clicking the day box (not an item) in the month and week views.
 */
export function CalendarDayDetail({
  dateKey,
  entries,
  onOpenChange,
}: {
  /** The open day, or null when closed. */
  dateKey: string | null;
  entries: CalendarDayEntry[];
  onOpenChange: (open: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const heading = dateKey ? formatDayHeading(dateKey, i18n?.language ?? "en") : "";

  return (
    <Dialog open={dateKey != null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-base">{heading}</DialogTitle>
          <DialogDescription>
            {entries.length > 0
              ? t("calendar.day.count", {
                  defaultValue: "{{count}} item(s) on this day",
                  count: entries.length,
                })
              : t("calendar.day.empty", { defaultValue: "Nothing scheduled on this day." })}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          {entries.map((entry) => {
            const inner = (
              <>
                <span className="mt-0.5">
                  <CalendarEntryGlyph entry={entry} />
                </span>
                <span className="min-w-0 flex-1">
                  <span
                    className={cn(
                      "block break-words text-sm",
                      entry.done ? "text-muted-foreground line-through" : "text-foreground",
                    )}
                  >
                    {entry.timeLabel ? (
                      <span className="mr-1.5 tabular-nums text-muted-foreground">
                        {entry.timeLabel}
                      </span>
                    ) : null}
                    {entry.title}
                  </span>
                  {entry.meta ? (
                    <span className="mt-0.5 block text-xs text-muted-foreground">{entry.meta}</span>
                  ) : null}
                </span>
                {entry.href ? (
                  <ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                ) : null}
              </>
            );
            const rowClass =
              "flex items-start gap-2 rounded-md px-2 py-2 no-underline transition-colors hover:bg-accent/50";
            if (entry.href) {
              return (
                <a
                  key={entry.id}
                  href={entry.href}
                  target="_blank"
                  rel="noreferrer"
                  className={rowClass}
                >
                  {inner}
                </a>
              );
            }
            if (entry.to) {
              return (
                <Link
                  key={entry.id}
                  to={entry.to}
                  onClick={() => onOpenChange(false)}
                  className={rowClass}
                >
                  {inner}
                </Link>
              );
            }
            return (
              <div key={entry.id} className={rowClass}>
                {inner}
              </div>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
