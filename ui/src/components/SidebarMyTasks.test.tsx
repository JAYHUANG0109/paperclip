// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockIssuesApi = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock("../api/issues", () => ({ issuesApi: mockIssuesApi }));
vi.mock("@/i18n", () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? "",
  }),
}));

const { SidebarMyTasks } = await import("./SidebarMyTasks");

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function render(props: { companyId?: string | null; agentId?: string | null; rail?: boolean }) {
  // `??` would swallow a deliberate null, which is exactly the case these tests
  // exercise, so fall back only when the key is absent.
  const companyId = "companyId" in props ? props.companyId : "company-1";
  const agentId = "agentId" in props ? props.agentId : "agent-1";
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  flushSync(() => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <SidebarMyTasks companyId={companyId} agentId={agentId} rail={props.rail} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

async function settle(rounds = 6) {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
  }
}

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: "issue-1",
    identifier: "PAP-1",
    title: "Ship the memory page",
    status: "in_progress",
    updatedAt: "2026-08-01T00:00:00.000Z",
    pinned: false,
    ...overrides,
  };
}

beforeEach(() => {
  try {
    window.localStorage.clear();
  } catch {
    /* jsdom without storage — the component falls back to expanded */
  }
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mockIssuesApi.list.mockResolvedValue([task()]);
});

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("SidebarMyTasks", () => {
  // The whole point: the list is keyed on the viewer's own agent, so two people
  // in one company see different tasks. A query that forgot the filter would
  // show everyone the same list.
  it("asks only for this user's agent's tasks", async () => {
    render({ agentId: "agent-1" });
    await settle();

    expect(mockIssuesApi.list).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ participantAgentId: "agent-1" }),
    );
  });

  it("renders the task titles", async () => {
    render({});
    await settle();

    expect(container.textContent).toContain("Ship the memory page");
  });

  // The agent page's "Recent Tasks" uses participantAgentId with no status
  // filter. Constraining the sidebar to open work made the two lists disagree,
  // which reads as "these aren't my tasks".
  it("matches the agent page: recent tasks, not just open ones", async () => {
    render({});
    await settle();

    const filters = mockIssuesApi.list.mock.calls[0]![1] as Record<string, unknown>;
    expect(filters.status).toBeUndefined();
    expect(filters.participantAgentId).toBe("agent-1");
  });

  it("shows finished tasks too", async () => {
    mockIssuesApi.list.mockResolvedValue([task({ status: "done", title: "google sheets test" })]);
    render({});
    await settle();

    expect(container.textContent).toContain("google sheets test");
  });

  // The agent page sorts pinned-first then most-recently-updated before
  // slicing. Taking the API's default order instead surfaced stale routine
  // runs while the agent page showed recent work - same query, same agent,
  // different slice. Order must match or the two lists disagree again.
  it("shows the most recently updated tasks first", async () => {
    mockIssuesApi.list.mockResolvedValue([
      task({ id: "old", title: "stale routine run", updatedAt: "2026-07-01T00:00:00.000Z" }),
      task({ id: "new", title: "google slides test", updatedAt: "2026-08-02T00:00:00.000Z" }),
    ]);
    render({});
    await settle();

    const titles = Array.from(container.querySelectorAll("a")).map((a) => a.textContent);
    expect(titles[0]).toContain("google slides test");
    expect(titles[1]).toContain("stale routine run");
  });

  it("floats pinned tasks above newer unpinned ones", async () => {
    mockIssuesApi.list.mockResolvedValue([
      task({ id: "new", title: "newer task", updatedAt: "2026-08-02T00:00:00.000Z" }),
      task({ id: "pin", title: "pinned task", updatedAt: "2026-01-01T00:00:00.000Z", pinned: true }),
    ]);
    render({});
    await settle();

    const titles = Array.from(container.querySelectorAll("a")).map((a) => a.textContent);
    expect(titles[0]).toContain("pinned task");
  });

  // An unpaired user has no "own tasks"; querying with a null agent would fall
  // back to the whole company, which is exactly the leak to avoid.
  it("renders nothing and queries nothing without a mapped agent", async () => {
    render({ agentId: null });
    await settle();

    expect(mockIssuesApi.list).not.toHaveBeenCalled();
    expect(container.textContent).toBe("");
  });

  it("renders nothing before a company is chosen", async () => {
    render({ companyId: null });
    await settle();

    expect(mockIssuesApi.list).not.toHaveBeenCalled();
  });

  it("stays empty rather than showing a blank section when there are no tasks", async () => {
    mockIssuesApi.list.mockResolvedValue([]);
    render({});
    await settle();

    expect(container.textContent).toBe("");
  });

  // Expanded by default: the list is the point, so it should be there without
  // being asked for.
  // "Tasks" (the nav item above) is the only parent, so the redundant "Recent"
  // group header was removed: the tasks list straight under it, always visible,
  // with no collapse control.
  it("renders the tasks directly with no group header", async () => {
    render({});
    await settle();

    expect(container.querySelector("button[aria-expanded]")).toBeNull();
    expect(container.textContent).toContain("Ship the memory page");
  });

  // The collapsed rail is icon-only; a list of titles cannot render there.
  it("renders nothing in the collapsed rail", async () => {
    render({ rail: true });
    await settle();

    expect(container.textContent).toBe("");
  });
});
