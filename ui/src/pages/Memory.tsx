import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCcw, Trash2, Upload } from "lucide-react";
import {
  DEFAULT_MEMORY_CATEGORY,
  MEMORY_CATEGORIES,
  MEMORY_CATEGORY_LABELS,
  MEMORY_RECOVERY_WINDOW_DAYS,
  classifyMemoryContent,
  isHarnessCategory,
  memoryRecency,
  memoryStrength,
  normalizeMemoryCategory,
  parseMemoryDump,
  type MemoryCategory,
  type MemoryRecency,
  type MemoryStrength,
} from "@paperclipai/shared";
import { useTranslation } from "@/i18n";
import { accessApi } from "@/api/access";
import { agentsApi } from "@/api/agents";
import { issuesApi } from "@/api/issues";
import { memoryApi, type MemoryImportResult, type PersonalMemory } from "@/api/memory";
import { useCompany } from "@/context/CompanyContext";
import { cn } from "@/lib/utils";

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

  const [draft, setDraft] = useState<{
    name: string;
    description: string;
    content: string;
    memoryType: MemoryCategory | "auto";
  }>({ name: "", description: "", content: "", memoryType: "auto" });
  // Preview of a pasted multi-entry dump before it lands (auto-split + categorized).
  const [preview, setPreview] = useState<Array<{ content: string; category: MemoryCategory; observedAt: string | null; include: boolean }> | null>(null);
  const nowMs = Date.now();
  const [importResult, setImportResult] = useState<MemoryImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Which category is being shown, or "all". Not persisted — a view, not a setting. */
  const [filter, setFilter] = useState<MemoryCategory | "all">("all");
  /** Ordering: by category (grouped) or by recency (flat, hot- or cold-first). */
  const [sortMode, setSortMode] = useState<"category" | "hot" | "cold">("category");
  /** The recovery view stays closed until asked for; it is a drawer, not a list. */
  const [showDeleted, setShowDeleted] = useState(false);

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

  const statsKey = ["personal-memory-stats", selectedCompanyId, userId];
  const { data: stats } = useQuery({
    queryKey: statsKey,
    queryFn: () => memoryApi.stats(selectedCompanyId!, userId!),
    enabled: Boolean(selectedCompanyId && userId),
  });

  const deletedKey = ["personal-memories-deleted", selectedCompanyId, userId];
  const { data: deletedMemories } = useQuery({
    queryKey: deletedKey,
    queryFn: () => memoryApi.deleted(selectedCompanyId!, userId!),
    // Only fetched once opened: a recovery view is rarely wanted, and paying for
    // it on every page load would be a request that is usually thrown away.
    enabled: Boolean(selectedCompanyId && userId && showDeleted),
  });

  const batchesKey = ["personal-memory-batches", selectedCompanyId, userId];
  const { data: importBatches } = useQuery({
    queryKey: batchesKey,
    queryFn: () => memoryApi.importBatches(selectedCompanyId!, userId!),
    enabled: Boolean(selectedCompanyId && userId),
  });
  const [showHistory, setShowHistory] = useState(false);
  const [selectedBatches, setSelectedBatches] = useState<Set<string>>(() => new Set());

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: memoriesKey });
    void queryClient.invalidateQueries({ queryKey: statsKey });
    void queryClient.invalidateQueries({ queryKey: deletedKey });
    void queryClient.invalidateQueries({ queryKey: batchesKey });
  };

  const deleteBatches = useMutation({
    mutationFn: (batchIds: string[]) => memoryApi.deleteImportBatches(selectedCompanyId!, userId!, batchIds),
    onSuccess: () => { setSelectedBatches(new Set()); invalidate(); },
    onError: (err: Error) => setError(err.message),
  });

  const save = useMutation({
    mutationFn: (memory: {
      name: string;
      description: string;
      content: string;
      memoryType: MemoryCategory;
      observedAt?: string | null;
    }) =>
      memoryApi.save(selectedCompanyId!, userId!, memory.name, {
        content: memory.content,
        description: memory.description,
        memoryType: memory.memoryType,
        observedAt: memory.observedAt ?? null,
      }),
    onSuccess: () => {
      setDraft({ name: "", description: "", content: "", memoryType: "auto" });
      setError(null);
      invalidate();
    },
    onError: (err: Error) => setError(err.message),
  });

  // Bulk-save the confirmed entries from a pasted dump. Names derive from content
  // and are de-duped so entries don't overwrite each other.
  const saveMany = useMutation({
    mutationFn: async (entries: Array<{ content: string; category: MemoryCategory; observedAt: string | null }>) => {
      // One batch id for the whole paste, so it can be reviewed/deleted as a unit.
      const batchId = crypto.randomUUID();
      const used = new Set<string>();
      for (const entry of entries) {
        let name = slugify(entry.content.slice(0, 48)) || "memory";
        let n = name;
        for (let i = 2; used.has(n); i += 1) n = `${name}-${i}`;
        used.add(n);
        name = n;
        await memoryApi.save(selectedCompanyId!, userId!, name, {
          content: entry.content,
          description: "",
          memoryType: entry.category,
          observedAt: entry.observedAt,
          importBatchId: batchId,
        });
      }
    },
    onSuccess: () => {
      setPreview(null);
      setDraft({ name: "", description: "", content: "", memoryType: "auto" });
      setError(null);
      invalidate();
    },
    onError: (err: Error) => setError(err.message),
  });

  const remove = useMutation({
    mutationFn: (input: { name: string; purge?: boolean }) =>
      memoryApi.remove(selectedCompanyId!, userId!, input.name, { purge: input.purge }),
    onSuccess: () => invalidate(),
    onError: (err: Error) => setError(err.message),
  });

  const restore = useMutation({
    mutationFn: (name: string) => memoryApi.restore(selectedCompanyId!, userId!, name),
    onSuccess: () => invalidate(),
    onError: (err: Error) => setError(err.message),
  });

  /**
   * Pause or resume capture.
   *
   * A switch rather than a settings page, because the moment someone wants it is
   * the moment they are looking at something an agent saved that they did not
   * want saved. Optimistic on purpose: a toggle that waits for a round trip
   * before moving feels broken.
   */
  const setCapture = useMutation({
    mutationFn: (captureEnabled: boolean) =>
      memoryApi.setSettings(selectedCompanyId!, userId!, { captureEnabled }),
    onSuccess: () => invalidate(),
    onError: (err: Error) => setError(err.message),
  });

  /**
   * Catch memory up on work that happened before capture existed.
   *
   * This creates a TASK for the person's own agent rather than writing memories
   * directly. Distillation is a judgement, and the agent is the thing that makes
   * judgements — and routing it through a normal run means the backfill has to
   * satisfy the same category rules, screen and limits as everything else.
   */
  const seedFromHistory = useMutation({
    mutationFn: async () => {
      const seed = await memoryApi.seed(selectedCompanyId!, userId!);
      if (!seed.worthwhile) return { created: false as const, reason: "no-history" as const };

      // Assigned to the person's OWN agent, which is also the agent whose
      // memory this is. Assigning to the person would create a task nobody
      // runs; assigning to any other agent would reach the wrong memory.
      const myAgents = await agentsApi.mine(selectedCompanyId!);
      const agent = myAgents?.[0];
      if (!agent) return { created: false as const, reason: "no-agent" as const };

      const issue = await issuesApi.create(selectedCompanyId!, {
        title: seed.task.title,
        description: seed.task.description,
        assigneeAgentId: agent.id,
      });
      return { created: true as const, seed, issue };
    },
    onSuccess: (result) => {
      setError(
        result.created
          ? null
          : result.reason === "no-agent"
            ? t("memory.seedNoAgent", {
              defaultValue: "You have no agent yet, so there is nothing to do the reading.",
            })
            : t("memory.seedNothing", {
              defaultValue: "There is no past work to read yet.",
            }),
      );
      invalidate();
    },
    onError: (err: Error) => setError(err.message),
  });

  const importFiles = useMutation({
    mutationFn: (files: File[]) => memoryApi.import(selectedCompanyId!, userId!, files),
    onSuccess: (result) => {
      setImportResult(result);
      setError(null);
      invalidate();
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

  const categoryLabel = (id: MemoryCategory) =>
    t(`memory.category.${id}`, { defaultValue: MEMORY_CATEGORY_LABELS[id] });

  /**
   * How settled an entry is, in words.
   *
   * `noted` is deliberately unlabelled. Almost everything is noted, and a badge
   * on every row is noise that hides the two entries where the badge means
   * something.
   */
  const strengthLabel = (strength: MemoryStrength): string | null =>
    strength === "core"
      ? t("memory.strength.core", { defaultValue: "core" })
      : strength === "confirmed"
        ? t("memory.strength.confirmed", { defaultValue: "confirmed" })
        : null;

  // Legacy rows carry `user` and other pre-taxonomy values; normalizing on read
  // means the filter matches what the chip says rather than what is stored.
  const visible = (memories ?? []).filter(
    (memory) => filter === "all" || normalizeMemoryCategory(memory.memoryType) === filter,
  );

  // Only offer a category chip for one that actually has entries — a row of
  // buttons that all lead to "nothing here" is worse than no filter.
  const presentCategories = MEMORY_CATEGORIES.map((category) => category.id).filter((id) =>
    (memories ?? []).some((memory) => normalizeMemoryCategory(memory.memoryType) === id),
  );

  /**
   * Grouped, in the taxonomy's own order.
   *
   * A flat list sorted by recency reads as a feed, and a feed is the wrong
   * mental model — it invites scrolling rather than checking. Grouped, the page
   * answers "what does it think it knows about how I like to work?" in one look,
   * which is the question people actually open it with. Same order as the
   * MEMORY.md an agent reads, so the two never disagree about shape.
   *
   * Skipped while a filter is on: one heading above one group is furniture.
   */
  const grouped = (filter === "all" && sortMode === "category" ? presentCategories : []).map((id) => ({
    id,
    memories: visible.filter((memory) => normalizeMemoryCategory(memory.memoryType) === id),
  }));

  // Flat, recency-ordered list when sorting by hotness/coldness.
  const lastSeenMs = (m: PersonalMemory) => Date.parse(m.lastObservedAt ?? m.updatedAt ?? m.createdAt) || 0;
  const sortedFlat = sortMode === "category"
    ? []
    : [...visible].sort((a, b) => sortMode === "hot" ? lastSeenMs(b) - lastSeenMs(a) : lastSeenMs(a) - lastSeenMs(b));

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 md:p-6">
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
        {/* Whether capture is working, stated rather than left to be inferred
            from whether the list looks fuller than it did last week. */}
        {stats ? (
          <p className="text-xs text-muted-foreground" data-testid="memory-capture-health">
            {stats.agentWrites === 0
              ? t("memory.noAgentWrites", {
                  defaultValue: "Your agents have not saved anything here yet.",
                })
              : t("memory.agentWrites", {
                  count: stats.agentWrites,
                  date: stats.lastAgentWriteAt
                    ? new Date(stats.lastAgentWriteAt).toLocaleDateString()
                    : "",
                  defaultValue: `Your agents saved ${stats.agentWrites} of these · last on ${
                    stats.lastAgentWriteAt
                      ? new Date(stats.lastAgentWriteAt).toLocaleDateString()
                      : "—"
                  }`,
                })}
          </p>
        ) : null}

        {/* The switch sits beside the health line on purpose: the moment anyone
            wants it is the moment they are reading what their agents saved. */}
        {stats ? (
          <label className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={stats.captureEnabled}
              disabled={setCapture.isPending}
              onChange={(event) => setCapture.mutate(event.target.checked)}
            />
            <span>
              {stats.captureEnabled
                ? t("memory.captureOn", {
                  defaultValue: "Let my agents save what they learn about me",
                })
                : t("memory.captureOff", {
                  defaultValue:
                    "Capture is paused — your agents will not save anything new. You still can.",
                })}
            </span>
          </label>
        ) : null}
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
          {/* Category is optional — the default "自動分類" lets the platform file
              the entry (or split a pasted dump into many). */}
          <select
            aria-label={t("memory.categoryLabel", { defaultValue: "Category" })}
            className="rounded-md border border-border bg-background px-3 py-2 text-sm"
            value={draft.memoryType}
            onChange={(event) =>
              setDraft((prev) => ({
                ...prev,
                memoryType: event.target.value === "auto" ? "auto" : normalizeMemoryCategory(event.target.value),
              }))
            }
          >
            <option value="auto">{t("memory.autoCategory", { defaultValue: "自動分類" })}</option>
            {MEMORY_CATEGORIES.map((category) => (
              <option key={category.id} value={category.id}>
                {categoryLabel(category.id)}
              </option>
            ))}
          </select>
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
            onClick={() => {
              // Auto mode: parse the content. A multi-entry dump opens a preview to
              // confirm the split + categories; a single note saves straight away.
              if (draft.memoryType === "auto") {
                const parsed = parseMemoryDump(draft.content);
                if (parsed.length > 1) {
                  setPreview(parsed.map((entry) => ({ content: entry.content, category: entry.category, observedAt: entry.observedAt, include: true })));
                  return;
                }
                save.mutate({
                  name: slugify(draft.name) || slugify(draft.content.slice(0, 48)) || "memory",
                  description: draft.description,
                  content: draft.content,
                  memoryType: parsed[0]?.category ?? classifyMemoryContent(draft.content),
                  observedAt: parsed[0]?.observedAt ?? null,
                });
                return;
              }
              save.mutate({
                name: slugify(draft.name) || slugify(draft.content.slice(0, 48)) || "memory",
                description: draft.description,
                content: draft.content,
                memoryType: draft.memoryType,
              });
            }}
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
            {/* Capture only ever looks forward, so someone who has been here for
                months starts from an empty page. This reads the other way. */}
            <button
              type="button"
              className="rounded-md border border-border px-3 py-2 text-sm"
              onClick={() => seedFromHistory.mutate()}
              disabled={seedFromHistory.isPending}
            >
              {seedFromHistory.isPending
                ? t("memory.seedPending", { defaultValue: "Reading your history…" })
                : t("memory.seed", { defaultValue: "Catch up from past work" })}
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

      {/* Preview + confirm a pasted dump before it lands: auto-split, each entry's
          category pre-filled and editable, deselect any you don't want. */}
      {preview ? (
        <section className="flex flex-col gap-2 rounded-lg border border-primary/40 bg-primary/5 p-4">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">
              {(() => {
                const harness = preview.filter((e) => isHarnessCategory(e.category)).length;
                const mem = preview.length - harness;
                return harness > 0
                  ? t("memory.previewTitleSplit", { defaultValue: "偵測到 {{mem}} 筆記憶與 {{harness}} 筆指示・守則（harness）", mem, harness })
                  : t("memory.previewTitle", { defaultValue: "將自動拆分並分類 {{count}} 筆記憶", count: preview.length });
              })()}
            </p>
            <div className="flex items-center gap-2">
              <button type="button" className="rounded-md border border-border px-3 py-1.5 text-sm" onClick={() => setPreview(null)}>
                {t("common.cancel", { defaultValue: "取消" })}
              </button>
              <button
                type="button"
                className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
                disabled={saveMany.isPending || preview.every((entry) => !entry.include)}
                onClick={() => saveMany.mutate(preview.filter((entry) => entry.include).map((entry) => ({ content: entry.content, category: entry.category, observedAt: entry.observedAt })))}
              >
                {saveMany.isPending
                  ? t("common.saving", { defaultValue: "儲存中…" })
                  : t("memory.saveAll", { defaultValue: "全部記住（{{count}}）", count: preview.filter((entry) => entry.include).length })}
              </button>
            </div>
          </div>
          <div className="max-h-96 space-y-1.5 overflow-y-auto overscroll-contain" onWheel={(e) => { e.currentTarget.scrollTop += e.deltaY; }}>
            {preview.map((entry, index) => (
              <div key={index} className={cn("flex items-start gap-2 rounded-md border border-border bg-background px-2 py-1.5", !entry.include && "opacity-50")}>
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={entry.include}
                  onChange={(e) => setPreview((cur) => cur && cur.map((it, i) => i === index ? { ...it, include: e.target.checked } : it))}
                />
                <span className="min-w-0 flex-1 text-xs">
                  {isHarnessCategory(entry.category) ? (
                    <span className="mr-1 rounded bg-violet-500/15 px-1 py-0.5 text-[10px] text-violet-600 dark:text-violet-400" title={t("memory.harnessTitle", { defaultValue: "harness — operating rule" })}>⚙️ {t("memory.harnessTag", { defaultValue: "harness" })}</span>
                  ) : null}
                  {entry.content}
                </span>
                <select
                  className="shrink-0 rounded border border-border bg-background px-1.5 py-1 text-xs"
                  value={entry.category}
                  onChange={(e) => setPreview((cur) => cur && cur.map((it, i) => i === index ? { ...it, category: normalizeMemoryCategory(e.target.value) } : it))}
                >
                  {MEMORY_CATEGORIES.map((category) => (
                    <option key={category.id} value={category.id}>{categoryLabel(category.id)}</option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {/* Import history: review + multiselect + delete whole batches. */}
      {(importBatches?.length ?? 0) > 0 ? (
        <section className="rounded-lg border border-border">
          <button
            type="button"
            className="flex w-full items-center justify-between px-4 py-2 text-sm hover:bg-accent/30"
            onClick={() => setShowHistory((v) => !v)}
          >
            <span className="font-medium">{t("memory.importHistory", { defaultValue: "匯入紀錄" })} ({importBatches!.length})</span>
            <span className="text-muted-foreground">{showHistory ? "▲" : "▼"}</span>
          </button>
          {showHistory ? (
            <div className="space-y-2 border-t border-border p-3">
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={selectedBatches.size === importBatches!.length && importBatches!.length > 0}
                    onChange={(e) => setSelectedBatches(e.target.checked ? new Set(importBatches!.map((b) => b.batchId)) : new Set())}
                  />
                  {t("memory.selectAll", { defaultValue: "全選" })}
                </label>
                <button
                  type="button"
                  className="rounded-md border border-destructive/50 px-3 py-1 text-xs text-destructive disabled:opacity-40"
                  disabled={selectedBatches.size === 0 || deleteBatches.isPending}
                  onClick={() => {
                    if (window.confirm(t("memory.deleteBatchesConfirm", { defaultValue: "刪除所選的 {{count}} 個匯入批次（含其所有記憶）？", count: selectedBatches.size }))) {
                      deleteBatches.mutate([...selectedBatches]);
                    }
                  }}
                >
                  {t("memory.deleteSelected", { defaultValue: "刪除所選（{{count}}）", count: selectedBatches.size })}
                </button>
              </div>
              <div className="space-y-1">
                {importBatches!.map((batch) => {
                  const on = selectedBatches.has(batch.batchId);
                  return (
                    <label key={batch.batchId} className={cn("flex items-start gap-2 rounded-md border border-border px-2 py-1.5 text-xs", on && "bg-accent/30")}>
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={on}
                        onChange={(e) => setSelectedBatches((cur) => {
                          const next = new Set(cur);
                          if (e.target.checked) next.add(batch.batchId); else next.delete(batch.batchId);
                          return next;
                        })}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="font-medium">{t("memory.batchCount", { defaultValue: "{{count}} 筆", count: batch.count })}</span>
                        <span className="text-muted-foreground"> · {new Date(batch.createdAt).toLocaleString()} · {batch.source}</span>
                        <span className="block truncate text-muted-foreground">{batch.sample}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

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

      {presentCategories.length > 1 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {(["all", ...presentCategories] as Array<MemoryCategory | "all">).map((id) => (
            <button
              key={id}
              type="button"
              aria-pressed={filter === id}
              className={`rounded-full border px-2.5 py-1 text-xs ${
                filter === id ? "border-foreground bg-foreground/10 font-medium" : "border-border"
              }`}
              onClick={() => setFilter(id)}
            >
              {id === "all" ? t("memory.category.all", { defaultValue: "All" }) : categoryLabel(id)}
            </button>
          ))}
          {/* Sort: by category (grouped) or by recency. */}
          <span className="ml-auto flex items-center gap-1">
            {([
              ["category", t("memory.sortCategory", { defaultValue: "分類" })],
              ["hot", t("memory.sortHot", { defaultValue: "🔥 最熱" })],
              ["cold", t("memory.sortCold", { defaultValue: "❄ 最冷" })],
            ] as const).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                aria-pressed={sortMode === mode}
                className={`rounded-full border px-2.5 py-1 text-xs ${sortMode === mode ? "border-foreground bg-foreground/10 font-medium" : "border-border"}`}
                onClick={() => setSortMode(mode)}
              >
                {label}
              </button>
            ))}
          </span>
        </div>
      ) : null}

      <section className="flex flex-col gap-2">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">{t("common.loading", { defaultValue: "Loading…" })}</p>
        ) : visible.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("memory.empty", { defaultValue: "Nothing remembered yet." })}
          </p>
        ) : grouped.length > 0 ? (
          grouped.map((group) => (
            <div key={group.id} className="flex flex-col gap-2">
              <h2 className="mt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {categoryLabel(group.id)}
              </h2>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {group.memories.map(renderEntry)}
              </div>
            </div>
          ))
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {(sortMode !== "category" ? sortedFlat : visible).map(renderEntry)}
          </div>
        )}
      </section>

      {/* Recovery. Closed by default and only fetched when opened — this is a
          drawer people reach for after a mistake, not part of the page. */}
      {(stats?.deleted ?? 0) > 0 || showDeleted ? (
        <section className="flex flex-col gap-2">
          <button
            type="button"
            className="self-start text-xs text-muted-foreground underline underline-offset-2"
            onClick={() => setShowDeleted((open) => !open)}
          >
            {showDeleted
              ? t("memory.hideDeleted", { defaultValue: "Hide recently deleted" })
              : t("memory.showDeleted", {
                count: stats?.deleted ?? 0,
                defaultValue: `Recently deleted (${stats?.deleted ?? 0})`,
              })}
          </button>

          {showDeleted ? (
            <div className="flex flex-col gap-2">
              <p className="text-xs text-muted-foreground">
                {t("memory.deletedWindow", {
                  days: MEMORY_RECOVERY_WINDOW_DAYS,
                  defaultValue: `Deleted memories can be restored for ${MEMORY_RECOVERY_WINDOW_DAYS} days, then they are gone for good. Agents stopped reading them the moment you deleted them.`,
                })}
              </p>
              {(deletedMemories ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t("memory.noDeleted", { defaultValue: "Nothing deleted recently." })}
                </p>
              ) : (
                (deletedMemories ?? []).map((memory: PersonalMemory) => (
                  <article
                    key={memory.name}
                    className="flex items-start gap-3 rounded-lg border border-dashed border-border px-4 py-3 opacity-75"
                  >
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <p className="whitespace-pre-wrap break-words text-sm line-through">
                        {memory.isBinary ? memory.filePath ?? memory.name : memory.content}
                      </p>
                      <p className="text-xs text-muted-foreground">{memory.name}</p>
                    </div>
                    <button
                      type="button"
                      aria-label={t("memory.restore", { defaultValue: "Restore" })}
                      className="rounded-md border border-border p-1.5"
                      onClick={() => restore.mutate(memory.name)}
                      disabled={restore.isPending}
                    >
                      <RotateCcw className="size-3.5" />
                    </button>
                    {/* "Delete forever" lives only here. By the time someone has
                        opened the recovery drawer the decision is deliberate,
                        which is exactly when an irreversible button is safe. */}
                    <button
                      type="button"
                      aria-label={t("memory.purge", { defaultValue: "Delete forever" })}
                      className="rounded-md border border-destructive/40 p-1.5 text-destructive"
                      onClick={() => remove.mutate({ name: memory.name, purge: true })}
                      disabled={remove.isPending}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </article>
                ))
              )}
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );

  /**
   * One remembered thing.
   *
   * The metadata line answers the three questions people actually have about an
   * entry they did not write: what kind of thing is it, who decided that, and
   * how sure is it. Anything beyond that belongs in the row's absence — the
   * fastest way to disagree with a memory is to delete it.
   */
  function renderEntry(memory: PersonalMemory) {
    const strength = strengthLabel(memoryStrength(memory.timesObserved));
    const recency = memoryRecency(memory.lastObservedAt ?? memory.updatedAt ?? memory.createdAt, nowMs);
    const content = memory.isBinary
      ? t("memory.binaryEntry", { path: memory.filePath ?? memory.name, defaultValue: `Attached file: ${memory.filePath ?? memory.name}` })
      : memory.content;
    return (
      <article
        key={memory.name}
        className="group/card flex h-full flex-col gap-2 rounded-lg border border-border p-3"
      >
        <p className="line-clamp-6 whitespace-pre-wrap break-words text-sm" title={content ?? undefined}>
          {content}
        </p>
        <div className="mt-auto flex items-end gap-1.5">
          <p className="flex flex-1 flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
            <span className="rounded-full border border-border px-1.5 py-0.5">
              {categoryLabel(normalizeMemoryCategory(memory.memoryType))}
            </span>
            <RecencyBadge recency={recency} />
            {memory.source !== "manual" ? <span className="rounded-full bg-foreground/5 px-1.5 py-0.5">{memory.source}</span> : null}
            {memory.timesObserved > 1 ? (
              <span>{t("memory.timesObserved", { count: memory.timesObserved, defaultValue: `seen ${memory.timesObserved}×` })}</span>
            ) : null}
            {strength ? <span className="rounded-full bg-foreground/10 px-1.5 py-0.5">{strength}</span> : null}
          </p>
          <button
            type="button"
            aria-label={t("memory.forget", { defaultValue: "Forget" })}
            className="shrink-0 rounded-md border border-border p-1.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover/card:opacity-100 focus-visible:opacity-100"
            onClick={() => remove.mutate({ name: memory.name })}
            disabled={remove.isPending}
          >
            <Trash2 className="size-3.5" />
          </button>
        </div>
      </article>
    );
  }
}

/** Small recency badge: 🔥 hot / warm / cold, derived from when the fact was last seen. */
function RecencyBadge({ recency }: { recency: MemoryRecency }) {
  const { t } = useTranslation();
  if (recency === "hot") {
    return <span className="rounded-full bg-orange-500/15 px-1.5 py-0.5 text-orange-600 dark:text-orange-400" title={t("memory.hotTitle", { defaultValue: "hot — recently relevant" })}>🔥 {t("memory.hotTag", { defaultValue: "hot" })}</span>;
  }
  if (recency === "warm") {
    return <span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-amber-600 dark:text-amber-400" title="warm">warm</span>;
  }
  return <span className="rounded-full border border-border px-1.5 py-0.5 text-muted-foreground/70" title={t("memory.coldTitle", { defaultValue: "cold — not seen in a while" })}>{t("memory.coldTag", { defaultValue: "cold" })}</span>;
}

export default Memory;
