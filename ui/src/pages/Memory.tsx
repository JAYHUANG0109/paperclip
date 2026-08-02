import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCcw, Trash2, Upload } from "lucide-react";
import {
  DEFAULT_MEMORY_CATEGORY,
  MEMORY_CATEGORIES,
  MEMORY_CATEGORY_LABELS,
  MEMORY_RECOVERY_WINDOW_DAYS,
  memoryStrength,
  normalizeMemoryCategory,
  type MemoryCategory,
  type MemoryStrength,
} from "@paperclipai/shared";
import { useTranslation } from "@/i18n";
import { accessApi } from "@/api/access";
import { agentsApi } from "@/api/agents";
import { issuesApi } from "@/api/issues";
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

  const [draft, setDraft] = useState<{
    name: string;
    description: string;
    content: string;
    memoryType: MemoryCategory;
  }>({ name: "", description: "", content: "", memoryType: DEFAULT_MEMORY_CATEGORY });
  const [importResult, setImportResult] = useState<MemoryImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Which category is being shown, or "all". Not persisted — a view, not a setting. */
  const [filter, setFilter] = useState<MemoryCategory | "all">("all");
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

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: memoriesKey });
    void queryClient.invalidateQueries({ queryKey: statsKey });
    void queryClient.invalidateQueries({ queryKey: deletedKey });
  };

  const save = useMutation({
    mutationFn: (memory: {
      name: string;
      description: string;
      content: string;
      memoryType: MemoryCategory;
    }) =>
      memoryApi.save(selectedCompanyId!, userId!, memory.name, {
        content: memory.content,
        description: memory.description,
        memoryType: memory.memoryType,
      }),
    onSuccess: () => {
      setDraft({ name: "", description: "", content: "", memoryType: DEFAULT_MEMORY_CATEGORY });
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
  const grouped = (filter === "all" ? presentCategories : []).map((id) => ({
    id,
    memories: visible.filter((memory) => normalizeMemoryCategory(memory.memoryType) === id),
  }));

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
          {/* Category is required on every write, so it is a control with a
              default rather than an optional extra someone has to remember. */}
          <select
            aria-label={t("memory.categoryLabel", { defaultValue: "Category" })}
            className="rounded-md border border-border bg-background px-3 py-2 text-sm"
            value={draft.memoryType}
            onChange={(event) =>
              setDraft((prev) => ({
                ...prev,
                memoryType: normalizeMemoryCategory(event.target.value),
              }))
            }
          >
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
            onClick={() =>
              save.mutate({
                // Fall back to a slug of the content so a quick note does not
                // require inventing a label first.
                name: slugify(draft.name) || slugify(draft.content.slice(0, 48)) || "memory",
                description: draft.description,
                content: draft.content,
                memoryType: draft.memoryType,
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
              {group.memories.map(renderEntry)}
            </div>
          ))
        ) : (
          visible.map(renderEntry)
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
    return (
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
          <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span className="rounded-full border border-border px-1.5 py-0.5">
              {categoryLabel(normalizeMemoryCategory(memory.memoryType))}
            </span>
            <span>{memory.name}</span>
            {memory.source !== "manual" ? <span>· {memory.source}</span> : null}
            {/* Repetition is why an agent-written entry is trusted, so it
                is shown rather than kept as an internal ranking signal. */}
            {memory.timesObserved > 1 ? (
              <span>
                ·{" "}
                {t("memory.timesObserved", {
                  count: memory.timesObserved,
                  defaultValue: `seen ${memory.timesObserved}×`,
                })}
              </span>
            ) : null}
            {strength ? (
              <span className="rounded-full bg-foreground/10 px-1.5 py-0.5">{strength}</span>
            ) : null}
          </p>
        </div>
        <button
          type="button"
          aria-label={t("memory.forget", { defaultValue: "Forget" })}
          className="rounded-md border border-border p-1.5"
          onClick={() => remove.mutate({ name: memory.name })}
          disabled={remove.isPending}
        >
          <Trash2 className="size-3.5" />
        </button>
      </article>
    );
  }
}

export default Memory;
