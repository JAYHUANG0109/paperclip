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
  updatedAt: string;
};

export type MemoryImportResult = {
  imported: string[];
  /** Files the server refused, with why. Always shown — a partial import must
   *  never read as a complete one. */
  skipped: Array<{ relativePath: string; reason: string }>;
};

const base = (companyId: string, userId: string) =>
  `/companies/${companyId}/users/${userId}/memories`;

export const memoryApi = {
  list: (companyId: string, userId: string) =>
    api.get<PersonalMemory[]>(base(companyId, userId)),

  save: (
    companyId: string,
    userId: string,
    name: string,
    body: { content: string; description?: string; memoryType?: string },
  ) => api.put<{ name: string; updatedAt: string }>(`${base(companyId, userId)}/${encodeURIComponent(name)}`, body),

  remove: (companyId: string, userId: string, name: string) =>
    api.delete<void>(`${base(companyId, userId)}/${encodeURIComponent(name)}`),

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
