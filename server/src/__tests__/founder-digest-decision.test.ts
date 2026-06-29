import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, agents, companies, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  writeFounderDigestForAgent,
  setFounderItemDecision,
  type FounderDigest,
} from "../services/founder-digest.js";

describe("founder-digest decisions", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let agentId = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-founder-digest-");
    db = createDb(tempDb.connectionString);
    const [co] = await db.insert(companies).values({ name: "Test Co" }).returning();
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
});
