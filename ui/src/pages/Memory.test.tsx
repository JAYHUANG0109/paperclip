// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockMemoryApi = vi.hoisted(() => ({
  list: vi.fn(),
  save: vi.fn(),
  remove: vi.fn(),
  import: vi.fn(),
}));

const mockAccessApi = vi.hoisted(() => ({ getCurrentBoardAccess: vi.fn() }));

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
  mockMemoryApi.import.mockResolvedValue({ imported: [], skipped: [] });
});

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
