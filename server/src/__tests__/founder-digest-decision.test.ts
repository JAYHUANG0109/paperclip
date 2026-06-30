import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, agents, companies, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  writeFounderDigestForAgent,
  setFounderItemDecision,
  setFounderItemClosed,
  appendFounderItemComment,
  getConsolesForUser,
  type FounderDigest,
} from "../services/founder-digest.js";

describe("founder-digest decisions", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let agentId = "";
  let companyId = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-founder-digest-");
    db = createDb(tempDb.connectionString);
    const [co] = await db.insert(companies).values({ name: "Test Co" }).returning();
    companyId = co.id;
    const [ag] = await db.insert(agents).values({ companyId: co.id, name: "創辦人_test" }).returning();
    agentId = ag.id;
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const read = async (): Promise<FounderDigest> => {
    const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
    return (row!.metadata as { founderDigest: FounderDigest }).founderDigest;
  };

  it("maps a legacy approved:true item to decision='approved'", async () => {
    await writeFounderDigestForAgent(db, "c", agentId, {
      categories: {
        urgent: [
          { gid: "1", name: "legacy approved", approved: true },
          { gid: "2", name: "undecided" },
          { gid: "3", name: "explicit", decision: "changes_requested", decisionNote: "請補充預算" },
        ],
      },
    });
    const d = await read();
    expect(d.categories.urgent.find((i) => i.gid === "1")?.decision).toBe("approved");
    expect(d.categories.urgent.find((i) => i.gid === "2")?.decision).toBeNull();
    const explicit = d.categories.urgent.find((i) => i.gid === "3");
    expect(explicit?.decision).toBe("changes_requested");
    expect(explicit?.decisionNote).toBe("請補充預算");
  });

  it("records a decision + note and can reset it to null", async () => {
    await setFounderItemDecision(db, agentId, "2", "rejected", "今年不執行");
    let item = (await read()).categories.urgent.find((i) => i.gid === "2");
    expect(item?.decision).toBe("rejected");
    expect(item?.decisionNote).toBe("今年不執行");

    await setFounderItemDecision(db, agentId, "2", null, null);
    item = (await read()).categories.urgent.find((i) => i.gid === "2");
    expect(item?.decision).toBeNull();
    expect(item?.decisionNote).toBeNull();
  });

  it("leaves other items untouched when deciding one", async () => {
    await setFounderItemDecision(db, agentId, "1", "approved", null);
    const d = await read();
    expect(d.categories.urgent.find((i) => i.gid === "3")?.decision).toBe("changes_requested");
  });

  it("hosts two consoles on one agent and routes writes by console key", async () => {
    // An allowlisted preview user whose agent carries BOTH consoles.
    process.env.PAPERCLIP_FOUNDER_EMAILS = "preview-console@test.org";
    const email = "preview-console@test.org";
    const [ag] = await db
      .insert(agents)
      .values({ companyId, name: "preview", adapterConfig: { assignedUserEmail: email } })
      .returning();
    await writeFounderDigestForAgent(db, companyId, ag.id, {
      categories: { urgent: [{ gid: "f1", name: "創辦人項目" }] },
    });
    await writeFounderDigestForAgent(db, companyId, ag.id, {
      console: "principal",
      categories: { reminders: [{ gid: "p1", name: "園長提醒" }] },
    });

    const consoles = await getConsolesForUser(db, companyId, email);
    const keys = consoles.map((c) => c.key).sort();
    expect(keys).toEqual(["founder", "principal"]);
    expect(consoles.find((c) => c.key === "founder")?.digest.categories.urgent[0]?.gid).toBe("f1");
    expect(consoles.find((c) => c.key === "principal")?.digest.categories.reminders[0]?.gid).toBe("p1");

    // A decision on the principal item must not leak into the founder console.
    await setFounderItemDecision(db, ag.id, "p1", "approved", null);
    const after = await getConsolesForUser(db, companyId, email);
    expect(after.find((c) => c.key === "principal")?.digest.categories.reminders[0]?.decision).toBe("approved");
    expect(after.find((c) => c.key === "founder")?.digest.categories.urgent[0]?.decision).toBeNull();
  });

  it("parses an agent-seeded comment thread and appends a founder reply", async () => {
    await writeFounderDigestForAgent(db, "c", agentId, {
      categories: {
        urgent: [
          {
            gid: "ct1",
            name: "with thread",
            comments: [
              { id: "s1", author: "婉珺", authorType: "agent", text: "已修正上傳新版", createdAt: "2026-06-30T01:00:00Z" },
              { text: "" }, // dropped: empty
              { nope: true }, // dropped: malformed
            ],
          },
        ],
      },
    });
    let item = (await read()).categories.urgent.find((i) => i.gid === "ct1");
    expect(item?.comments).toHaveLength(1);
    expect(item?.comments[0]).toMatchObject({ id: "s1", author: "婉珺", authorType: "agent", text: "已修正上傳新版" });

    const digest = await appendFounderItemComment(db, agentId, "ct1", {
      id: "pending-x",
      author: null,
      authorType: "founder",
      text: "請先確認金額",
      createdAt: "2026-06-30T02:00:00Z",
      pending: true,
    });
    expect(digest).not.toBeNull();
    item = (await read()).categories.urgent.find((i) => i.gid === "ct1");
    expect(item?.comments).toHaveLength(2);
    expect(item?.comments[1]).toMatchObject({ authorType: "founder", text: "請先確認金額", pending: true });
  });

  it("defaults comments to an empty array when the agent omits them", async () => {
    await writeFounderDigestForAgent(db, "c", agentId, {
      categories: { urgent: [{ gid: "nc1", name: "no comments" }] },
    });
    const item = (await read()).categories.urgent.find((i) => i.gid === "nc1");
    expect(item?.comments).toEqual([]);
  });

  it("marks a meeting/reminder item 結案 and can reopen it", async () => {
    await writeFounderDigestForAgent(db, "c", agentId, {
      categories: {
        meetings: [{ gid: "m1", name: "今日會議" }],
        reminders: [{ gid: "r1", name: "提醒一則", closed: true }],
      },
    });
    let d = await read();
    expect(d.categories.meetings[0]?.closed).toBe(false); // default
    expect(d.categories.reminders[0]?.closed).toBe(true); // honoured from agent output

    await setFounderItemClosed(db, agentId, "m1", true);
    d = await read();
    expect(d.categories.meetings.find((i) => i.gid === "m1")?.closed).toBe(true);

    await setFounderItemClosed(db, agentId, "m1", false);
    d = await read();
    expect(d.categories.meetings.find((i) => i.gid === "m1")?.closed).toBe(false);
  });
});
