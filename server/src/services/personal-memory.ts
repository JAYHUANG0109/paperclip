/**
 * Personal memory — DB is the source of truth, disk is a materialized copy.
 *
 * Every read and write goes through `personal-memory-access.ts`; this module
 * adds the I/O and one thing that primitive cannot express: resolving WHICH
 * user an agent-authenticated caller counts as.
 *
 * That resolution is the security-critical step. It reads `agent_memberships`
 * for the agent, and never looks at the request's actor. `requesterForAgent`
 * exists so no route has to remember that — a route that reaches for
 * `req.actor.userId` on an agent request has already lost.
 *
 * Materialization is one-way: DB → disk. An agent editing the files in its
 * workspace changes nothing, so it can never grant itself memory it was not
 * given, and a rebuilt workspace loses nothing.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { agentMemberships, userMemories } from "@paperclipai/db";
import { and, eq, inArray } from "drizzle-orm";
import { resolveUserMemoryDir } from "../home-paths.js";
import {
  canReadPersonalMemory,
  canWritePersonalMemory,
  readableMemoryOwnerIds,
  resolveAgentMappedUserId,
  type MemoryRequester,
} from "./personal-memory-access.js";

export type MemoryRecord = {
  id: string;
  companyId: string;
  userId: string;
  name: string;
  description: string;
  memoryType: string;
  content: string;
  source: string;
  filePath: string | null;
  isBinary: boolean;
  updatedAt: Date;
};

/**
 * Build the requester for an agent-authenticated caller.
 *
 * The acting user is deliberately not a parameter. An agent's memory follows
 * the agent's mapping, so a campus head driving a member's agent reaches the
 * member's memory and nothing else.
 */
export async function requesterForAgent(
  db: Db,
  input: { companyId: string; agentId: string },
): Promise<MemoryRequester> {
  const rows = await db
    .select({ agentId: agentMemberships.agentId, userId: agentMemberships.userId, state: agentMemberships.state })
    .from(agentMemberships)
    .where(and(eq(agentMemberships.companyId, input.companyId), eq(agentMemberships.agentId, input.agentId)));

  return {
    kind: "agent",
    agentId: input.agentId,
    mappedUserId: resolveAgentMappedUserId(rows, input.agentId),
  };
}

/** List the memories this requester may read, newest first. */
export async function listPersonalMemories(
  db: Db,
  input: { companyId: string; requester: MemoryRequester; ownerUserId?: string },
): Promise<MemoryRecord[]> {
  const allowed = readableMemoryOwnerIds(input.requester);

  // `null` means unrestricted (an admin) and MUST be handled separately — an
  // empty array means "nothing", and conflating the two would turn an unmapped
  // agent into an admin.
  if (allowed !== null && allowed.length === 0) return [];

  const owners = allowed === null ? (input.ownerUserId ? [input.ownerUserId] : null) : allowed;
  if (owners && input.ownerUserId && !owners.includes(input.ownerUserId)) return [];

  const rows = await db
    .select()
    .from(userMemories)
    .where(
      owners
        ? and(eq(userMemories.companyId, input.companyId), inArray(userMemories.userId, owners))
        : eq(userMemories.companyId, input.companyId),
    );

  return rows
    .filter((row) => canReadPersonalMemory({ ownerUserId: row.userId }, input.requester))
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()) as MemoryRecord[];
}

/** Create or replace a memory. Returns null when the requester may not write. */
export async function upsertPersonalMemory(
  db: Db,
  input: {
    companyId: string;
    ownerUserId: string;
    requester: MemoryRequester;
    name: string;
    description?: string;
    memoryType?: string;
    content: string;
    source?: string;
    filePath?: string | null;
    isBinary?: boolean;
    createdByAgentId?: string | null;
  },
): Promise<MemoryRecord | null> {
  if (!canWritePersonalMemory({ ownerUserId: input.ownerUserId }, input.requester)) return null;

  const content = input.content;
  const values = {
    companyId: input.companyId,
    userId: input.ownerUserId,
    name: input.name,
    description: input.description ?? "",
    memoryType: input.memoryType ?? "project",
    content,
    source: input.source ?? "manual",
    filePath: input.filePath ?? null,
    isBinary: input.isBinary ?? false,
    byteSize: Buffer.byteLength(content, input.isBinary ? "base64" : "utf8"),
    sha256: createHash("sha256").update(content).digest("hex"),
    createdByAgentId: input.createdByAgentId ?? null,
    updatedAt: new Date(),
  };

  const [row] = await db
    .insert(userMemories)
    .values(values)
    .onConflictDoUpdate({
      target: [userMemories.companyId, userMemories.userId, userMemories.name],
      set: {
        description: values.description,
        memoryType: values.memoryType,
        content: values.content,
        source: values.source,
        filePath: values.filePath,
        isBinary: values.isBinary,
        byteSize: values.byteSize,
        sha256: values.sha256,
        updatedAt: values.updatedAt,
      },
    })
    .returning();

  return (row as MemoryRecord) ?? null;
}

