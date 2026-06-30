import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  costEvents,
  createDb,
  heartbeatRuns,
  projects,
  routines,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("agent service remove()", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-remove-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(costEvents);
    await db.delete(routines);
    await db.delete(projects);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("deletes an agent that has spend telemetry (the UI-delete-button bug) and preserves owned records", async () => {
    const [co] = await db.insert(companies).values({ name: "Co" }).returning();
    const [agent] = await db.insert(agents).values({ companyId: co.id, name: "doomed" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: co.id, agentId: agent.id }).returning();
    // cost_events.agent_id is NOT NULL and chains to the run — the exact rows that
    // used to make the delete fail with an FK error.
    await db.insert(costEvents).values({
      companyId: co.id,
      agentId: agent.id,
      heartbeatRunId: run.id,
      provider: "anthropic",
      model: "claude-opus-4-6",
      costCents: 123,
      occurredAt: new Date(),
    });
    // A project led by the agent + a routine assigned to it should SURVIVE,
    // with their agent link nulled (not be deleted along with the agent).
    const [project] = await db
      .insert(projects)
      .values({ companyId: co.id, name: "Proj", leadAgentId: agent.id })
      .returning();
    const [routine] = await db
      .insert(routines)
      .values({ companyId: co.id, title: "Routine", assigneeAgentId: agent.id })
      .returning();

    const removed = await agentService(db).remove(agent.id);
    expect(removed?.id).toBe(agent.id);

    // Agent + its telemetry are gone.
    expect(await db.select().from(agents).where(eq(agents.id, agent.id))).toHaveLength(0);
    expect(await db.select().from(costEvents).where(eq(costEvents.agentId, agent.id))).toHaveLength(0);

    // Owned records survive, with the agent reference cleared.
    const [proj] = await db.select().from(projects).where(eq(projects.id, project.id));
    expect(proj?.leadAgentId).toBeNull();
    const [rt] = await db.select().from(routines).where(eq(routines.id, routine.id));
    expect(rt?.assigneeAgentId).toBeNull();
  });
});
