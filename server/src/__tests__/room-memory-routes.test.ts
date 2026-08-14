import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const COMPANY = "11111111-1111-1111-1111-111111111111";
const AGENT = "22222222-2222-2222-2222-222222222222";
const ROOM = "google_chat:spaces/AAA";

// Keep resolveRoomScope real (the recognizer under test in the gate), stub the store.
const upsertCalls: unknown[] = [];
vi.mock("../services/room-memory.js", async () => {
  const actual = await vi.importActual<typeof import("../services/room-memory.js")>("../services/room-memory.js");
  return {
    ...actual,
    listRoomMemories: vi.fn(async () => [{ name: "n", description: "d", memoryType: "project", content: "c", timesObserved: 1, updatedAt: new Date() }]),
    upsertRoomMemory: vi.fn(async (_db: unknown, input: unknown) => { upsertCalls.push(input); }),
    softDeleteRoomMemory: vi.fn(async () => {}),
  };
});

const { roomMemoryRoutes } = await import("../routes/room-memory.js");
const { errorHandler } = await import("../middleware/error-handler.js");

type Actor = Express.Request["actor"];
const asAgent: Actor = { type: "agent", agentId: AGENT, companyId: COMPANY, source: "agent_key" };
const asBoard: Actor = { type: "board", userId: "u1", companyIds: [COMPANY], source: "session" };

/** db whose issues lookup returns `issueRows` (drizzle chain: select→from→where→limit). */
function fakeDb(issueRows: Array<{ id: string }>) {
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.from = () => chain;
  chain.where = () => chain;
  chain.limit = () => Promise.resolve(issueRows);
  return chain as never;
}

function app(actor: Actor, issueRows: Array<{ id: string }>) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { req.actor = actor; next(); });
  a.use(roomMemoryRoutes(fakeDb(issueRows)));
  a.use(errorHandler);
  return a;
}

beforeEach(() => { upsertCalls.length = 0; });
afterEach(() => { vi.clearAllMocks(); });

describe("room-memory write authorization", () => {
  it("lets an agent assigned to a room issue write the room's memory", async () => {
    const res = await request(app(asAgent, [{ id: "issue-1" }]))
      .put(`/companies/${COMPANY}/room-memories/team-prefs`)
      .send({ roomScopeId: ROOM, content: "the room prefers morning standups" });
    expect(res.status).toBe(200);
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0]).toMatchObject({ companyId: COMPANY, roomScopeId: ROOM, name: "team-prefs", surface: "google_chat" });
  });

  it("forbids an agent NOT assigned to any issue in that room", async () => {
    const res = await request(app(asAgent, [])) // no matching issue
      .put(`/companies/${COMPANY}/room-memories/team-prefs`)
      .send({ roomScopeId: ROOM, content: "x" });
    expect(res.status).toBe(403);
    expect(upsertCalls).toHaveLength(0);
  });

  it("forbids a non-agent (board) actor entirely", async () => {
    const res = await request(app(asBoard, [{ id: "issue-1" }]))
      .put(`/companies/${COMPANY}/room-memories/team-prefs`)
      .send({ roomScopeId: ROOM, content: "x" });
    expect(res.status).toBe(403);
  });

  it("forbids a malformed / non-room scope", async () => {
    const res = await request(app(asAgent, [{ id: "issue-1" }]))
      .put(`/companies/${COMPANY}/room-memories/team-prefs`)
      .send({ roomScopeId: "not-a-room", content: "x" });
    expect(res.status).toBe(403);
  });
});
