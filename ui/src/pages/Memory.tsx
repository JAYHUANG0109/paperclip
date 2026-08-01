import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2, Upload } from "lucide-react";
import { useTranslation } from "@/i18n";
import { accessApi } from "@/api/access";
import { memoryApi, type MemoryImportResult, type PersonalMemory } from "@/api/memory";
import { useCompany } from "@/context/CompanyContext";

/**
 * Personal memory — facts this person's agents should carry between runs.
 *
 * Scoped to the SIGNED-IN user by design. The API can serve another user's
 * memory to an admin, but exposing a picker here would make casually reading a
 * colleague's memory a two-click affair. An admin who needs to inspect someone
 * else's uses "view as", which is audited on every request; this page stays
 * "yours".
 */
export function Memory() {
  const { t } = useTranslation();
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  const [draft, setDraft] = useState({ name: "", description: "", content: "" });
  const [importResult, setImportResult] = useState<MemoryImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: access } = useQuery({
    queryKey: ["current-board-access"],
    queryFn: () => accessApi.getCurrentBoardAccess(),
  });
  const userId = access?.userId ?? access?.user?.id ?? null;

  const memoriesKey = ["personal-memories", selectedCompanyId, userId];
  const { data: memories, isLoading } = useQuery({
    queryKey: memoriesKey,
    queryFn: () => memoryApi.list(selectedCompanyId!, userId!),
    enabled: Boolean(selectedCompanyId && userId),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: memoriesKey });

  const save = useMutation({
    mutationFn: (memory: { name: string; description: string; content: string }) =>
      memoryApi.save(selectedCompanyId!, userId!, memory.name, {
        content: memory.content,
        description: memory.description,
      }),
    onSuccess: () => {
      setDraft({ name: "", description: "", content: "" });
      setError(null);
      void invalidate();
    },
    onError: (err: Error) => setError(err.message),
  });

  const remove = useMutation({
    mutationFn: (name: string) => memoryApi.remove(selectedCompanyId!, userId!, name),
    onSuccess: () => void invalidate(),
    onError: (err: Error) => setError(err.message),
  });

  const importFiles = useMutation({
    mutationFn: (files: File[]) => memoryApi.import(selectedCompanyId!, userId!, files),
    onSuccess: (result) => {
      setImportResult(result);
      setError(null);
      void invalidate();
    },
    onError: (err: Error) => setError(err.message),
  });

  if (!selectedCompanyId || !userId) return null;

  const onPick = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    if (files.length > 0) importFiles.mutate(files);
    event.target.value = ""; // let the same selection be picked again
  };

  const slugify = (value: string) =>
    value.trim().toLowerCase().replace(/[^\p{Letter}\p{Number}]+/gu, "-").replace(/^-+|-+$/g, "");

  const canSave = draft.content.trim().length > 0;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 md:p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">
          {t("memory.title", { defaultValue: "Memory" })}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t("memory.subtitle", {
            defaultValue:
              "Things your agents should remember about you. Only you and your own agents can read this.",
          })}
        </p>
      </header>

      {error ? (
        <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
          {error}
        </div>
      ) : null}

      <section className="flex flex-col gap-2 rounded-lg border border-border p-4">
        <textarea
          className="min-h-20 w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm"
          placeholder={t("memory.contentPlaceholder", {
            defaultValue: "Remember that…",
          })}
          value={draft.content}
          onChange={(event) => setDraft((prev) => ({ ...prev, content: event.target.value }))}
        />
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="min-w-40 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
            placeholder={t("memory.namePlaceholder", { defaultValue: "Short label (optional)" })}
            value={draft.name}
            onChange={(event) => setDraft((prev) => ({ ...prev, name: event.target.value }))}
          />
          <button
            type="button"
            className="rounded-md border border-border px-3 py-2 text-sm font-medium disabled:opacity-50"
            disabled={!canSave || save.isPending}
            onClick={() =>
              save.mutate({
                // Fall back to a slug of the content so a quick note does not
                // require inventing a label first.
                name: slugify(draft.name) || slugify(draft.content.slice(0, 48)) || "memory",
                description: draft.description,
                content: draft.content,
              })
            }
          >
            {t("memory.save", { defaultValue: "Remember" })}
          </button>

          <span className="ml-auto flex items-center gap-2">
            <button
              type="button"
              className="flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm"
              onClick={() => fileInput.current?.click()}
              disabled={importFiles.isPending}
            >
              <Upload className="size-3.5" />
              {t("memory.importFiles", { defaultValue: "Import files" })}
            </button>
            <button
              type="button"
              className="rounded-md border border-border px-3 py-2 text-sm"
              onClick={() => folderInput.current?.click()}
              disabled={importFiles.isPending}
            >
              {t("memory.importFolder", { defaultValue: "Import folder" })}
            </button>
          </span>
        </div>
        <input ref={fileInput} type="file" multiple hidden onChange={onPick} />
        {/* webkitdirectory is not in React's typings; it is how a folder upload
            carries each file's relative path. */}
        <input
          ref={folderInput}
          type="file"
          hidden
          onChange={onPick}
          {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
        />
      </section>

      {importResult ? (
        <div className="rounded-md border border-border px-3 py-2 text-sm">
          <p>
            {t("memory.imported", {
              count: importResult.imported.length,
              defaultValue: `Imported ${importResult.imported.length} file(s).`,
            })}
          </p>
          {/* Never let a partial import read as a complete one. */}
          {importResult.skipped.length > 0 ? (
            <ul className="mt-2 flex flex-col gap-1 text-muted-foreground">
              {importResult.skipped.map((item) => (
                <li key={item.relativePath}>
                  {t("memory.skippedItem", {
                    path: item.relativePath,
                    reason: item.reason,
                    defaultValue: `Skipped ${item.relativePath} — ${item.reason}`,
                  })}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <section className="flex flex-col gap-2">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">{t("common.loading", { defaultValue: "Loading…" })}</p>
        ) : (memories ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("memory.empty", { defaultValue: "Nothing remembered yet." })}
          </p>
        ) : (
          (memories ?? []).map((memory: PersonalMemory) => (
            <article
              key={memory.name}
              className="flex items-start gap-3 rounded-lg border border-border px-4 py-3"
            >
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <p className="whitespace-pre-wrap break-words text-sm">
                  {memory.isBinary
                    ? t("memory.binaryEntry", {
                        path: memory.filePath ?? memory.name,
                        defaultValue: `Attached file: ${memory.filePath ?? memory.name}`,
                      })
                    : memory.content}
                </p>
                <p className="text-xs text-muted-foreground">
                  {memory.name}
                  {memory.source !== "manual" ? ` · ${memory.source}` : ""}
                </p>
              </div>
              <button
                type="button"
                aria-label={t("memory.forget", { defaultValue: "Forget" })}
                className="rounded-md border border-border p-1.5"
                onClick={() => remove.mutate(memory.name)}
                disabled={remove.isPending}
              >
                <Trash2 className="size-3.5" />
              </button>
            </article>
          ))
        )}
      </section>
    </div>
  );
}

export default Memory;
