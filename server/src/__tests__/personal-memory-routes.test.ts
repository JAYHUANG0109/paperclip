import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const COMPANY = "22222222-2222-4222-8222-222222222222";
const OWNER = "user-owner";
const OTHER = "user-other";
const OWNER_AGENT = "agent-owner";

const materialize = vi.hoisted(() => vi.fn(async () => ({ dir: "/tmp", written: [], skipped: [] })));
const memoryRows = vi.hoisted(() => ({ current: [] as Array<Record<string, unknown>> }));
const upsertCalls = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const deleteCalls = vi.hoisted(() => [] as Array<Record<string, unknown>>);

// Only the DB access is stubbed. The access rule, the requester resolution and
// the routes are all the real thing — the point of this test is the wiring
// between them, which a mocked service would hide.
vi.mock("../services/personal-memory.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/personal-memory.js")>();
  return {
    ...actual,
    materializeUserMemory: materialize,
    listPersonalMemories: async (_db: unknown, input: Parameters<typeof actual.listPersonalMemories>[1]) => {
      const { canReadPersonalMemory } = await import("../services/personal-memory-access.js");
      return memoryRows.current.filter(
        (row) =>
          row.userId === input.ownerUserId &&
          canReadPersonalMemory({ ownerUserId: row.userId as string }, input.requester),
      ) as never;
    },
    upsertPersonalMemory: async (_db: unknown, input: Parameters<typeof actual.upsertPersonalMemory>[1]) => {
      const { canWritePersonalMemory } = await import("../services/personal-memory-access.js");
      if (!canWritePersonalMemory({ ownerUserId: input.ownerUserId }, input.requester)) return null;
      upsertCalls.push(input as never);
      return { name: input.name, updatedAt: new Date("2026-08-01T00:00:00.000Z") } as never;
    },
    deletePersonalMemory: async (_db: unknown, input: Parameters<typeof actual.deletePersonalMemory>[1]) => {
      const { canWritePersonalMemory } = await import("../services/personal-memory-access.js");
      if (!canWritePersonalMemory({ ownerUserId: input.ownerUserId }, input.requester)) return false;
      deleteCalls.push(input as never);
      return true;
    },
    // The real resolver, over a stub membership table: OWNER_AGENT maps to OWNER.
    requesterForAgent: async (_db: unknown, input: { companyId: string; agentId: string }) => {
      const { resolveAgentMappedUserId } = await import("../services/personal-memory-access.js");
      const rows = [{ agentId: OWNER_AGENT, userId: OWNER, state: "joined" }];
      return { kind: "agent", agentId: input.agentId, mappedUserId: resolveAgentMappedUserId(rows, input.agentId) };
    },
  };
});

vi.mock("./authz.js", async () => ({}));

vi.mock("../routes/authz.js", async () => {
  const { forbidden } = await vi.importActual<typeof import("../errors.js")>("../errors.js");
  return {
    assertCompanyAccess(req: Express.Request, companyId: string) {
      if (req.actor.type === "none") throw forbidden("Authentication required");
      if (req.actor.type === "agent" && req.actor.companyId !== companyId) {
        throw forbidden("Agent key cannot access another company");
      }
    },
    isPrivilegedMemberViewer: (req: Express.Request) => req.actor.isInstanceAdmin === true,
  };
});

const { personalMemoryRoutes } = await import("../routes/personal-memory.js");
const { errorHandler } = await import("../middleware/error-handler.js");

type Actor = Express.Request["actor"];

function createApp(actor: Actor) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use(personalMemoryRoutes({} as never));
  app.use(errorHandler);
  return app;
}

const asOwner: Actor = { type: "board", userId: OWNER, companyIds: [COMPANY], source: "session" };
const asOther: Actor = { type: "board", userId: OTHER, companyIds: [COMPANY], source: "session" };
const asAdmin: Actor = {
  type: "board",
  userId: "user-admin",
  companyIds: [COMPANY],
  isInstanceAdmin: true,
  source: "session",
};
const asOwnerAgent: Actor = { type: "agent", agentId: OWNER_AGENT, companyId: COMPANY, source: "agent_key" };
const asUnmappedAgent: Actor = { type: "agent", agentId: "agent-stray", companyId: COMPANY, source: "agent_key" };

const base = `/companies/${COMPANY}/users/${OWNER}/memories`;

beforeEach(() => {
  memoryRows.current = [
    { userId: OWNER, name: "likes-dark-mode", description: "d", memoryType: "user", content: "c", source: "manual", filePath: null, isBinary: false, updatedAt: new Date() },
  ];
  upsertCalls.length = 0;
  deleteCalls.length = 0;
  materialize.mockClear();
});

