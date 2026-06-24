import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agentMemberships, agents, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent visibility tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type ActorRole = "owner" | "admin" | "operator" | "viewer";

function boardActor(
  companyId: string,
  opts: { role?: ActorRole; userId?: string; isInstanceAdmin?: boolean } = {},
) {
  const role = opts.role ?? "operator";
  return {
    type: "board" as const,
    userId: opts.userId ?? "user-1",
    source: "session" as const,
    isInstanceAdmin: Boolean(opts.isInstanceAdmin),
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: role, status: "active" }],
  };
}

function createApp(db: ReturnType<typeof createDb>, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", agentRoutes(db, { restrictAgentVisibility: true }));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("agent visibility routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-visibility-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agentMemberships);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentA = randomUUID();
    const agentB = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: agentA,
        companyId,
        name: "AgentA",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: agentB,
        companyId,
        name: "AgentB",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    return { companyId, agentA, agentB };
  }

  async function join(companyId: string, agentId: string, userId: string) {
    await db.insert(agentMemberships).values({ companyId, agentId, userId, state: "joined" });
  }

  it("limits a non-privileged user to agents they have joined (list)", async () => {
    const { companyId, agentA } = await seed();
    await join(companyId, agentA, "user-1");
    const app = createApp(db, boardActor(companyId, { role: "operator" }));

    const res = await request(app).get(`/api/companies/${companyId}/agents`);

    expect(res.status).toBe(200);
    expect(res.body.map((a: { id: string }) => a.id)).toEqual([agentA]);
  });

  it("shows no agents to a non-privileged user with no memberships", async () => {
    const { companyId } = await seed();
    const app = createApp(db, boardActor(companyId, { role: "operator" }));

    const res = await request(app).get(`/api/companies/${companyId}/agents`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("hides an un-joined agent's detail as 404 for a non-privileged user", async () => {
    const { companyId, agentA, agentB } = await seed();
    await join(companyId, agentA, "user-1");
    const app = createApp(db, boardActor(companyId, { role: "operator" }));

    const ownRes = await request(app).get(`/api/agents/${agentA}`);
    const otherRes = await request(app).get(`/api/agents/${agentB}`);

    expect(ownRes.status).toBe(200);
    expect(otherRes.status).toBe(404);
  });

  it("lets a company admin see every agent regardless of membership", async () => {
    const { companyId, agentA, agentB } = await seed();
    const app = createApp(db, boardActor(companyId, { role: "admin" }));

    const list = await request(app).get(`/api/companies/${companyId}/agents`);
    const detail = await request(app).get(`/api/agents/${agentB}`);

    expect(list.status).toBe(200);
    expect(list.body.map((a: { id: string }) => a.id).sort()).toEqual([agentA, agentB].sort());
    expect(detail.status).toBe(200);
  });

  it("lets an instance admin see every agent regardless of membership", async () => {
    const { companyId, agentA, agentB } = await seed();
    const app = createApp(db, boardActor(companyId, { role: "viewer", isInstanceAdmin: true }));

    const list = await request(app).get(`/api/companies/${companyId}/agents`);

    expect(list.status).toBe(200);
    expect(list.body.map((a: { id: string }) => a.id).sort()).toEqual([agentA, agentB].sort());
  });
});
