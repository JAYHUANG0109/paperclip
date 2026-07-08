import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApi = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock("./client", () => ({
  api: mockApi,
}));

import { executionWorkspacesApi } from "./execution-workspaces";

describe("executionWorkspacesApi.listSummaries", () => {
  beforeEach(() => {
    mockApi.get.mockReset();
    mockApi.get.mockResolvedValue([]);
  });

  it("requests the lightweight summary payload", async () => {
    await executionWorkspacesApi.listSummaries("company-1", {
      projectId: "project-1",
      reuseEligible: true,
    });

    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/execution-workspaces?projectId=project-1&reuseEligible=true&summary=true",
    );
  });

});

describe("executionWorkspacesApi.reconcile", () => {
  beforeEach(() => {
    mockApi.post.mockReset();
    mockApi.post.mockResolvedValue({});
  });

  // Regression pin (PAP-1705): the frontend path must match the reviewed, OpenAPI-documented
  // backend contract `POST /execution-workspaces/:id/reconcile-branch` (S4 / PAP-1586). A bare
  // `/reconcile` 404s both recovery-card actions. If the two sides drift, this test fails.
  it("posts forward reconcile to the /reconcile-branch route", async () => {
    await executionWorkspacesApi.reconcile("workspace-1", { mode: "forward" });

    expect(mockApi.post).toHaveBeenCalledWith("/execution-workspaces/workspace-1/reconcile-branch", {
      mode: "forward",
    });
  });

  it("posts break-glass override reconcile to the /reconcile-branch route", async () => {
    await executionWorkspacesApi.reconcile("workspace-1", { mode: "override", reason: "operator note" });

    expect(mockApi.post).toHaveBeenCalledWith("/execution-workspaces/workspace-1/reconcile-branch", {
      mode: "override",
      reason: "operator note",
    });
  });
});
