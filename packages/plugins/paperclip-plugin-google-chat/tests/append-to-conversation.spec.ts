import { describe, expect, it, vi } from "vitest";
import { appendToConversation } from "../src/routing.js";

/**
 * The bug this guards.
 *
 * `appendToConversation` saved the follow-up comment, flipped the task to
 * "todo", then called requestWakeup inside:
 *
 *   try { await ctx.issues.requestWakeup(...) }
 *   catch { /* scheduler will still pick up the todo issue *\/ }
 *
 * The comment's reasoning is right for a transient failure and wrong for the
 * most common one. requestWakeup refuses with "Issue is blocked by unresolved
 * blockers" (server/src/routes/issues.ts, 409), and a blocked task is precisely
 * what the scheduler will NOT pick up. So the sender's message landed in the
 * task and then nothing happened — no agent run, no reply — while the webhook
 * answered "⏳ 處理中，請稍候…", promising work that was never going to start.
 * Silent, because the catch discarded the reason and the 200 hid it.
 *
 * So: the refusal must reach the caller, which turns it into an honest reply.
 */

function makeCtx(wakeup: () => Promise<void>) {
  const warn = vi.fn();
  const ctx = {
    logger: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    issues: {
      createComment: vi.fn(async () => ({ id: "comment-1" })),
      update: vi.fn(async () => ({})),
      requestWakeup: vi.fn(wakeup),
    },
  };
  return { ctx, warn };
}

const params = {
  issueId: "issue-1",
  companyId: "company-1",
  text: "any update on this?",
  senderEmail: "someone@example.com",
};

describe("appendToConversation", () => {
  it("reports wakeBlocked when the wake is refused for unresolved blockers", async () => {
    const { ctx, warn } = makeCtx(async () => {
      throw new Error("Issue is blocked by unresolved blockers");
    });

    const result = await appendToConversation(ctx as never, params);

    // The comment is still saved — losing the person's message would be worse.
    expect(ctx.issues.createComment).toHaveBeenCalledOnce();
    expect(result.commentId).toBe("comment-1");
    // ...but the caller now knows not to promise that work is underway.
    expect(result.wakeBlocked).toBe(true);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("does not claim blocked for an unrelated wake failure", async () => {
    // A transient failure IS covered by the scheduler, so the reply should stay
    // optimistic; only distinguishing the two makes the honest reply accurate.
    const { ctx, warn } = makeCtx(async () => {
      throw new Error("ECONNRESET");
    });

    const result = await appendToConversation(ctx as never, params);

    expect(result.wakeBlocked).toBe(false);
    expect(result.commentId).toBe("comment-1");
    expect(warn).toHaveBeenCalledOnce(); // logged, not swallowed
  });

  it("returns the comment id and no block on the happy path", async () => {
    const { ctx, warn } = makeCtx(async () => {});

    const result = await appendToConversation(ctx as never, params);

    expect(result).toEqual({ commentId: "comment-1", wakeBlocked: false });
    expect(ctx.issues.update).toHaveBeenCalledWith("issue-1", { status: "todo" }, "company-1");
    expect(warn).not.toHaveBeenCalled();
  });
});
