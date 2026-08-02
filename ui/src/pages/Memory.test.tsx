// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockMemoryApi = vi.hoisted(() => ({
  list: vi.fn(),
  stats: vi.fn(),
  seed: vi.fn(),
  save: vi.fn(),
  remove: vi.fn(),
  import: vi.fn(),
  deleted: vi.fn(),
  settings: vi.fn(),
  setSettings: vi.fn(),
  restore: vi.fn(),
}));

const mockAccessApi = vi.hoisted(() => ({ getCurrentBoardAccess: vi.fn() }));
const mockAgentsApi = vi.hoisted(() => ({ mine: vi.fn() }));
const mockIssuesApi = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock("@/api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("@/api/issues", () => ({ issuesApi: mockIssuesApi }));

vi.mock("@/api/memory", () => ({ memoryApi: mockMemoryApi }));
vi.mock("@/api/access", () => ({ accessApi: mockAccessApi }));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));
vi.mock("@/i18n", () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? "",
  }),
}));

const { Memory } = await import("./Memory");

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  flushSync(() => {
    root.render(
      <QueryClientProvider client={client}>
        <Memory />
      </QueryClientProvider>,
    );
  });
}

/**
 * Let react-query settle. The memories query DEPENDS on the access query
 * (it is disabled until userId is known), so a single microtask flush is not
 * enough — the second fetch only starts after the first resolves and re-renders.
 */
async function settle(rounds = 8) {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
  }
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mockAccessApi.getCurrentBoardAccess.mockResolvedValue({ userId: "user-1", user: { id: "user-1" } });
  mockMemoryApi.list.mockResolvedValue([]);
  mockMemoryApi.stats.mockResolvedValue({
    total: 0,
    bySource: {},
    byType: {},
    byStrength: { noted: 0, confirmed: 0, core: 0 },
    agentWrites: 0,
    lastAgentWriteAt: null,
    deleted: 0,
    captureEnabled: true,
  });
  mockMemoryApi.deleted.mockResolvedValue([]);
  mockMemoryApi.settings.mockResolvedValue({ captureEnabled: true });
  mockMemoryApi.setSettings.mockResolvedValue({ captureEnabled: false });
  mockMemoryApi.restore.mockResolvedValue({});
  mockMemoryApi.import.mockResolvedValue({ imported: [], skipped: [] });
  mockMemoryApi.seed.mockResolvedValue({
    worthwhile: true,
    existingMemories: 0,
    totalIssues: 12,
    completedIssues: 9,
    agentNames: ["Tina's Agent"],
    projects: [],
    task: { title: "Catch up on memory from past work", description: "…the brief…" },
  });
  mockAgentsApi.mine.mockResolvedValue([{ id: "agent-1", name: "Tina's Agent" }]);
  mockIssuesApi.create.mockResolvedValue({ id: "issue-1" });
});

