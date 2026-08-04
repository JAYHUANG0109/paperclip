// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeAccountPoolEntry, RuntimeAccountsResult } from "@paperclipai/shared";

/**
 * Stub translation rather than loading the real bundles. What is under test here is
 * whether a usage number is shown at all, which must not depend on locale files being
 * complete — and `@/i18n` validates the whole bundle on import and throws in dev, so a
 * missing translation elsewhere in the app would otherwise fail this file for an
 * unrelated reason.
 */
vi.mock("@/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const fallback = (opts?.defaultValue as string) ?? key;
      return fallback.replace(/\{\{(\w+)\}\}/g, (_m, name) => String(opts?.[name] ?? ""));
    },
  }),
}));

const { RuntimeAccountCard } = await import("./RuntimeAccountCard");

/**
 * The usage bars must never invent headroom.
 *
 * `quotaWindows` is null whenever the number could not be read — logged out, expired
 * token, or the unpublished usage endpoint moved. Rendering that as a 0% bar would tell
 * an operator "this account is barely touched" at the exact moment we have no idea, so
 * the row has to show nothing instead.
 */

let container: HTMLDivElement | null = null;

function render(entries: RuntimeAccountPoolEntry[]) {
  const result: RuntimeAccountsResult = {
    provider: "anthropic",
    activeResolved: true,
    entries,
    agentCount: 46,
    viewerReason: "test",
    pinnedDir: null,
    canSwitch: false,
  };
  container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<RuntimeAccountCard result={result} />);
  });
  return container.textContent ?? "";
}

const entry = (over: Partial<RuntimeAccountPoolEntry> = {}): RuntimeAccountPoolEntry => ({
  dir: "/Users/x/.claude-accounts/acct2",
  active: true,
  coolingDownUntil: null,
  email: "bot@example.org",
  subscriptionType: "max",
  orgName: "Org",
  loggedIn: true,
  pinned: false,
  quotaWindows: null,
  ...over,
});

afterEach(() => {
  if (container) {
    container.remove();
    container = null;
  }
});

describe("RuntimeAccountCard usage bars", () => {
  it("shows a percentage for each reported window", () => {
    const text = render([
      entry({
        quotaWindows: [
          { label: "Current session", usedPercent: 81, resetsAt: null, valueLabel: null },
          { label: "Current week (all models)", usedPercent: 54, resetsAt: null, valueLabel: null },
        ],
      }),
    ]);
    expect(text).toContain("81%");
    expect(text).toContain("54%");
    expect(text).toContain("Current session");
  });

  it("renders NO bar when usage is unknown, rather than 0%", () => {
    const text = render([entry({ quotaWindows: null })]);
    // The account itself still renders; only the usage claim is absent.
    expect(text).toContain("bot@example.org");
    expect(text).not.toContain("0%");
  });

  it("skips windows the provider reported without a percentage", () => {
    const text = render([
      entry({
        quotaWindows: [
          { label: "Current session", usedPercent: 12, resetsAt: null, valueLabel: null },
          { label: "Extra usage", usedPercent: null, resetsAt: null, valueLabel: null },
        ],
      }),
    ]);
    expect(text).toContain("12%");
    expect(text).not.toContain("Extra usage");
  });

  it("colours by threshold — green under 60, yellow 60-85, red above 85", () => {
    render([
      entry({
        quotaWindows: [
          { label: "low", usedPercent: 10, resetsAt: null, valueLabel: null },
          { label: "mid", usedPercent: 70, resetsAt: null, valueLabel: null },
          { label: "high", usedPercent: 95, resetsAt: null, valueLabel: null },
        ],
      }),
    ]);
    const html = container?.innerHTML ?? "";
    expect(html).toContain("bg-green-400");
    expect(html).toContain("bg-yellow-400");
    expect(html).toContain("bg-red-400");
  });

  it("clamps a nonsensical percentage instead of overflowing the bar", () => {
    render([
      entry({ quotaWindows: [{ label: "odd", usedPercent: 140, resetsAt: null, valueLabel: null }] }),
    ]);
    expect(container?.innerHTML ?? "").toContain("width: 100%");
  });
});
