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
const nextRefusal = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
const deletedRows = vi.hoisted(() => ({ current: [] as Array<Record<string, unknown>> }));
const restoreCalls = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const nextRestoreRefusal = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
const settings = vi.hoisted(() => ({ current: true }));

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
      if (!canWritePersonalMemory({ ownerUserId: input.ownerUserId }, input.requester)) {
        return { ok: false, reason: "forbidden", message: "Memory not found" } as never;
      }
      // Lets a case stage a refusal without reaching into the real gate, which
      // has its own test — this file is about how a refusal becomes a response.
      if (nextRefusal.current) {
        const refusal = nextRefusal.current;
        nextRefusal.current = null;
        return refusal as never;
      }
      upsertCalls.push(input as never);
      return {
        ok: true,
        deduped: false,
        memory: {
          name: input.name,
          memoryType: input.memoryType ?? "project",
          timesObserved: 1,
          updatedAt: new Date("2026-08-01T00:00:00.000Z"),
        },
      } as never;
    },
    personalMemoryStats: async (_db: unknown, input: Parameters<typeof actual.personalMemoryStats>[1]) => {
      const { canReadPersonalMemory } = await import("../services/personal-memory-access.js");
      if (!canReadPersonalMemory({ ownerUserId: input.ownerUserId }, input.requester)) return null;
      return {
        total: 3,
        bySource: { manual: 1, agent: 2 },
        byType: { preference: 3 },
        agentWrites: 2,
        lastAgentWriteAt: new Date("2026-08-01T00:00:00.000Z"),
      } as never;
    },
    deletePersonalMemory: async (_db: unknown, input: Parameters<typeof actual.deletePersonalMemory>[1]) => {
      const { canWritePersonalMemory } = await import("../services/personal-memory-access.js");
      if (!canWritePersonalMemory({ ownerUserId: input.ownerUserId }, input.requester)) return false;
      deleteCalls.push(input as never);
      return true;
    },
    listDeletedPersonalMemories: async (
      _db: unknown,
      input: Parameters<typeof actual.listDeletedPersonalMemories>[1],
    ) => {
      const { canReadPersonalMemory } = await import("../services/personal-memory-access.js");
      if (!canReadPersonalMemory({ ownerUserId: input.ownerUserId }, input.requester)) return [];
      return deletedRows.current as never;
    },
    getMemorySettings: async () => ({ captureEnabled: settings.current }),
    setMemorySettings: async (_db: unknown, input: Parameters<typeof actual.setMemorySettings>[1]) => {
      const { canWritePersonalMemory } = await import("../services/personal-memory-access.js");
      if (!canWritePersonalMemory({ ownerUserId: input.ownerUserId }, input.requester)) return null;
      if (input.requester.kind !== "user") return null;
      settings.current = input.captureEnabled;
      return { captureEnabled: settings.current };
    },
    restorePersonalMemory: async (_db: unknown, input: Parameters<typeof actual.restorePersonalMemory>[1]) => {
      const { canWritePersonalMemory } = await import("../services/personal-memory-access.js");
      if (!canWritePersonalMemory({ ownerUserId: input.ownerUserId }, input.requester)) {
        return { ok: false, reason: "forbidden", message: "Memory not found" } as never;
      }
      if (nextRestoreRefusal.current) {
        const refusal = nextRestoreRefusal.current;
        nextRestoreRefusal.current = null;
        return refusal as never;
      }
      restoreCalls.push(input as never);
      return {
        ok: true,
        memory: { ...(deletedRows.current[0] ?? {}), name: input.name, deletedAt: null },
      } as never;
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
  deletedRows.current = [
    { userId: OWNER, name: "old-note", description: "d", memoryType: "project", content: "c", source: "manual", filePath: null, isBinary: false, timesObserved: 1, updatedAt: new Date(), deletedAt: new Date() },
  ];
  upsertCalls.length = 0;
  deleteCalls.length = 0;
  restoreCalls.length = 0;
  nextRefusal.current = null;
  nextRestoreRefusal.current = null;
  settings.current = true;
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

/**
 * A refusal a writer cannot see the reason for is a refusal it will retry
 * unchanged. Everything except the access rule is stated plainly; the access
 * rule stays hidden so it cannot be used to probe for who exists.
 */
describe("refusals reaching the caller", () => {
  it("explains a screened write and does not re-materialize", async () => {
    nextRefusal.current = {
      ok: false,
      reason: "screened",
      screenClass: "credential",
      message: "Refused: this looks like a secret",
    };

    const res = await request(createApp(asOwnerAgent)).put(`${base}/leak`).send({ content: "x" });

    expect(res.status).toBe(422);
    expect(res.body.reason).toBe("screened");
    expect(res.body.screenClass).toBe("credential");
    expect(res.body.error).toMatch(/secret/i);
    expect(materialize).not.toHaveBeenCalled();
  });

  it("answers a rate-limited write with 429", async () => {
    nextRefusal.current = { ok: false, reason: "rate_limited", message: "too many this hour" };

    const res = await request(createApp(asOwnerAgent)).put(`${base}/too-many`).send({ content: "x" });

    expect(res.status).toBe(429);
  });

  it("reports a deduped write so the caller stops adding it", async () => {
    const res = await request(createApp(asOwnerAgent)).put(`${base}/restated`).send({ content: "x" });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("deduped");
    expect(res.body).toHaveProperty("timesObserved");
  });
});

/**
 * Whether capture is working should be a number you can look at, not an
 * impression formed by watching the page for a week.
 */
describe("memory stats", () => {
  it("gives the owner their capture counts", async () => {
    const res = await request(createApp(asOwner)).get(`${base}/stats`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ agentWrites: 2, total: 3 });
  });

  it("withholds them from another user", async () => {
    const res = await request(createApp(asOther)).get(`${base}/stats`);

    expect(res.status).toBe(404);
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

describe("deleting is reversible", () => {
  it("soft-deletes by default", async () => {
    const res = await request(createApp(asOwner)).delete(`${base}/likes-dark-mode`);

    expect(res.status).toBe(204);
    expect(deleteCalls[0]?.purge).toBe(false);
  });

  // Irreversible has to be asked for explicitly. Deleting is what people do in a
  // hurry; purging is what they do from the recovery view, having thought.
  it("purges only when asked", async () => {
    const res = await request(createApp(asOwner)).delete(`${base}/likes-dark-mode?purge=true`);

    expect(res.status).toBe(204);
    expect(deleteCalls[0]?.purge).toBe(true);
  });

  it("lists what the owner deleted", async () => {
    const res = await request(createApp(asOwner)).get(`${base}/deleted`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].name).toBe("old-note");
  });

  it("hides another user's deleted memories behind the same 404", async () => {
    const res = await request(createApp(asOther)).get(`${base}/deleted`);

    expect(res.status).toBe(404);
  });

  it("restores one, and re-materializes so agents see it again", async () => {
    const res = await request(createApp(asOwner)).post(`${base}/old-note/restore`);

    expect(res.status).toBe(200);
    expect(restoreCalls).toHaveLength(1);
    expect(materialize).toHaveBeenCalled();
  });

  // A clash is the caller's own situation and is worth explaining; "not yours"
  // never is.
  it("reports a name clash as a conflict rather than a 404", async () => {
    nextRestoreRefusal.current = { ok: false, reason: "name_taken", message: "taken" };

    const res = await request(createApp(asOwner)).post(`${base}/old-note/restore`);

    expect(res.status).toBe(409);
    expect(res.body.reason).toBe("name_taken");
  });

  it("refuses another user's restore without saying why", async () => {
    const res = await request(createApp(asOther)).post(`${base}/old-note/restore`);

    expect(res.status).toBe(404);
    expect(restoreCalls).toHaveLength(0);
  });
});

describe("the capture switch", () => {
  it("lets the owner pause capture", async () => {
    const res = await request(createApp(asOwner))
      .put(`${base}/settings`)
      .send({ captureEnabled: false });

    expect(res.status).toBe(200);
    expect(res.body.captureEnabled).toBe(false);
  });

  // An agent that could turn its own leash off is not on a leash.
  it("refuses an agent trying to switch it", async () => {
    const res = await request(createApp(asOwnerAgent))
      .put(`${base}/settings`)
      .send({ captureEnabled: false });

    expect(res.status).toBe(404);
    expect(settings.current).toBe(true);
  });

  // Admins may READ someone's memory; deciding how that person's agents learn
  // about them is theirs alone.
  it("refuses an admin switching someone else's", async () => {
    const res = await request(createApp(asAdmin))
      .put(`${base}/settings`)
      .send({ captureEnabled: false });

    expect(res.status).toBe(404);
    expect(settings.current).toBe(true);
  });

  it("rejects a non-boolean", async () => {
    const res = await request(createApp(asOwner)).put(`${base}/settings`).send({ captureEnabled: "no" });

    expect(res.status).toBe(400);
  });

  it("reads back as enabled by default", async () => {
    const res = await request(createApp(asOwner)).get(`${base}/settings`);

    expect(res.body).toEqual({ captureEnabled: true });
  });
});

describe("the /memories namespace", () => {
  /**
   * A memory is addressed as /memories/{name}, so every literal sub-path is a
   * name nobody may use. This is the drift check: add a route, and the reserved
   * list has to grow in the same commit or this fails. Without it the symptom
   * would be a memory called "settings" that saves fine and then shadows — or is
   * shadowed by — a real endpoint, on one verb only.
   */
  it("reserves every literal sub-path as a memory name", async () => {
    const { RESERVED_MEMORY_NAMES } = await import("@paperclipai/shared");
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../routes/personal-memory.ts", import.meta.url), "utf8"),
    );

    const literals = [...source.matchAll(/\/memories\/([a-z][a-z0-9-]*)/g)].map((match) => match[1]!);

    expect(literals.length).toBeGreaterThan(0);
    for (const literal of new Set(literals)) {
      expect(RESERVED_MEMORY_NAMES).toContain(literal);
    }
  });
});
