import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { getOnboardingForAgent, ONBOARDING_KANS } from "./onboarding.js";

/**
 * Minimal fake for the single `db.select({...}).from(agents).where(...)` read
 * getOnboardingForAgent performs. `rows` is what that query resolves to (an
 * array of `{ metadata }`); an empty array models "agent not found".
 */
function fakeDb(rows: Array<{ metadata: unknown }>): Db {
  return {
    select: () => ({ from: () => ({ where: () => Promise.resolve(rows) }) }),
  } as unknown as Db;
}

function onboardingMeta(overrides: Record<string, unknown> = {}) {
  return {
    metadata: {
      onboarding: {
        stage: 1,
        total: ONBOARDING_KANS.length,
        completedKeys: [],
        status: "in_progress",
        ...overrides,
      },
    },
  };
}

describe("getOnboardingForAgent", () => {
  it("returns null when the agent row is missing", async () => {
    expect(await getOnboardingForAgent(fakeDb([]), "a1")).toBeNull();
  });

  it("returns null when the agent has no onboarding metadata", async () => {
    expect(await getOnboardingForAgent(fakeDb([{ metadata: {} }]), "a1")).toBeNull();
    expect(await getOnboardingForAgent(fakeDb([{ metadata: null }]), "a1")).toBeNull();
  });

  it("serializes a fresh agent: all 5 steps, first is current, none done", async () => {
    const view = await getOnboardingForAgent(fakeDb([onboardingMeta()]), "a1");
    expect(view).not.toBeNull();
    expect(view!.available).toBe(true);
    expect(view!.status).toBe("in_progress");
    expect(view!.steps).toHaveLength(5);
    expect(view!.steps.map((s) => s.key)).toEqual(ONBOARDING_KANS.map((k) => k.key));
    expect(view!.steps.every((s) => !s.done)).toBe(true);
    // The current step is the first one (setup).
    expect(view!.steps[0]!.current).toBe(true);
    expect(view!.steps[0]!.key).toBe("setup");
    expect(view!.steps.filter((s) => s.current)).toHaveLength(1);
  });

  it("marks cleared 關卡 done and advances `current` to the first open step", async () => {
    const view = await getOnboardingForAgent(
      fakeDb([onboardingMeta({ completedKeys: ["setup"], stage: 2 })]),
      "a1",
    );
    const setup = view!.steps.find((s) => s.key === "setup")!;
    const firstTask = view!.steps.find((s) => s.key === "first-task")!;
    expect(setup.done).toBe(true);
    expect(setup.current).toBe(false);
    expect(firstTask.done).toBe(false);
    expect(firstTask.current).toBe(true);
    // Exactly one current step at a time.
    expect(view!.steps.filter((s) => s.current)).toHaveLength(1);
  });

  it("passes through a finished onboarding with no current step", async () => {
    const allKeys = ONBOARDING_KANS.map((k) => k.key);
    const view = await getOnboardingForAgent(
      fakeDb([onboardingMeta({ completedKeys: allKeys, status: "done", stage: 5 })]),
      "a1",
    );
    expect(view!.status).toBe("done");
    expect(view!.steps.every((s) => s.done)).toBe(true);
    // No open step → nothing marked current.
    expect(view!.steps.some((s) => s.current)).toBe(false);
  });

  it("carries each 關卡's catalog title and description onto its step", async () => {
    const view = await getOnboardingForAgent(fakeDb([onboardingMeta()]), "a1");
    for (const kan of ONBOARDING_KANS) {
      const step = view!.steps.find((s) => s.key === kan.key)!;
      expect(step.title).toBe(kan.title);
      expect(step.desc).toBe(kan.desc);
    }
  });
});
