// @vitest-environment jsdom

// Guards the audit consolidation at the route-table level. /audit no longer has a
// page of its own — it redirects into the `agents` tier of the merged Activity
// page. That redirect is load-bearing: the sidebar's Audit item, plus every
// existing bookmark and deep link, goes through it. It is also easy to get
// subtly wrong, because a route-relative `../activity` and an absolute
// `/activity` resolve differently under the company-prefix layer. So drive the
// real <App> route table rather than trusting the JSX by inspection.

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

// jsdom's CSS parser rejects the custom-property marker rule stitches inserts
// (`--sxs{--sxs:N}`), pulled into <App>'s eager import graph transitively via
// @codesandbox/sandpack-react. Substitute a benign, valid rule on parse failure
// so stitches' index bookkeeping stays intact and the module graph evaluates.
vi.hoisted(() => {
  const sheetProto = window.CSSStyleSheet.prototype as unknown as {
    insertRule: (rule: string, index?: number) => number;
    __papActivityRoutingPatched?: boolean;
  };
  if (!sheetProto.__papActivityRoutingPatched) {
    const original = sheetProto.insertRule;
    sheetProto.insertRule = function patched(this: CSSStyleSheet, rule: string, index?: number) {
      try {
        return original.call(this, rule, index);
      } catch {
        try {
          return original.call(this, ".pap-activity-routing-noop{}", index);
        } catch {
          return this.cssRules?.length ?? 0;
        }
      }
    };
    sheetProto.__papActivityRoutingPatched = true;
  }
});

// Real Layout renders the whole authenticated shell; for routing we only need it
// to resolve :companyPrefix and render nested routes.
vi.mock("./components/Layout", async () => {
  const { Outlet } = await import("react-router-dom");
  return { Layout: () => <Outlet /> };
});

vi.mock("./components/CloudAccessGate", async () => {
  const { Outlet } = await import("react-router-dom");
  return { CloudAccessGate: () => <Outlet /> };
});

vi.mock("./components/OnboardingWizardVariant", () => ({
  OnboardingWizardVariant: () => null,
}));

// Sentinel that echoes the router's resolved location, so we assert the exact
// path and tier the redirect lands on — not merely that *a* page rendered. It
// must read react-router's location, not window.location: MemoryRouter navigates
// its own history and never touches the jsdom URL.
vi.mock("./pages/audit/CompanyActivity", async () => {
  const { useLocation } = await import("react-router-dom");
  return {
    CompanyActivity: () => {
      const { pathname, search } = useLocation();
      return <div>ACTIVITY_PAGE at {pathname}{search}</div>;
    },
  };
});

const PAP_COMPANY = {
  id: "company-1",
  name: "Paperclip",
  issuePrefix: "PAP",
  status: "active",
};
vi.mock("./context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [PAP_COMPANY],
    selectedCompanyId: PAP_COMPANY.id,
    selectedCompany: PAP_COMPANY,
    loading: false,
  }),
  CompanyProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

// Every page here is a lazyPage(), so the first render suspends to <App>'s outer
// Suspense boundary (Layout's finer boundary is mocked away). Hand-rolled
// flushSync + setTimeout draining commits the fallback but never resumes the
// dynamic import — the container then sits on the loading spinner forever, which
// reads as "this route is broken". act() owns the whole suspend/resume cycle, so
// use it rather than guessing at turn counts.
async function renderAppAt(container: HTMLElement, path: string) {
  const root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return root;
}

// CompanyActivity is a lazyPage(), so it arrives via a dynamic import and one
// Suspense boundary — and /audit adds a redirect hop on top. Flush microtasks and
// macrotasks together, generously, rather than assuming a fixed number of turns.
async function waitForRoute(container: HTMLElement, text: string) {
  for (let attempt = 0; attempt < 10 && !container.textContent?.includes(text); attempt += 1) {
    // A redirect adds a navigation hop on top of the lazy import, so drain again.
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
  expect(container.textContent).toContain(text);
}

describe("App activity/audit routing (audit consolidation)", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("serves the merged Activity page on the company-prefixed activity route", async () => {
    const root = await renderAppAt(container, "/PAP/activity");
    await waitForRoute(container, "ACTIVITY_PAGE at /PAP/activity");
    await act(async () => root.unmount());
  });

  it("redirects the company-prefixed audit route into the agents tier", async () => {
    const root = await renderAppAt(container, "/PAP/audit");
    // Assert the exact destination, including ?mode=agents. An absence-of-404
    // check would pass on an empty render, and a route-relative `../activity`
    // target would bypass the company-prefix layer and resolve wrong.
    await waitForRoute(container, "ACTIVITY_PAGE at /PAP/activity?mode=agents");
    await act(async () => root.unmount());
  });

  // In-app links can't produce these: Link/NavLink/Navigate all run through
  // applyCompanyPrefix. They arrive typed, bookmarked or pasted, and before the
  // UnprefixedBoardRedirect entries existed they 404'd as "no company matches
  // ACTIVITY" — both roots are in BOARD_ROUTE_ROOTS but had no redirect route.
  it("prefixes an unprefixed /activity URL from outside the app", async () => {
    const root = await renderAppAt(container, "/activity");
    await waitForRoute(container, "ACTIVITY_PAGE at /PAP/activity");
    expect(container.textContent).not.toContain("No company matches prefix");
    await act(async () => root.unmount());
  });

  it("prefixes an unprefixed /audit URL and keeps it on the agents tier", async () => {
    const root = await renderAppAt(container, "/audit");
    await waitForRoute(container, "ACTIVITY_PAGE at /PAP/activity?mode=agents");
    await act(async () => root.unmount());
  });
});
