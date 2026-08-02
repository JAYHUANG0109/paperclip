import type { MemoryCategory, MemoryStrength } from "@paperclipai/shared";
import { api } from "./client";

export type PersonalMemory = {
  name: string;
  description: string;
  memoryType: string;
  /** Null for binary entries — their bytes are not sent to the browser. */
  content: string | null;
  source: string;
  filePath: string | null;
  isBinary: boolean;
  /** How many times an agent has arrived at this fact. 1 for anything typed here. */
  timesObserved: number;
  lastObservedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Set only on entries in the recovery view. */
  deletedAt: string | null;
};

/**
 * Whether memory is actually being written.
 *
 * Capture is asked for in the agent prompt and driven by the distillation pass;
 * both can quietly fail to land. These counts are what makes that visible
 * without watching the page for a week.
 */
export type MemoryStats = {
  total: number;
  bySource: Record<string, number>;
  byType: Record<string, number>;
  byStrength: Record<MemoryStrength, number>;
  agentWrites: number;
  lastAgentWriteAt: string | null;
  deleted: number;
  captureEnabled: boolean;
};

export type MemorySettings = { captureEnabled: boolean };

export type MemoryImportResult = {
  imported: string[];
  /** Files the server refused, with why. Always shown — a partial import must
   *  never read as a complete one. */
  skipped: Array<{ relativePath: string; reason: string }>;
};

export type MemorySeed = {
  /** False when there is no history worth asking an agent to read. */
  worthwhile: boolean;
  existingMemories: number;
  totalIssues: number;
  completedIssues: number;
  agentNames: string[];
  projects: Array<{ name: string; count: number }>;
  task: { title: string; description: string };
};

const base = (companyId: string, userId: string) =>
  `/companies/${companyId}/users/${userId}/memories`;

export const memoryApi = {
  list: (companyId: string, userId: string) =>
    api.get<PersonalMemory[]>(base(companyId, userId)),

  stats: (companyId: string, userId: string) =>
    api.get<MemoryStats>(`${base(companyId, userId)}/stats`),

  /**
   * The brief for catching memory up on work already done. Reading it writes
   * nothing — the distillation happens on a normal agent run, through the same
   * write gate as every other memory.
   */
  seed: (companyId: string, userId: string) =>
    api.get<MemorySeed>(`${base(companyId, userId)}/seed`),

  save: (
    companyId: string,
    userId: string,
    name: string,
    body: { content: string; description?: string; memoryType?: MemoryCategory | string },
  ) => api.put<{ name: string; updatedAt: string }>(`${base(companyId, userId)}/${encodeURIComponent(name)}`, body),

  /** Recently deleted entries, still recoverable. */
  deleted: (companyId: string, userId: string) =>
    api.get<PersonalMemory[]>(`${base(companyId, userId)}/deleted`),

  settings: (companyId: string, userId: string) =>
    api.get<MemorySettings>(`${base(companyId, userId)}/settings`),

  setSettings: (companyId: string, userId: string, body: MemorySettings) =>
    api.put<MemorySettings>(`${base(companyId, userId)}/settings`, body),

  /**
   * Delete. Recoverable for 30 days unless `purge`, which is only offered from
   * the recovery view — by then the decision is deliberate rather than hasty.
   */
  remove: (companyId: string, userId: string, name: string, options?: { purge?: boolean }) =>
    api.delete<void>(
      `${base(companyId, userId)}/${encodeURIComponent(name)}${options?.purge ? "?purge=true" : ""}`,
    ),

  restore: (companyId: string, userId: string, name: string) =>
    api.post<PersonalMemory>(`${base(companyId, userId)}/${encodeURIComponent(name)}/restore`, {}),

  /**
   * Import files or a folder. Each file's name carries its path within the
   * upload so a folder keeps its structure; the server confines it.
   */
  import: (companyId: string, userId: string, files: File[]) => {
    const form = new FormData();
    for (const file of files) {
      const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
      form.append("files", file, relativePath || file.name);
    }
    return api.postForm<MemoryImportResult>(`${base(companyId, userId)}/import`, form);
  },
};
