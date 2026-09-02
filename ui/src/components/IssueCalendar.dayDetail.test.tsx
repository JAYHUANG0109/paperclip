// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The day cell's two-target contract.
 *
 * A month cell can only ever preview a day: four chips, each a truncated line.
 * So the box itself has to be clickable — clicking anywhere that is not an item
 * opens the full day. That only works if the two targets stay separate: the
 * chips keep their own links, and everything else in the box (empty space, the
 * date number, "+N more") opens the day view. These pin that split, because it
 * is invisible in the markup — it depends on a full-bleed button sitting
 * *behind* `pointer-events-none` content.
 */

vi.mock("@/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const fallback = (opts?.defaultValue as string) ?? key;
      return fallback.replace(/\{\{(\w+)\}\}/g, (_m, name) => String(opts?.[name] ?? ""));
    },
    i18n: { language: "en" },
  }),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

// Radix's dialog needs a portal and focus management that add nothing here; the
// question under test is only whether the day view was asked to open.
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div data-testid="day-detail">{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
}));

const { IssueCalendar, eventTimeLabel } = await import("./IssueCalendar");

let container: HTMLDivElement | null = null;

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** A date guaranteed to be inside the current month grid, away from its edges. */
const inMonth = (() => {
  const now = new Date();
  return ymd(new Date(now.getFullYear(), now.getMonth(), 15));
})();

function render(node: ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return container;
}

/** The cell's full-bleed "open this day" button. */
function dayButton(dateKey: string): HTMLButtonElement {
  const buttons = Array.from(container!.querySelectorAll("button"));
  const match = buttons.find((b) => b.textContent?.includes(`Open ${dateKey}`));
  if (!match) throw new Error(`no day button for ${dateKey}`);
  return match as HTMLButtonElement;
}

function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

const dayDetailText = () =>
  (container?.querySelector('[data-testid="day-detail"]') as HTMLElement | null)?.textContent ?? null;

afterEach(() => {
  container?.remove();
  container = null;
});

describe("month grid day cells", () => {
  it("opens the day view when the box itself is clicked", () => {
    render(
      <IssueCalendar
        issues={[]}
        googleEvents={[
          {
            id: "g1",
            title: "【ZOOM2/會議】AI 代理人平台導入說明",
            date: inMonth,
            htmlLink: "https://calendar.google.com/g1",
            start: `${inMonth}T14:30:00`,
          },
        ]}
      />,
    );

    expect(dayDetailText()).toBeNull();
    click(dayButton(inMonth));
    // Full title, not the grid's clamped preview.
    expect(dayDetailText()).toContain("【ZOOM2/會議】AI 代理人平台導入說明");
  });

  it("leaves an item's own link intact — clicking a chip does not open the day view", () => {
    render(
      <IssueCalendar
        issues={[]}
        googleEvents={[
          { id: "g1", title: "Standup", date: inMonth, htmlLink: "https://calendar.google.com/g1" },
        ]}
      />,
    );

    const chip = Array.from(container!.querySelectorAll("a")).find((a) =>
      a.textContent?.includes("Standup"),
    );
    expect(chip?.getAttribute("href")).toBe("https://calendar.google.com/g1");
    click(chip!);
    expect(dayDetailText()).toBeNull();
  });

  it("collapses a long day into +N more, which opens the same day view", () => {
    render(
      <IssueCalendar
        issues={[]}
        googleEvents={Array.from({ length: 7 }, (_, i) => ({
          id: `g${i}`,
          title: `Event ${i}`,
          date: inMonth,
          htmlLink: null,
        }))}
      />,
    );

    // Four previewed, the rest behind the overflow control.
    expect(container!.textContent).toContain("+3 more");
    const more = Array.from(container!.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("+3 more"),
    );
    click(more!);
    const text = dayDetailText() ?? "";
    // Every event, including the ones the grid never showed.
    for (let i = 0; i < 7; i++) expect(text).toContain(`Event ${i}`);
  });

  it("counts the day's items across every source, not just one", () => {
    render(
      <IssueCalendar
        issues={[
          {
            id: "i1",
            title: "Ship the thing",
            status: "todo",
            priority: "high",
            dueDate: inMonth,
            identifier: "PAP-1",
          },
        ]}
        asanaEvents={[{ gid: "a1", name: "Asana task", date: inMonth, permalinkUrl: null }]}
        googleEvents={[{ id: "g1", title: "Meeting", date: inMonth, htmlLink: null }]}
      />,
    );

    click(dayButton(inMonth));
    const text = dayDetailText() ?? "";
    expect(text).toContain("3 item(s) on this day");
    expect(text).toContain("Ship the thing");
    expect(text).toContain("Asana task");
    expect(text).toContain("Meeting");
  });
});

describe("eventTimeLabel", () => {
  it("shows the clock time for a timed event", () => {
    expect(eventTimeLabel("2026-09-03T09:05:00")).toBe("09:05");
  });

  it("has nothing to show for an all-day event", () => {
    expect(eventTimeLabel("2026-09-03", true)).toBeNull();
    expect(eventTimeLabel("2026-09-03")).toBeNull();
    expect(eventTimeLabel(null)).toBeNull();
  });
});
