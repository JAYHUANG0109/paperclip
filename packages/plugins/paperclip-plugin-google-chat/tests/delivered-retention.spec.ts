import { describe, expect, it, vi } from "vitest";
import {
  DELIVERED_ISSUE_CAP,
  dropDelivered,
  getDelivered,
  saveDelivered,
} from "../src/worker.js";

/**
 * The leak this guards.
 *
 * DELIVERED_CAP bounded the SIZE of each `delivered:<issueId>` record, so the
 * growth looked handled. Nothing bounded the NUMBER of records: every issue that
 * ever mirrored a comment kept an instance-scoped row for good, because a
 * conversation ends by simply never being mentioned again — there was no code
 * path that deleted one. The live instance held 3,939 rows / 1.2 MB, rising with
 * every task.
 *
 * It stayed invisible because no test asserted a ceiling; each record was
 * individually well-behaved. So this suite asserts the ceiling itself.
 */

/** In-memory stand-in for ctx.state — exact-key get/set/delete, no list (as in the real client). */
function makeCtx() {
  const rows = new Map<string, unknown>();
  const keyOf = (input: { stateKey: string }) => input.stateKey;
  const ctx = {
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    state: {
      get: vi.fn(async (input: { stateKey: string }) => rows.get(keyOf(input)) ?? null),
      set: vi.fn(async (input: { stateKey: string }, value: unknown) => {
        rows.set(keyOf(input), value);
      }),
      delete: vi.fn(async (input: { stateKey: string }) => {
        rows.delete(keyOf(input));
      }),
    },
  };
  const deliveredRows = () => [...rows.keys()].filter((k) => k.startsWith("delivered:") && k !== "delivered:index");
  return { ctx, rows, deliveredRows };
}

describe("delivered record retention", () => {
  it("keeps at most DELIVERED_ISSUE_CAP records no matter how many issues deliver", async () => {
    const { ctx, deliveredRows } = makeCtx();

    // Twice the cap, i.e. the shape of the real leak: many short conversations.
    for (let i = 0; i < DELIVERED_ISSUE_CAP * 2; i += 1) {
      await saveDelivered(ctx as never, `issue-${i}`, { ids: [`c-${i}`], sigs: [`s-${i}`] });
    }

    expect(deliveredRows()).toHaveLength(DELIVERED_ISSUE_CAP);
  });

  it("evicts the least-recently-delivered issue, not an active one", async () => {
    const { ctx, rows } = makeCtx();

    await saveDelivered(ctx as never, "old-but-active", { ids: ["a"], sigs: ["s"] });
    for (let i = 0; i < DELIVERED_ISSUE_CAP - 1; i += 1) {
      await saveDelivered(ctx as never, `filler-${i}`, { ids: [`c-${i}`], sigs: [`s-${i}`] });
    }
    // It speaks again, which must move it off the eviction end of the queue.
    await saveDelivered(ctx as never, "old-but-active", { ids: ["a", "b"], sigs: ["s", "t"] });
    // Now push one more issue in, forcing exactly one eviction.
    await saveDelivered(ctx as never, "newest", { ids: ["z"], sigs: ["z"] });

    expect(rows.has("delivered:old-but-active")).toBe(true);
    expect(rows.has("delivered:filler-0")).toBe(false); // the genuinely stalest one went
    const record = await getDelivered(ctx as never, "old-but-active");
    expect(record.ids).toEqual(["a", "b"]);
  });

  it("drops a record when its conversation is explicitly ended", async () => {
    const { ctx, rows } = makeCtx();

    await saveDelivered(ctx as never, "issue-1", { ids: ["c1"], sigs: ["s1"] });
    expect(rows.has("delivered:issue-1")).toBe(true);

    await dropDelivered(ctx as never, "issue-1");

    expect(rows.has("delivered:issue-1")).toBe(false);
    // ...and the index must not keep pointing at it, or eviction accounting drifts.
    const index = (await ctx.state.get({ stateKey: "delivered:index" })) as { issueIds: string[] } | null;
    expect(index?.issueIds ?? []).not.toContain("issue-1");
  });

  it("still mirrors comments when the state store fails on housekeeping", async () => {
    // Retention must never break the reply a person is waiting for.
    const { ctx } = makeCtx();
    ctx.state.get.mockRejectedValueOnce(new Error("state unavailable"));

    await expect(
      saveDelivered(ctx as never, "issue-1", { ids: ["c1"], sigs: ["s1"] }),
    ).resolves.toBeUndefined();
    expect(ctx.logger.warn).toHaveBeenCalledOnce();
  });
});
