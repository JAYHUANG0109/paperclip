// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildNewAgentHirePayload } from "./new-agent-hire-payload";
import { defaultCreateValues } from "../components/agent-config-defaults";

describe("buildNewAgentHirePayload", () => {
  it("persists the selected default environment id", () => {
    expect(
      buildNewAgentHirePayload({
        name: "Linux Claude",
        effectiveRole: "general",
        configValues: {
          ...defaultCreateValues,
          adapterType: "claude_local",
          defaultEnvironmentId: "11111111-1111-4111-8111-111111111111",
        },
        adapterConfig: { foo: "bar" },
      }),
    ).toMatchObject({
      name: "Linux Claude",
      role: "general",
      adapterType: "claude_local",
      defaultEnvironmentId: "11111111-1111-4111-8111-111111111111",
      adapterConfig: { foo: "bar" },
      budgetMonthlyCents: 0,
    });
  });

  it("sends null when no default environment is selected", () => {
    expect(
      buildNewAgentHirePayload({
        name: "Local Claude",
        effectiveRole: "general",
        configValues: {
          ...defaultCreateValues,
          adapterType: "claude_local",
        },
        adapterConfig: {},
      }),
    ).toMatchObject({
      defaultEnvironmentId: null,
    });
  });

  it("includes core trust preset permissions when provided", () => {
    expect(
      buildNewAgentHirePayload({
        name: "PR Reviewer",
        effectiveRole: "engineer",
        configValues: {
          ...defaultCreateValues,
          adapterType: "codex_local",
        },
        adapterConfig: {},
        permissions: {
          canCreateAgents: false,
          trustPreset: "low_trust_review",
          authorizationPolicy: {
            trustPreset: "low_trust_review",
            reviewPreset: {
              id: "low_trust_review",
              version: 1,
              rawOutputDisposition: "quarantine",
            },
            trustBoundary: {
              mode: "low_trust_review",
              companyId: "company-1",
              rootIssueId: "issue-root",
            },
          },
        },
      }),
    ).toMatchObject({
      permissions: {
        canCreateAgents: false,
        trustPreset: "low_trust_review",
        authorizationPolicy: {
          trustPreset: "low_trust_review",
          reviewPreset: {
            id: "low_trust_review",
            version: 1,
            rawOutputDisposition: "quarantine",
          },
          trustBoundary: {
            mode: "low_trust_review",
            companyId: "company-1",
            rootIssueId: "issue-root",
          },
        },
      },
    });
  });

  describe("owner email", () => {
    function build(ownerEmail?: string | null) {
      return buildNewAgentHirePayload({
        name: "Agent",
        effectiveRole: "general",
        configValues: { ...defaultCreateValues, adapterType: "claude_local" },
        adapterConfig: { model: "claude-sonnet-5" },
        ownerEmail,
      });
    }

    // This is the whole point of the field: the email is what sign-in matches to
    // claim the agent for that person, so creating with it set replaces mapping
    // the agent to a user by hand afterwards.
    it("persists the owner email as adapterConfig.assignedUserEmail", () => {
      expect(build("a0001057@seasonart.org").adapterConfig).toEqual({
        model: "claude-sonnet-5",
        assignedUserEmail: "a0001057@seasonart.org",
      });
    });

    it("normalizes case and padding so a re-typed address still matches at sign-in", () => {
      expect(
        (build("  A0001057@SeasonArt.org ").adapterConfig as Record<string, unknown>)
          .assignedUserEmail,
      ).toBe("a0001057@seasonart.org");
    });

    // A create form must not be able to hand out elevated roles: "owner" also
    // confers instance_admin at sign-in, so the role is left unset and sign-in's
    // own "operator" default applies.
    it("never sets assignedUserRole", () => {
      expect(build("a0001057@seasonart.org").adapterConfig)
        .not.toHaveProperty("assignedUserRole");
    });

    it.each([undefined, null, "", "   "])("leaves adapterConfig untouched for %p", (value) => {
      expect(build(value).adapterConfig).toEqual({ model: "claude-sonnet-5" });
    });
  });
});
