import { beforeEach, describe, expect, it, vi } from "vitest";
import { dismissOnboardingForAgent } from "../services/onboarding.js";

/**
 * Removing the onboarding card without completing it.
 *
 * Small surface, but three of its rules are the kind that get "simplified" away
 * later: dismissing must not claim completion, must not overturn a real
 * completion, and must not delete the tutorial. Each is asserted directly.
 */

const AGENT_ID = "agent-1";
const COMPANY_ID = "company-1";

const state = {
  metadata: null as Record<string, unknown> | null,
  agentUpdates: [] as Array<Record<string, unknown>>,
  projectUpdates: [] as Array<Record<string, unknown>>,
};

/**
 * DB stub distinguishing the two updates by call order: the service always
 * updates the agent first and only then archives the project, so the second
 * update — if there is one — is the archive.
 */
function createDb() {
  let updateCount = 0;
  return {
    select() {
      return {
        from() {
          return {
            where: async () =>
              state.metadata === null
                ? []
                : [{ metadata: state.metadata, companyId: COMPANY_ID }],
          };
        },
      };
    },
    update() {
      updateCount += 1;
      const isAgentUpdate = updateCount === 1;
      return {
        set(values: Record<string, unknown>) {
          (isAgentUpdate ? state.agentUpdates : state.projectUpdates).push(values);
          return { where: async () => undefined };
        },
      };
    },
  } as never;
}

function onboarding(overrides: Record<string, unknown> = {}) {
  return {
    onboarding: {
      stage: 2,
      total: 5,
      completedKeys: ["setup"],
      status: "in_progress",
      projectId: "project-onboarding",
      ...overrides,
    },
  };
}

beforeEach(() => {
  state.metadata = onboarding();
  state.agentUpdates = [];
  state.projectUpdates = [];
  vi.restoreAllMocks();
});

describe("dismissing onboarding", () => {
  it("marks it dismissed rather than done", async () => {
    const result = await dismissOnboardingForAgent(createDb(), AGENT_ID);

    expect(result.dismissed).toBe(true);
    const written = state.agentUpdates[0]?.metadata as { onboarding: Record<string, unknown> };
    expect(written.onboarding.status).toBe("dismissed");
  });

  /**
   * The distinction that makes the whole thing worth having. If dismissing wrote
   * `done`, the only signal telling us whether the tutorial works for the people
   * who need it would be contaminated by everyone who skipped it.
   */
  it("does not invent completed steps", async () => {
    await dismissOnboardingForAgent(createDb(), AGENT_ID);

    const written = state.agentUpdates[0]?.metadata as { onboarding: Record<string, unknown> };
    expect(written.onboarding.completedKeys).toEqual(["setup"]);
    expect(written.onboarding.stage).toBe(2);
  });

  // Archived, not deleted — someone who skips today may want it next month.
  it("archives the tutorial project instead of removing it", async () => {
    await dismissOnboardingForAgent(createDb(), AGENT_ID);

    expect(state.projectUpdates).toHaveLength(1);
    expect(state.projectUpdates[0]?.archivedAt).toBeInstanceOf(Date);
  });

  it("has nothing to archive when onboarding has no project", async () => {
    state.metadata = onboarding({ projectId: null });

    const result = await dismissOnboardingForAgent(createDb(), AGENT_ID);

    expect(result.dismissed).toBe(true);
    expect(state.projectUpdates).toHaveLength(0);
  });

  // Dismissing after finishing would downgrade a real completion and lose it.
  it("refuses to overturn a completed onboarding", async () => {
    state.metadata = onboarding({ status: "done" });

    const result = await dismissOnboardingForAgent(createDb(), AGENT_ID);

    expect(result.dismissed).toBe(false);
    expect(state.agentUpdates).toHaveLength(0);
  });

  it("is idempotent, so a double click writes once", async () => {
    state.metadata = onboarding({ status: "dismissed" });

    const result = await dismissOnboardingForAgent(createDb(), AGENT_ID);

    expect(result.dismissed).toBe(false);
    expect(state.agentUpdates).toHaveLength(0);
  });

  it("does nothing for an agent that was never seeded", async () => {
    state.metadata = {};

    const result = await dismissOnboardingForAgent(createDb(), AGENT_ID);

    expect(result.dismissed).toBe(false);
  });

  it("does nothing for an agent that does not exist", async () => {
    state.metadata = null;

    const result = await dismissOnboardingForAgent(createDb(), AGENT_ID);

    expect(result.dismissed).toBe(false);
  });
});
