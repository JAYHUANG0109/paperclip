// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CompanyEnvironments } from "./CompanyEnvironments";

const mockEnvironmentsApi = vi.hoisted(() => ({
  list: vi.fn(),
  capabilities: vi.fn(),
  probe: vi.fn(),
  probeConfig: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  setDefault: vi.fn(),
}));
const mockInstanceSettingsApi = vi.hoisted(() => ({
  get: vi.fn(),
  getExperimental: vi.fn(),
}));
const mockSecretsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Paperclip" },
  }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));

vi.mock("@/api/environments", () => ({
  environmentsApi: mockEnvironmentsApi,
}));

vi.mock("@/api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("@/api/secrets", () => ({
  secretsApi: mockSecretsApi,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
// Minimal Radix dialog dependency for jsdom.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

async function act(callback: () => void | Promise<void>) {
  await callback();
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function flushReact() {
  for (let i = 0; i < 3; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
}

function testProviderButtons(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll("button")).filter((button) => {
    const label = button.textContent?.trim();
    return label === "Test provider" || label === "Testing...";
  });
}

function findButton(root: ParentNode, label: string): HTMLButtonElement | undefined {
  return Array.from(root.querySelectorAll("button")).find((button) => button.textContent?.trim() === label);
}

function getOpenDialog(): HTMLElement | null {
  return document.body.querySelector("[role='dialog']");
}

describe("CompanyEnvironments — test provider button", () => {
  let container: HTMLDivElement;
  let probeResolvers: Map<string, () => void>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    probeResolvers = new Map();
    mockInstanceSettingsApi.get.mockResolvedValue({ defaultEnvironmentId: null });
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableEnvironments: true });
    mockEnvironmentsApi.capabilities.mockResolvedValue({ adapters: [], sandboxProviders: {} });
    mockSecretsApi.list.mockResolvedValue([]);
    mockEnvironmentsApi.list.mockResolvedValue([
      { id: "env-1", name: "Alpha", driver: "sandbox", description: null, config: { provider: "e2b" } },
      { id: "env-2", name: "Beta", driver: "sandbox", description: null, config: { provider: "e2b" } },
    ]);
    mockEnvironmentsApi.create.mockImplementation(async (_companyId: string, body: { name: string }) => ({
      id: "env-new",
      name: body.name,
      driver: "ssh",
      description: null,
      config: {},
    }));
    mockEnvironmentsApi.update.mockImplementation(async (environmentId: string, body: { name: string }) => ({
      id: environmentId,
      name: body.name,
      driver: "sandbox",
      description: null,
      config: { provider: "e2b" },
    }));
    // Each probe stays pending until its resolver is called, so the testing
    // state remains observable and can be settled per environment.
    mockEnvironmentsApi.probe.mockImplementation(
      (environmentId: string) =>
        new Promise<{ ok: boolean; driver: string; summary: string; details: null }>((resolve) => {
          probeResolvers.set(environmentId, () =>
            resolve({ ok: true, driver: "sandbox", summary: "ok", details: null }),
          );
        }),
    );
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("shows the testing state on all buttons when a probe is in flight", async () => {
    // The component uses a single shared mutation; while any probe is pending
    // isPending is true globally, so every "Test provider" button becomes
    // "Testing..." and disabled — not just the one that was clicked.
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <CompanyEnvironments />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();

    const buttonsBefore = testProviderButtons(container);
    expect(buttonsBefore).toHaveLength(2);
    expect(buttonsBefore.every((button) => button.textContent?.trim() === "Test provider")).toBe(true);
    expect(buttonsBefore.every((button) => !button.disabled)).toBe(true);

    await act(async () => {
      buttonsBefore[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    // After clicking env-1, the shared mutation is pending — all buttons
    // enter the testing state simultaneously.
    const buttonsAfter = testProviderButtons(container);
    expect(buttonsAfter).toHaveLength(2);
    expect(buttonsAfter[0].textContent?.trim()).toBe("Testing...");
    expect(buttonsAfter[0].disabled).toBe(true);
    expect(buttonsAfter[1].textContent?.trim()).toBe("Testing...");
    expect(buttonsAfter[1].disabled).toBe(true);
    expect(mockEnvironmentsApi.probe).toHaveBeenCalledExactlyOnceWith("env-1");
  });

  it("returns buttons to idle state after the probe resolves", async () => {
    // The component uses a shared mutation; once the in-flight probe settles
    // all buttons return to their idle ("Test provider") state.
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <CompanyEnvironments />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();

    // Click the first environment's probe button.
    await act(async () => {
      testProviderButtons(container)[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    // Both buttons are in testing state while the probe is pending.
    expect(testProviderButtons(container).every((b) => b.textContent?.trim() === "Testing...")).toBe(true);

    // Settle the first environment's probe.
    await act(async () => {
      probeResolvers.get("env-1")?.();
    });
    await flushReact();

    // After the probe resolves the shared mutation is no longer pending;
    // all buttons return to the idle label.
    const buttons = testProviderButtons(container);
    expect(buttons.every((b) => b.textContent?.trim() === "Test provider")).toBe(true);
    expect(buttons.every((b) => !b.disabled)).toBe(true);
  });

  it("shows the add-environment inline form by default and reveals cancel only when editing", async () => {
    // The component renders the environment form inline (no dialog). In the
    // default add state the heading reads "Add environment" and there is no
    // Cancel button. Cancel only appears after clicking Edit on a saved env,
    // and clicking it resets the form back to the add state.
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <CompanyEnvironments />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();

    // Default state: "Add environment" heading is visible, no Cancel button.
    expect(container.textContent).toContain("Add environment");
    expect(findButton(container, "Cancel")).toBeUndefined();

    // Enter edit mode for the first environment.
    await act(async () => {
      findButton(container, "Edit")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    // Now the form heading switches to "Edit environment" and Cancel appears.
    expect(container.textContent).toContain("Edit environment");
    expect(findButton(container, "Cancel")).toBeDefined();

    // Clicking Cancel reverts to the add state.
    await act(async () => {
      findButton(container, "Cancel")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(container.textContent).toContain("Add environment");
    expect(findButton(container, "Cancel")).toBeUndefined();
  });

  it("populates the inline edit form with existing values and submits on save", async () => {
    // The component renders the environment form inline (no dialog). Clicking
    // the Edit button for an environment populates the shared form with that
    // environment's values, switches the heading to "Edit environment", and
    // swaps the submit button to "Save environment". After save the API is
    // called and the form resets to the add state.
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <CompanyEnvironments />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();

    await act(async () => {
      findButton(container, "Edit")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    // The inline form should reflect the first environment's name ("Alpha").
    expect(container.textContent).toContain("Edit environment");
    expect(
      Array.from(container.querySelectorAll("input")).some((input) => (input as HTMLInputElement).value === "Alpha"),
    ).toBe(true);

    await act(async () => {
      findButton(container, "Save environment")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockEnvironmentsApi.update).toHaveBeenCalledExactlyOnceWith(
      "env-1",
      expect.objectContaining({ name: "Alpha", driver: "sandbox" }),
    );
    // After a successful save the form reverts to the add state.
    expect(container.textContent).toContain("Add environment");
  });
});
