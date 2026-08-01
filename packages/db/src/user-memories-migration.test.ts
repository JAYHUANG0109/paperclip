import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * The embedded-postgres helper applies every pending migration on startup, so
 * reaching this file at all already proves 9025 applies in sequence against the
 * real schema. What is left to prove is that the constraints behave.
 */
function readMigration(name: string): string {
  return fs.readFileSync(path.join(__dirname, "migrations", name), "utf8");
}

/** Apply a migration the way the migrator does: split on the breakpoint marker. */
async function applyMigration(sql: postgres.Sql, name: string): Promise<void> {
  for (const statement of readMigration(name).split("--> statement-breakpoint")) {
    if (statement.trim()) await sql.unsafe(statement);
  }
}

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("9025_user_memories", () => {
  // ONE embedded postgres for the whole file, reset between tests.
  //
  // Starting an instance per test costs ~5s each, which passes when the file
  // runs alone and times out under the group run's parallelism — a test that
  // only fails when other work is happening is worse than no test.
  let shared: postgres.Sql;

  beforeAll(async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-user-memories-");
    cleanups.push(database.cleanup);
    shared = postgres(database.connectionString, { max: 1 });
    cleanups.push(async () => shared.end());
  }, 120_000);

  afterAll(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  beforeEach(async () => {
    // Companies cascade to user_memories; agents are referenced by provenance.
    await shared.unsafe(`TRUNCATE TABLE "user_memories", "agents", "companies" CASCADE`);
  });

  async function freshDatabase() {
    return shared;
  }

  it("applies and accepts a memory row", async () => {
    const sql = await freshDatabase();
    const [company] = await sql`INSERT INTO companies (name) VALUES ('Memory Co') RETURNING id`;

    const [row] = await sql`
      INSERT INTO user_memories (company_id, user_id, name, content)
      VALUES (${company.id}, 'user-1', 'likes-dark-mode', 'Prefers dark mode.')
      RETURNING *
    `;

    expect(row.source).toBe("manual");
    expect(row.memory_type).toBe("project");
    expect(row.is_binary).toBe(false);
    expect(row.description).toBe("");
    expect(row.file_path).toBeNull();
  });

  // Same convention as agent_memberships.source: anything inserted without
  // naming a source is hand-made, so a reconciler can never reclaim it.
  it("defaults source to manual so an importer cannot reclaim hand-written rows", async () => {
    const sql = await freshDatabase();
    const [company] = await sql`INSERT INTO companies (name) VALUES ('Memory Co') RETURNING id`;
    await sql`
      INSERT INTO user_memories (company_id, user_id, name, content)
      VALUES (${company.id}, 'user-1', 'a', 'x')
    `;

    const [row] = await sql`SELECT source FROM user_memories`;

    expect(row.source).toBe("manual");
  });

  it("enforces one memory per slug per owner", async () => {
    const sql = await freshDatabase();
    const [company] = await sql`INSERT INTO companies (name) VALUES ('Memory Co') RETURNING id`;
    const insert = (userId: string) => sql`
      INSERT INTO user_memories (company_id, user_id, name, content)
      VALUES (${company.id}, ${userId}, 'same-slug', 'x')
    `;
    await insert("user-1");

    await expect(insert("user-1")).rejects.toThrow();
    // A different owner may use the same slug — the uniqueness is per person.
    await expect(insert("user-2")).resolves.toBeDefined();
  });

  it("keeps two companies' memories separate for the same user", async () => {
    const sql = await freshDatabase();
    // issue_prefix defaults to 'PAP' and is unique, so two companies need
    // distinct prefixes.
    const [a] = await sql`INSERT INTO companies (name, issue_prefix) VALUES ('A', 'AAA') RETURNING id`;
    const [b] = await sql`INSERT INTO companies (name, issue_prefix) VALUES ('B', 'BBB') RETURNING id`;

    await sql`INSERT INTO user_memories (company_id, user_id, name, content) VALUES (${a.id}, 'user-1', 'n', 'x')`;
    await sql`INSERT INTO user_memories (company_id, user_id, name, content) VALUES (${b.id}, 'user-1', 'n', 'y')`;

    const rows = await sql`SELECT company_id FROM user_memories ORDER BY content`;
    expect(rows).toHaveLength(2);
  });

  it("deletes a company's memories with the company", async () => {
    const sql = await freshDatabase();
    const [company] = await sql`INSERT INTO companies (name) VALUES ('Memory Co') RETURNING id`;
    await sql`INSERT INTO user_memories (company_id, user_id, name, content) VALUES (${company.id}, 'user-1', 'n', 'x')`;

    await sql`DELETE FROM companies WHERE id = ${company.id}`;

    expect(await sql`SELECT 1 FROM user_memories`).toHaveLength(0);
  });

  // Provenance must not be load-bearing: losing the agent must not lose the
  // memory it wrote, or terminating an agent would silently erase what it knew.
  it("keeps a memory when the agent that wrote it is deleted", async () => {
    const sql = await freshDatabase();
    const [company] = await sql`INSERT INTO companies (name) VALUES ('Memory Co') RETURNING id`;
    const [agent] = await sql`
      INSERT INTO agents (company_id, name) VALUES (${company.id}, 'Scribe') RETURNING id
    `;
    await sql`
      INSERT INTO user_memories (company_id, user_id, name, content, created_by_agent_id)
      VALUES (${company.id}, 'user-1', 'n', 'x', ${agent.id})
    `;

    await sql`DELETE FROM agents WHERE id = ${agent.id}`;

    const [row] = await sql`SELECT created_by_agent_id, content FROM user_memories`;
    expect(row.content).toBe("x");
    expect(row.created_by_agent_id).toBeNull();
  });

  it("is idempotent, so a re-run cannot fail a deploy", async () => {
    const sql = await freshDatabase();

    await expect(applyMigration(sql, "9025_user_memories.sql")).resolves.toBeUndefined();
  });
});
