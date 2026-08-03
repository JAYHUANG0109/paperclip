// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionsStatus } from "../api/dashboard";

const mockDashboardApi = vi.hoisted(() => ({ connections: vi.fn() }));

vi.mock("../api/dashboard", () => ({ dashboardApi: mockDashboardApi }));
vi.mock("@/i18n", () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? "",
  }),
}));

const { ConnectionsCard } = await import("./ConnectionsCard");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((r) => window.setTimeout(r, 0));
  });
}

async function render(status: ConnectionsStatus) {
  mockDashboardApi.connections.mockResolvedValue(status);
  container = document.createElement("div");
  document.body.appendChild(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <ConnectionsCard companyId="c1" />
      </QueryClientProvider>,
    );
  });
  await flush();
  return container!;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.clearAllMocks();
});

describe("ConnectionsCard", () => {
  it("shows both Asana and Odoo rows with connected status and Odoo login/db", async () => {
    const el = await render({
      agentLinked: true,
      asana: { connected: true },
      odoo: { connected: true, login: "jay@seasonart.org", url: "https://eip.seasonarts.ltd", db: "eip" },
    });
    expect(el.textContent).toContain("Asana");
    expect(el.textContent).toContain("Odoo");
    // Odoo detail concatenates the db (" · eip") outside the translation call.
    expect(el.textContent).toContain("· eip");
    // Two connected rows → two green status dots.
    expect(el.querySelectorAll("span.bg-green-500").length).toBe(2);
  });

  it("shows a not-connected Odoo row when no key is stored", async () => {
    const el = await render({
      agentLinked: true,
      asana: { connected: true },
      odoo: { connected: false },
    });
    expect(el.textContent).toContain("Not connected");
    // Asana connected (green), Odoo not (muted) → exactly one green dot.
    expect(el.querySelectorAll("span.bg-green-500").length).toBe(1);
  });

  it("renders nothing until the signed-in user has their own agent", async () => {
    const el = await render({
      agentLinked: false,
      asana: { connected: false },
      odoo: { connected: false },
    });
    expect(el.textContent).toBe("");
  });
});
