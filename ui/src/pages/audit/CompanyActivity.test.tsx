// @vitest-environment jsdom

// Guards the audit consolidation: /activity is one page with two tiers, the tier
// lives in ?mode= so links stay shareable, and BOTH tiers stay reachable. The
// fork keeps its own activity list on the `all` tier instead of upstream's
// all-actors feed, so a regression that quietly drops one of them fails here.

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyActivity } from "./CompanyActivity";

const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());

vi.mock("../../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: mockSetBreadcrumbs }),
}));

vi.mock("../../context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: false }),
}));

// The two tiers are mocked to their identity: this test is about which one the
// page mounts for a given ?mode=, not about how either renders.
vi.mock("../Activity", () => ({
  Activity: ({ embedded }: { embedded?: boolean }) => (
    <div>ACTIVITY_LIST embedded={String(embedded)}</div>
  ),
}));

vi.mock("./AuditFeed", () => ({
  AuditFeed: ({ companyId, hideHeader }: { companyId: string; hideHeader?: boolean }) => (
    <div>AGENT_AUDIT company={companyId} hideHeader={String(hideHeader)}</div>
  ),
}));

function renderAt(container: HTMLElement, path: string) {
  const root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  flushSync(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/activity" element={<CompanyActivity />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return root;
}

describe("CompanyActivity (audit consolidation)", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockSetBreadcrumbs.mockClear();
  });

  afterEach(() => {
    container.remove();
  });

  it("defaults to the fork's activity list, embedded", () => {
    const root = renderAt(container, "/activity");
    expect(container.textContent).toContain("ACTIVITY_LIST embedded=true");
    expect(container.textContent).not.toContain("AGENT_AUDIT");
    flushSync(() => root.unmount());
  });

  it("shows the agent audit tier for ?mode=agents, with its own header suppressed", () => {
    const root = renderAt(container, "/activity?mode=agents");
    expect(container.textContent).toContain("AGENT_AUDIT company=company-1 hideHeader=true");
    expect(container.textContent).not.toContain("ACTIVITY_LIST");
    flushSync(() => root.unmount());
  });

  it("falls back to the activity list for an unrecognized mode", () => {
    const root = renderAt(container, "/activity?mode=bogus");
    expect(container.textContent).toContain("ACTIVITY_LIST");
    expect(container.textContent).not.toContain("AGENT_AUDIT");
    flushSync(() => root.unmount());
  });

  it("offers both tiers regardless of the caller's audit grant", () => {
    // The agents tab is never hidden: AuditFeed is server-authoritative and
    // renders its own permission-denied state. Hiding the tab would leak grant
    // state into the nav.
    const root = renderAt(container, "/activity");
    expect(container.textContent).toContain("All activity");
    expect(container.textContent).toContain("Agent audit");
    flushSync(() => root.unmount());
  });

  it("sets the Activity breadcrumb once, on the page rather than either tier", () => {
    const root = renderAt(container, "/activity?mode=agents");
    expect(mockSetBreadcrumbs).toHaveBeenCalled();
    flushSync(() => root.unmount());
  });
});
