import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agentMemberships, agents, companies, createDb, issues } from "@paperclipai/db";
import type { LiveEvent } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createBoardUserEventFilter } from "../realtime/live-event-visibility.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres live-event visibility tests: ${embeddedPostgresSupport.reason ?? "unsupported"}`,
  );
}

function event(type: LiveEvent["type"], payload: Record<string, unknown>): LiveEvent {
  return { id: 1, companyId: "c", type, createdAt: new Date().toISOString(), payload };
}

describeEmbeddedPostgres("createBoardUserEventFilter", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const companyId = randomUUID();
  const userId = "user-teacher-1";
  const joinedAgentId = randomUUID();
  const otherAgentId = randomUUID();
  const issueOfOtherAgentId = randomUUID();
  // A report of the joined (manager) agent — hierarchical visibility.
  const reportAgentId = randomUUID();
  const grandReportAgentId = randomUUID();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-live-visibility-");
    db = createDb(tempDb.connectionString);

    await db.insert(companies).values({
      id: companyId,
      name: "Seasonarts",
      issuePrefix: "SEAAA",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      { id: joinedAgentId, companyId, name: "MyAgent", role: "assistant", status: "active", adapterType: "claude_local", adapterConfig: {} },
      { id: otherAgentId, companyId, name: "OtherAgent", role: "assistant", status: "active", adapterType: "claude_local", adapterConfig: {} },
      { id: reportAgentId, companyId, name: "ReportAgent", role: "assistant", status: "active", adapterType: "claude_local", adapterConfig: {}, reportsTo: joinedAgentId },
      { id: grandReportAgentId, companyId, name: "GrandReportAgent", role: "assistant", status: "active", adapterType: "claude_local", adapterConfig: {}, reportsTo: reportAgentId },
    ]);
    await db.insert(agentMemberships).values({
      companyId,
      agentId: joinedAgentId,
      userId,
      state: "joined",
    });
    await db.insert(issues).values({
      id: issueOfOtherAgentId,
      companyId,
      identifier: "SEAAA-999",
      title: "Other agent's issue",
      assigneeAgentId: otherAgentId,
    });
  }, 20_000);

  afterEach(() => {});

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("forwards events for a joined agent", async () => {
    const filter = createBoardUserEventFilter(db, companyId, userId);
    expect(await filter(event("heartbeat.run.status", { agentId: joinedAgentId, runId: "r1" }))).toBe(true);
  });

  it("forwards events for agents that report (transitively) to a joined agent", async () => {
    const filter = createBoardUserEventFilter(db, companyId, userId);
    expect(await filter(event("heartbeat.run.status", { agentId: reportAgentId, runId: "r3" }))).toBe(true);
    expect(await filter(event("heartbeat.run.status", { agentId: grandReportAgentId, runId: "r4" }))).toBe(true);
  });

  it("drops events for an agent the user has not joined", async () => {
    const filter = createBoardUserEventFilter(db, companyId, userId);
    expect(await filter(event("heartbeat.run.status", { agentId: otherAgentId, runId: "r2" }))).toBe(false);
    expect(
      await filter(
        event("activity.logged", { actorType: "agent", actorId: otherAgentId, agentId: otherAgentId, action: "issue.comment_added", entityType: "issue", entityId: issueOfOtherAgentId }),
      ),
    ).toBe(false);
  });

  it("drops issue activity (no agentId) when the issue belongs to an unseen agent", async () => {
    const filter = createBoardUserEventFilter(db, companyId, userId);
    expect(
      await filter(
        event("activity.logged", { actorType: "user", actorId: "someone-else", action: "issue.updated", entityType: "issue", entityId: issueOfOtherAgentId }),
      ),
    ).toBe(false);
  });

  it("always forwards the user's own actions", async () => {
    const filter = createBoardUserEventFilter(db, companyId, userId);
    expect(
      await filter(
        event("activity.logged", { actorType: "user", actorId: userId, action: "issue.updated", entityType: "issue", entityId: issueOfOtherAgentId }),
      ),
    ).toBe(true);
  });
});