describe("reading personal memory", () => {
  it("lets the owner read their own", async () => {
    const res = await request(createApp(asOwner)).get(base);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it("lets an admin read it", async () => {
    const res = await request(createApp(asAdmin)).get(base);

    expect(res.body).toHaveLength(1);
  });

  it("shows another user nothing", async () => {
    const res = await request(createApp(asOther)).get(base);

    expect(res.body).toEqual([]);
  });

  it("lets the owner's agent read it", async () => {
    const res = await request(createApp(asOwnerAgent)).get(base);

    expect(res.body).toHaveLength(1);
  });

  it("shows an unmapped agent nothing", async () => {
    const res = await request(createApp(asUnmappedAgent)).get(base);

    expect(res.body).toEqual([]);
  });

  it("shows the owner's agent nothing when it asks for someone else's memory", async () => {
    memoryRows.current = [{ ...memoryRows.current[0], userId: OTHER }];
    const res = await request(createApp(asOwnerAgent)).get(
      `/companies/${COMPANY}/users/${OTHER}/memories`,
    );

    expect(res.body).toEqual([]);
  });

  it("omits binary content from the listing", async () => {
    memoryRows.current = [{ ...memoryRows.current[0], isBinary: true, content: "AQID" }];
    const res = await request(createApp(asOwner)).get(base);

    expect(res.body[0].content).toBeNull();
    expect(res.body[0].isBinary).toBe(true);
  });
});

describe("writing personal memory", () => {
  it("lets the owner write and re-materializes", async () => {
    const res = await request(createApp(asOwner)).put(`${base}/new-fact`).send({ content: "x" });

    expect(res.status).toBe(200);
    expect(materialize).toHaveBeenCalledWith(expect.anything(), { companyId: COMPANY, userId: OWNER });
  });

  it("lets the owner's agent write, tagged as agent-written", async () => {
    await request(createApp(asOwnerAgent)).put(`${base}/from-agent`).send({ content: "x" });

    expect(upsertCalls[0]).toMatchObject({ source: "agent", createdByAgentId: OWNER_AGENT });
  });

  // Provenance is derived from the actor, never accepted from the body.
  it("ignores a source the caller tries to claim", async () => {
    await request(createApp(asOwner)).put(`${base}/spoofed`).send({ content: "x", source: "agent" });

    expect(upsertCalls[0]).toMatchObject({ source: "manual", createdByAgentId: null });
  });

  // Admins read; they do not rewrite how someone's agent thinks.
  it("refuses an admin write", async () => {
    const res = await request(createApp(asAdmin)).put(`${base}/nope`).send({ content: "x" });

    expect(res.status).toBe(404);
    expect(upsertCalls).toHaveLength(0);
    expect(materialize).not.toHaveBeenCalled();
  });

  it("refuses another user", async () => {
    const res = await request(createApp(asOther)).put(`${base}/nope`).send({ content: "x" });

    expect(res.status).toBe(404);
  });

  it("refuses an unmapped agent", async () => {
    const res = await request(createApp(asUnmappedAgent)).put(`${base}/nope`).send({ content: "x" });

    expect(res.status).toBe(404);
  });

  it("requires content", async () => {
    const res = await request(createApp(asOwner)).put(`${base}/no-body`).send({});

    expect(res.status).toBe(400);
  });
});

describe("deleting personal memory", () => {
  it("lets the owner delete and re-materializes", async () => {
    const res = await request(createApp(asOwner)).delete(`${base}/likes-dark-mode`);

    expect(res.status).toBe(204);
    expect(deleteCalls).toHaveLength(1);
    expect(materialize).toHaveBeenCalled();
  });

  it("refuses another user, without revealing whether the memory exists", async () => {
    const res = await request(createApp(asOther)).delete(`${base}/likes-dark-mode`);

    expect(res.status).toBe(404);
    expect(deleteCalls).toHaveLength(0);
  });
});

describe("cross-tenant", () => {
  it("refuses an agent key from another company", async () => {
    const res = await request(
      createApp({ type: "agent", agentId: OWNER_AGENT, companyId: "other-company", source: "agent_key" }),
    ).get(base);

    expect(res.status).toBe(403);
  });

  it("refuses an unauthenticated caller", async () => {
    const res = await request(createApp({ type: "none", source: "none" })).get(base);

    expect(res.status).toBe(403);
  });
});