/** Click the button whose label matches, after the page has settled. */
function clickButton(label: string) {
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent === label);
  if (!button) throw new Error(`no button labelled "${label}"`);
  flushSync(() => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

/** A stored entry, with only the fields a case cares about overridden. */
function entry(overrides: Record<string, unknown> = {}) {
  return {
    name: "likes-dark-mode",
    description: "",
    memoryType: "preference",
    content: "Prefers dark mode.",
    source: "manual",
    filePath: null,
    isBinary: false,
    timesObserved: 1,
    lastObservedAt: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("Memory page", () => {
  // The page is deliberately scoped to the signed-in user: an admin who needs
  // someone else's memory uses view-as, which is audited. A picker here would
  // make reading a colleague's memory a two-click affair.
  it("requests only the signed-in user's memory", async () => {
    render();
    await settle();

    expect(mockMemoryApi.list).toHaveBeenCalledWith("company-1", "user-1");
    expect(mockMemoryApi.list).toHaveBeenCalledTimes(1);
  });

  it("renders remembered items", async () => {
    mockMemoryApi.list.mockResolvedValue([
      {
        name: "likes-dark-mode",
        description: "",
        memoryType: "user",
        content: "Prefers dark mode.",
        source: "manual",
        filePath: null,
        isBinary: false,
        updatedAt: "2026-08-01T00:00:00.000Z",
      },
    ]);
    render();
    await settle();

    expect(container.textContent).toContain("Prefers dark mode.");
  });

  // Binary entries carry base64 that the server does not send; the page must
  // describe them rather than rendering "null".
  it("describes a binary entry instead of printing its content", async () => {
    mockMemoryApi.list.mockResolvedValue([
      {
        name: "logo",
        description: "",
        memoryType: "reference",
        content: null,
        source: "imported",
        filePath: "assets/logo.png",
        isBinary: true,
        updatedAt: "2026-08-01T00:00:00.000Z",
      },
    ]);
    render();
    await settle();

    expect(container.textContent).toContain("assets/logo.png");
    expect(container.textContent).not.toContain("null");
  });

  // A partial import must never read as a complete one.
  it("shows what an import skipped, with the reason", async () => {
    mockMemoryApi.import.mockResolvedValue({
      imported: ["notes"],
      skipped: [{ relativePath: ".git/config", reason: "unsafe or unusable path" }],
    });
    render();
    await settle();

    const fileInput = container.querySelector('input[type="file"]:not([webkitdirectory])') as HTMLInputElement;
    const file = new File(["hi"], "notes.md", { type: "text/markdown" });
    Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
    flushSync(() => fileInput.dispatchEvent(new Event("change", { bubbles: true })));
    await settle();

    expect(container.textContent).toContain(".git/config");
    expect(container.textContent).toContain("unsafe or unusable path");
  });

  it("does not query before the company and user are known", async () => {
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue({ userId: null, user: null });
    render();
    await settle();

    expect(mockMemoryApi.list).not.toHaveBeenCalled();
  });
});

describe("categories", () => {
  it("labels an entry with its category", async () => {
    mockMemoryApi.list.mockResolvedValue([entry({ memoryType: "preference" })]);
    render();
    await settle();

    expect(container.textContent).toContain("Preference");
  });

  // Rows written before the taxonomy was closed still carry `user`. Showing the
  // raw value would make the chip disagree with the filter that matches it.
  it("shows a pre-taxonomy type under its current name", async () => {
    mockMemoryApi.list.mockResolvedValue([entry({ memoryType: "user" })]);
    render();
    await settle();

    expect(container.textContent).toContain("About me");
    expect(container.textContent).not.toContain("user");
  });

  it("filters the list to one category", async () => {
    mockMemoryApi.list.mockResolvedValue([
      entry({ name: "a", memoryType: "preference", content: "Prefers dark mode." }),
      entry({ name: "b", memoryType: "reference", content: "The campus rota lives here." }),
    ]);
    render();
    await settle();

    const chip = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Reference",
    ) as HTMLButtonElement;
    flushSync(() => chip.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(container.textContent).toContain("The campus rota lives here.");
    expect(container.textContent).not.toContain("Prefers dark mode.");
  });

  // A row of buttons that all lead to "nothing here" is worse than no filter.
  it("offers no filter when everything is one category", async () => {
    mockMemoryApi.list.mockResolvedValue([entry({ memoryType: "preference" })]);
    render();
    await settle();

    expect([...container.querySelectorAll("button")].some((b) => b.textContent === "All")).toBe(false);
  });

  it("sends the chosen category when saving", async () => {
    mockMemoryApi.save.mockResolvedValue({ name: "x", updatedAt: "" });
    render();
    await settle();

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    flushSync(() => {
      setter.call(textarea, "Writes updates in Traditional Chinese.");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const select = container.querySelector("select") as HTMLSelectElement;
    const selectSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    flushSync(() => {
      selectSetter.call(select, "preference");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const saveButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Remember",
    ) as HTMLButtonElement;
    flushSync(() => saveButton.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await settle();

    expect(mockMemoryApi.save).toHaveBeenCalledWith(
      "company-1",
      "user-1",
      expect.any(String),
      expect.objectContaining({ memoryType: "preference" }),
    );
  });
});

/**
 * Capture is asked for in the agent prompt, and a prompt can quietly fail to
 * land. Before this, the only way to know whether agents were writing anything
 * was to watch the page for a few days and form an impression.
 */
describe("capture health", () => {
  it("says plainly when no agent has written anything", async () => {
    render();
    await settle();

    expect(container.querySelector('[data-testid="memory-capture-health"]')?.textContent).toContain(
      "not saved anything",
    );
  });

  it("reports how many an agent contributed", async () => {
    mockMemoryApi.stats.mockResolvedValue({
      total: 5,
      bySource: { manual: 3, agent: 2 },
      byType: { preference: 5 },
      agentWrites: 2,
      lastAgentWriteAt: "2026-08-01T00:00:00.000Z",
    });
    render();
    await settle();

    expect(container.querySelector('[data-testid="memory-capture-health"]')?.textContent).toContain("2");
  });

  // Repetition is why an agent-written fact is trusted, so the owner sees it.
  it("shows how many times a fact has been re-observed", async () => {
    mockMemoryApi.list.mockResolvedValue([entry({ source: "agent", timesObserved: 3 })]);
    render();
    await settle();

    expect(container.textContent).toContain("seen 3×");
  });
});

/**
 * Catching memory up on work done before capture existed.
 *
 * The important property is that it does NOT write memories: it hands the
 * person's own agent a task, so the backfill goes through the same write gate —
 * categories, screen, limits — as everything else.
 */
describe("catching up from past work", () => {
  it("gives the person's own agent the reading to do", async () => {
    render();
    await settle();

    clickButton("Catch up from past work");
    await settle();

    expect(mockIssuesApi.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        title: "Catch up on memory from past work",
        assigneeAgentId: "agent-1",
      }),
    );
    // The distillation is the agent's job on a normal run.
    expect(mockMemoryApi.save).not.toHaveBeenCalled();
  });

  it("says so instead of creating an empty task when there is no history", async () => {
    mockMemoryApi.seed.mockResolvedValue({
      worthwhile: false,
      existingMemories: 0,
      totalIssues: 0,
      completedIssues: 0,
      agentNames: [],
      projects: [],
      task: { title: "", description: "" },
    });
    render();
    await settle();

    clickButton("Catch up from past work");
    await settle();

    expect(mockIssuesApi.create).not.toHaveBeenCalled();
    expect(container.textContent).toContain("no past work");
  });

  // Assigning to the person would create a task nobody runs.
  it("does not create a task when the person has no agent", async () => {
    mockAgentsApi.mine.mockResolvedValue([]);
    render();
    await settle();

    clickButton("Catch up from past work");
    await settle();

    expect(mockIssuesApi.create).not.toHaveBeenCalled();
    expect(container.textContent).toContain("no agent yet");
  });
});

describe("the shape of the page", () => {
  /**
   * Grouped, not a feed. A flat list sorted by recency invites scrolling; the
   * question people open this page with is "what does it think it knows about
   * me", and headings answer that in one look.
   */
  it("groups entries under their category", async () => {
    mockMemoryApi.list.mockResolvedValue([
      entry({ name: "dark-mode", memoryType: "preference", content: "Prefers dark mode." }),
      entry({ name: "runs-taipei", memoryType: "expertise", content: "Owns the Taipei campus schedule." }),
    ]);
    render();
    await settle();

    const headings = [...container.querySelectorAll("h2")].map((h) => h.textContent);
    expect(headings).toContain("Preference");
    expect(headings).toContain("Expertise");
  });

  // One heading above one group is furniture.
  it("drops the headings once a filter narrows it to a single category", async () => {
    mockMemoryApi.list.mockResolvedValue([
      entry({ name: "dark-mode", memoryType: "preference" }),
      entry({ name: "runs-taipei", memoryType: "expertise" }),
    ]);
    render();
    await settle();

    clickButton("Preference");
    await settle();

    expect(container.querySelectorAll("h2")).toHaveLength(0);
    expect(container.textContent).toContain("Prefers dark mode.");
  });

  /**
   * Repetition is the signal, so it is shown — but only where it means
   * something. A badge on every row is noise that hides the two rows where the
   * badge matters.
   */
  it("badges a repeatedly-observed entry and leaves a one-off unbadged", async () => {
    mockMemoryApi.list.mockResolvedValue([
      entry({ name: "writes-chinese", timesObserved: 5, content: "Writes updates in Chinese." }),
      entry({ name: "one-off", timesObserved: 1, content: "Mentioned once." }),
    ]);
    render();
    await settle();

    expect(container.textContent).toContain("core");
    expect(container.textContent).not.toContain("confirmed");
  });
});

describe("the capture switch", () => {
  it("pauses capture", async () => {
    render();
    await settle();

    const toggle = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(toggle.checked).toBe(true);

    // A real click, not a hand-set `checked`: React tracks the value itself and
    // ignores a change event whose value it believes it already has.
    flushSync(() => toggle.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await settle();

    expect(mockMemoryApi.setSettings).toHaveBeenCalledWith("company-1", "user-1", {
      captureEnabled: false,
    });
  });

  // Paused has to say so. A switch that is merely off looks like a switch that
  // was never on, and the person stops trusting the empty page instead of the
  // pause they chose.
  it("says plainly that agents are not saving anything", async () => {
    mockMemoryApi.stats.mockResolvedValue({
      total: 2,
      bySource: {},
      byType: {},
      byStrength: { noted: 2, confirmed: 0, core: 0 },
      agentWrites: 0,
      lastAgentWriteAt: null,
      deleted: 0,
      captureEnabled: false,
    });
    render();
    await settle();

    expect(container.textContent).toContain("Capture is paused");
  });
});

describe("recovering a deleted memory", () => {
  it("stays out of the way until there is something to recover", async () => {
    render();
    await settle();

    expect(container.textContent).not.toContain("Recently deleted");
  });

  it("offers restore and delete-forever once opened", async () => {
    mockMemoryApi.stats.mockResolvedValue({
      total: 1,
      bySource: {},
      byType: {},
      byStrength: { noted: 1, confirmed: 0, core: 0 },
      agentWrites: 0,
      lastAgentWriteAt: null,
      deleted: 1,
      captureEnabled: true,
    });
    mockMemoryApi.deleted.mockResolvedValue([
      entry({ name: "old-note", content: "Something removed.", deletedAt: "2026-08-01T00:00:00.000Z" }),
    ]);
    render();
    await settle();

    clickButton("Recently deleted (1)");
    await settle();

    expect(container.textContent).toContain("Something removed.");

    const restore = container.querySelector('button[aria-label="Restore"]');
    flushSync(() => restore!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await settle();

    expect(mockMemoryApi.restore).toHaveBeenCalledWith("company-1", "user-1", "old-note");
  });

  /**
   * The irreversible button lives only in the recovery drawer. Everywhere else,
   * deleting has to be the cheap, undoable action — that is what keeps people
   * willing to correct memory instead of ignoring it.
   */
  it("only offers a purge from inside the drawer", async () => {
    mockMemoryApi.list.mockResolvedValue([entry()]);
    render();
    await settle();

    expect(container.querySelector('button[aria-label="Delete forever"]')).toBeNull();

    const forget = container.querySelector('button[aria-label="Forget"]');
    flushSync(() => forget!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await settle();

    expect(mockMemoryApi.remove).toHaveBeenCalledWith("company-1", "user-1", "likes-dark-mode", {
      purge: undefined,
    });
  });
});
