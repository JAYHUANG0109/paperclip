import path from "node:path";
const PATH_SEGMENT_RE = /^[a-zA-Z0-9_-]+$/;
const FRIENDLY_PATH_SEGMENT_RE = /[^a-zA-Z0-9._-]+/g;
import {
  expandHomePrefix,
  resolveDefaultBackupDir as resolveSharedDefaultBackupDir,
  resolveDefaultEmbeddedPostgresDir as resolveSharedDefaultEmbeddedPostgresDir,
  resolveDefaultLogsDir as resolveSharedDefaultLogsDir,
  resolveDefaultSecretsKeyFilePath as resolveSharedDefaultSecretsKeyFilePath,
  resolveDefaultStorageDir as resolveSharedDefaultStorageDir,
  resolveHomeAwarePath,
  resolvePaperclipConfigPathForInstance,
  resolvePaperclipHomeDir,
  resolvePaperclipInstanceId,
  resolvePaperclipInstanceRoot,
} from "@paperclipai/shared/home-paths";

export {
  expandHomePrefix,
  resolveHomeAwarePath,
  resolvePaperclipHomeDir,
  resolvePaperclipInstanceId,
  resolvePaperclipInstanceRoot,
};

export function resolveDefaultConfigPath(): string {
  return resolvePaperclipConfigPathForInstance();
}

export function resolveDefaultEmbeddedPostgresDir(): string {
  return resolveSharedDefaultEmbeddedPostgresDir();
}

export function resolveDefaultLogsDir(): string {
  return resolveSharedDefaultLogsDir();
}

export function resolveDefaultSecretsKeyFilePath(): string {
  return resolveSharedDefaultSecretsKeyFilePath();
}

export function resolveDefaultStorageDir(): string {
  return resolveSharedDefaultStorageDir();
}

export function resolveDefaultBackupDir(): string {
  return resolveSharedDefaultBackupDir();
}

export function resolveDefaultAgentWorkspaceDir(agentId: string): string {
  const trimmed = agentId.trim();
  if (!PATH_SEGMENT_RE.test(trimmed)) {
    throw new Error(`Invalid agent id for workspace path '${agentId}'.`);
  }
  return path.resolve(resolvePaperclipInstanceRoot(), "workspaces", trimmed);
}

/**
 * Resolve one user's materialized personal-memory directory:
 * `<instanceRoot>/memory/<companyId>/<userId>`.
 *
 * Per-user isolation is the whole point, so both segments are sanitized into
 * single path components — a userId is opaque text (better-auth generates it)
 * and must never be able to introduce a separator and land one person's memory
 * inside another's directory.
 */
export function resolveUserMemoryDir(input: { companyId: string; userId: string }): string {
  const companyId = input.companyId.trim();
  const userId = input.userId.trim();
  if (!companyId || !userId) {
    throw new Error("User memory path requires companyId and userId.");
  }
  return path.resolve(
    resolvePaperclipInstanceRoot(),
    "memory",
    sanitizeFriendlyPathSegment(companyId, "company"),
    sanitizeFriendlyPathSegment(userId, "user"),
  );
}

/**
 * Resolve one room's materialized memory directory:
 * `<instanceRoot>/memory/rooms/<companyId>/<roomScopeId>`.
 *
 * Kept under a distinct `rooms/` segment so a room bucket can never collide with
 * a user bucket, and both segments are sanitized into single path components — a
 * roomScopeId is opaque text (e.g. `google_chat:spaces/AAA`) and must never be
 * able to introduce a separator and escape into another room's or user's dir.
 */
export function resolveRoomMemoryDir(input: { companyId: string; roomScopeId: string }): string {
  const companyId = input.companyId.trim();
  const roomScopeId = input.roomScopeId.trim();
  if (!companyId || !roomScopeId) {
    throw new Error("Room memory path requires companyId and roomScopeId.");
  }
  return path.resolve(
    resolvePaperclipInstanceRoot(),
    "memory",
    "rooms",
    sanitizeFriendlyPathSegment(companyId, "company"),
    sanitizeFriendlyPathSegment(roomScopeId, "room"),
  );
}

function sanitizeFriendlyPathSegment(value: string | null | undefined, fallback = "_default"): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return fallback;
  const sanitized = trimmed
    .replace(FRIENDLY_PATH_SEGMENT_RE, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || fallback;
}

/**
 * Resolve the managed checkout directory for one project:
 * `<instanceRoot>/projects/<companyId>/<projectId>/<repoName|_default>`.
 *
 * Per-project directory isolation invariant: the `projectId` is a distinct path segment, so two
 * different projects always resolve to sibling directories under `<companyId>/`. One project's
 * directory can never nest inside, or be a path prefix of, another project's directory. A run that
 * materializes several referenced projects can therefore place each in its own directory without
 * collision. See the "distinct, non-nested managed dirs" test in `heartbeat-project-env.test.ts`.
 */
export function resolveManagedProjectWorkspaceDir(input: {
  companyId: string;
  projectId: string;
  repoName?: string | null;
}): string {
  const companyId = input.companyId.trim();
  const projectId = input.projectId.trim();
  if (!companyId || !projectId) {
    throw new Error("Managed project workspace path requires companyId and projectId.");
  }
  return path.resolve(
    resolvePaperclipInstanceRoot(),
    "projects",
    sanitizeFriendlyPathSegment(companyId, "company"),
    sanitizeFriendlyPathSegment(projectId, "project"),
    sanitizeFriendlyPathSegment(input.repoName, "_default"),
  );
}
