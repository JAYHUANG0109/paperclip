import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";

/**
 * Pinning must not disturb recency ordering.
 *
 * Task lists sort pinned-first and then by `updatedAt` desc (SidebarMyTasks.tsx,
 * AgentDetail.tsx). While a pin toggle bumped `updatedAt`, unpinning left the issue
 * at the top of the list anyway — it had just become the most-recently-updated one —
 * so users could pin a task but never get it to fall back into place.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue pin ordering tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issueService.update — pin does not disturb recency ordering", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-pin-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedIssue(updatedAt: Date) {
    const companyId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      key: "PIN-1",
      title: "關卡 2｜建立你的第一個任務",
      status: "todo",
      priority: "medium",
      pinned: false,
      createdAt: updatedAt,
      updatedAt,
    });
    return { companyId, issueId };
  }

  const readIssue = async (issueId: string) =>
    (await db.select().from(issues).where(eq(issues.id, issueId)))[0];

  it("preserves updatedAt when pinning and unpinning", async () => {
    const originalUpdatedAt = new Date("2026-07-01T09:00:00.000Z");
    const { issueId } = await seedIssue(originalUpdatedAt);
    const svc = issueService(db);

    await svc.update(issueId, { pinned: true });
    const pinnedRow = await readIssue(issueId);
    expect(pinnedRow.pinned).toBe(true);
    expect(pinnedRow.updatedAt.toISOString()).toBe(originalUpdatedAt.toISOString());

    await svc.update(issueId, { pinned: false });
    const unpinnedRow = await readIssue(issueId);
    expect(unpinnedRow.pinned).toBe(false);
    // The whole point: after unpinning it sorts by its real activity time again,
    // not by the moment someone clicked the pin.
    expect(unpinnedRow.updatedAt.toISOString()).toBe(originalUpdatedAt.toISOString());
  });

  it("still bumps updatedAt when the same patch also changes real content", async () => {
    const originalUpdatedAt = new Date("2026-07-01T09:00:00.000Z");
    const { issueId } = await seedIssue(originalUpdatedAt);
    const svc = issueService(db);

    await svc.update(issueId, { pinned: true, priority: "high" });

    const row = await readIssue(issueId);
    expect(row.pinned).toBe(true);
    expect(row.priority).toBe("high");
    expect(row.updatedAt.getTime()).toBeGreaterThan(originalUpdatedAt.getTime());
  });

  it("still bumps updatedAt for an ordinary edit that never mentions pinned", async () => {
    const originalUpdatedAt = new Date("2026-07-01T09:00:00.000Z");
    const { issueId } = await seedIssue(originalUpdatedAt);
    const svc = issueService(db);

    await svc.update(issueId, { title: "改標題" });

    const row = await readIssue(issueId);
    expect(row.updatedAt.getTime()).toBeGreaterThan(originalUpdatedAt.getTime());
  });

  it("keeps a pinned-then-unpinned issue behind genuinely newer work", async () => {
    // Reproduces the reported symptom end to end: an old task, pinned and then
    // unpinned, must not outrank a task that was actually touched more recently.
    const oldUpdatedAt = new Date("2026-07-01T09:00:00.000Z");
    const { companyId, issueId: oldIssueId } = await seedIssue(oldUpdatedAt);

    const newerIssueId = randomUUID();
    const newerUpdatedAt = new Date("2026-07-20T09:00:00.000Z");
    await db.insert(issues).values({
      id: newerIssueId,
      companyId,
      key: "PIN-2",
      title: "比較新的任務",
      status: "todo",
      priority: "medium",
      pinned: false,
      createdAt: newerUpdatedAt,
      updatedAt: newerUpdatedAt,
    });

    const svc = issueService(db);
    await svc.update(oldIssueId, { pinned: true });
    await svc.update(oldIssueId, { pinned: false });

    const rows = await db.select().from(issues).where(eq(issues.companyId, companyId));
    const sorted = [...rows].sort((a, b) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
      return b.updatedAt.getTime() - a.updatedAt.getTime();
    });

    expect(sorted.map((row) => row.id)).toEqual([newerIssueId, oldIssueId]);
  });
});