/** Delete a memory. Returns false when the requester may not write. */
export async function deletePersonalMemory(
  db: Db,
  input: { companyId: string; ownerUserId: string; requester: MemoryRequester; name: string },
): Promise<boolean> {
  if (!canWritePersonalMemory({ ownerUserId: input.ownerUserId }, input.requester)) return false;

  await db
    .delete(userMemories)
    .where(
      and(
        eq(userMemories.companyId, input.companyId),
        eq(userMemories.userId, input.ownerUserId),
        eq(userMemories.name, input.name),
      ),
    );
  return true;
}

// ---------------------------------------------------------------------------
// Materialization (DB → disk)
// ---------------------------------------------------------------------------

/**
 * Confine a stored relative path to the owner's memory directory.
 *
 * `file_path` is preserved verbatim on import so a folder round-trips, which
 * means it is attacker-influenced text that this module hands to the
 * filesystem. Anything that escapes the directory — `../`, an absolute path, a
 * Windows drive, a NUL — is rejected rather than sanitized, because a path that
 * tried to escape is not a path whose corrected form should be trusted.
 *
 * Returns null when the path is unusable; callers fall back to `<name>.md`.
 */
export function safeMemoryRelativePath(rawPath: string | null | undefined): string | null {
  if (!rawPath) return null;
  const candidate = rawPath.trim();
  if (!candidate) return null;
  if (candidate.includes("\0")) return null;
  if (path.isAbsolute(candidate)) return null;
  if (/^[a-zA-Z]:/.test(candidate)) return null; // Windows drive-relative

  const normalized = path.normalize(candidate).replace(/\\/g, "/");
  if (normalized.startsWith("../") || normalized === ".." || normalized.startsWith("/")) return null;
  if (normalized.split("/").some((segment) => segment === "..")) return null;
  if (normalized === "." || normalized === "") return null;
  return normalized;
}

/** Filesystem-safe file name for a memory that has no import path. */
function fallbackFileName(name: string): string {
  const cleaned = name.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${cleaned || "memory"}.md`;
}

/** Render one memory as the markdown file an agent reads. */
export function renderMemoryFile(memory: Pick<MemoryRecord, "name" | "description" | "memoryType" | "content">): string {
  return [
    "---",
    `name: ${memory.name}`,
    `description: ${memory.description}`,
    "metadata:",
    `  type: ${memory.memoryType}`,
    "---",
    "",
    memory.content.endsWith("\n") ? memory.content : `${memory.content}\n`,
  ].join("\n");
}

export type MaterializeResult = {
  dir: string;
  written: string[];
  skipped: Array<{ name: string; reason: string }>;
};

/**
 * Write a user's memories to their directory.
 *
 * One-way by design: nothing on disk is read back into the DB, so an agent
 * editing these files cannot grant itself memory. Stale files from deleted
 * memories are removed so the directory always matches the DB exactly.
 */
export async function materializeUserMemory(
  db: Db,
  input: { companyId: string; userId: string },
): Promise<MaterializeResult> {
  const dir = resolveUserMemoryDir(input);
  const rows = (await db
    .select()
    .from(userMemories)
    .where(
      and(eq(userMemories.companyId, input.companyId), eq(userMemories.userId, input.userId)),
    )) as MemoryRecord[];

  await fs.mkdir(dir, { recursive: true });

  const written: string[] = [];
  const skipped: MaterializeResult["skipped"] = [];
  const indexLines: string[] = [];

  for (const row of rows) {
    const relative = safeMemoryRelativePath(row.filePath) ?? fallbackFileName(row.name);
    const target = path.resolve(dir, relative);
    // Belt and braces: even after validation, refuse anything that did not land
    // inside the directory. A symlinked segment or an exotic normalization can
    // still surprise you, and this check costs nothing.
    if (target !== dir && !target.startsWith(dir + path.sep)) {
      skipped.push({ name: row.name, reason: `path escapes the memory directory: ${row.filePath}` });
      continue;
    }

    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(
      target,
      row.isBinary ? Buffer.from(row.content, "base64") : renderMemoryFile(row),
    );
    written.push(relative);
    if (!row.isBinary) indexLines.push(`- [${row.name}](${relative}) — ${row.description}`);
  }

  await fs.writeFile(
    path.join(dir, "MEMORY.md"),
    `# Memory\n\n${indexLines.sort().join("\n")}${indexLines.length ? "\n" : ""}`,
  );

  await pruneStaleMemoryFiles(dir, new Set([...written, "MEMORY.md"]));
  return { dir, written, skipped };
}

/** Remove files the DB no longer knows about, so disk mirrors the DB exactly. */
async function pruneStaleMemoryFiles(dir: string, keep: Set<string>): Promise<void> {
  const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const parent = (entry as unknown as { parentPath?: string; path?: string }).parentPath ?? entry.path ?? dir;
    const relative = path.relative(dir, path.join(parent, entry.name)).split(path.sep).join("/");
    if (!keep.has(relative)) {
      await fs.rm(path.join(dir, relative), { force: true });
    }
  }
}
