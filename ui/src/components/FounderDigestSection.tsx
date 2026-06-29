import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Check, Loader2, ChevronDown, ChevronRight, MessageSquare, X, RotateCcw } from "lucide-react";
import { useTranslation } from "@/i18n";
import { dashboardApi, type DailyConsole, type FounderConsolesResponse, type FounderDecision, type FounderItem } from "../api/dashboard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "../lib/utils";

const KEY = (companyId: string) => ["founder-digest", companyId];

type CatKey = "urgent" | "meetings" | "nonUrgent" | "reminders";
const CATS: { key: CatKey; title: string; kind: "review" | "meeting" | "reminder"; accent: string; dot: string }[] = [
  { key: "urgent", title: "🔴 待批閱・急件", kind: "review", accent: "border-l-red-500", dot: "bg-red-500" },
  { key: "meetings", title: "📅 今日會議與行程", kind: "meeting", accent: "border-l-sky-500", dot: "bg-sky-500" },
  { key: "nonUrgent", title: "🟡 待批閱・非急件", kind: "review", accent: "border-l-amber-500", dot: "bg-amber-500" },
  { key: "reminders", title: "🔔 提醒事項", kind: "reminder", accent: "border-l-violet-500", dot: "bg-violet-500" },
];

/**
 * Daily-calendar console(s) for allowlisted leaders. Renders one 4-block group
 * per console the caller has on their own agent (創辦人 and/or 園長). 待批閱 items
 * expand to the agent's summary + DRAFT 批閱 with 核准/請求變更/拒絕 verdicts;
 * meetings/reminders get a 結案 toggle. Renders nothing for non-console users.
 */
export function FounderDigestSection({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: KEY(companyId),
    queryFn: () => dashboardApi.founderConsoles(companyId),
    enabled: !!companyId,
    staleTime: 60_000,
  });

  // Optimistically patch one item (by gid) across every console's categories.
  const optimisticPatch = async (gid: string, patch: Partial<FounderItem>) => {
    await queryClient.cancelQueries({ queryKey: KEY(companyId) });
    const prev = queryClient.getQueryData<FounderConsolesResponse>(KEY(companyId));
    if (prev?.consoles) {
      const apply = (l: FounderItem[]) => (l ?? []).map((it) => (it.gid === gid ? { ...it, ...patch } : it));
      const consoles = prev.consoles.map((con) => ({
        ...con,
        digest: {
          ...con.digest,
          categories: {
            urgent: apply(con.digest.categories.urgent),
            meetings: apply(con.digest.categories.meetings),
            nonUrgent: apply(con.digest.categories.nonUrgent),
            reminders: apply(con.digest.categories.reminders),
          },
        },
      }));
      queryClient.setQueryData<FounderConsolesResponse>(KEY(companyId), { ...prev, consoles });
    }
    return { prev };
  };
  const rollback = (_e: unknown, _v: unknown, ctx: { prev?: FounderConsolesResponse } | undefined) =>
    ctx?.prev && queryClient.setQueryData(KEY(companyId), ctx.prev);
  const settle = () => queryClient.invalidateQueries({ queryKey: KEY(companyId) });

  const decide = useMutation({
    mutationFn: ({ gid, decision, note }: { gid: string; decision: FounderDecision | null; note?: string }) =>
      dashboardApi.decideFounderItem(companyId, gid, decision, note),
    onMutate: ({ gid, decision, note }) => optimisticPatch(gid, { decision, decisionNote: note?.trim() || null }),
    onError: rollback,
    onSettled: settle,
  });
  const close = useMutation({
    mutationFn: ({ gid, closed }: { gid: string; closed: boolean }) => dashboardApi.closeFounderItem(companyId, gid, closed),
    onMutate: ({ gid, closed }) => optimisticPatch(gid, { closed }),
    onError: rollback,
    onSettled: settle,
  });
  const pendingGid =
    (decide.isPending ? decide.variables?.gid : undefined) ?? (close.isPending ? close.variables?.gid : undefined);

  const consoles = data?.consoles ?? [];
  if (consoles.length === 0) return null;
  const showTitle = consoles.length > 1; // only label each group when there's more than one

  return (
    <div className="space-y-6">
      {consoles.map((con) => (
        <ConsoleView
          key={con.key}
          console={con}
          showTitle={showTitle}
          pendingGid={pendingGid}
          onDecide={(gid, decision, note) => decide.mutate({ gid, decision, note })}
          onClose={(gid, closed) => close.mutate({ gid, closed })}
        />
      ))}
    </div>
  );
}

/** One console: the status-tile bar + four priority blocks. */
function ConsoleView({
  console: con,
  showTitle,
  pendingGid,
  onDecide,
  onClose,
}: {
  console: DailyConsole;
  showTitle: boolean;
  pendingGid: string | undefined;
  onDecide: (gid: string, decision: FounderDecision | null, note?: string) => void;
  onClose: (gid: string, closed: boolean) => void;
}) {
  const { t } = useTranslation();
  const cats = con.digest.categories;
  const pendingApproval = [...cats.urgent, ...cats.nonUrgent].filter((it) => (it.summary || it.review) && !it.decision).length;
  const generated = con.digest.generatedAt ? new Date(con.digest.generatedAt) : null;

  return (
    <div className="space-y-3">
      {showTitle && <h2 className="text-sm font-semibold text-foreground/80">{con.title}</h2>}
      {/* Workflow status bar */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <StatTile label="🔴 急件待批" value={cats.urgent.length} tone="red" />
        <StatTile label="📅 今日會議" value={cats.meetings.length} tone="sky" />
        <StatTile label="🟡 非急件待批" value={cats.nonUrgent.length} tone="amber" />
        <StatTile label="🔔 提醒" value={cats.reminders.length} tone="violet" />
        <StatTile label={t("founder.pendingApproval", { defaultValue: "Awaiting your approval" })} value={pendingApproval} tone="primary" highlight />
      </div>
      {(generated || con.digest.lastRunLabel) && (
        <p className="text-[11px] text-muted-foreground">
          {t("asana.updatedAt", { defaultValue: "Updated" })} {generated ? generated.toLocaleString() : ""}
          {con.digest.lastRunLabel ? ` · ${con.digest.lastRunLabel}` : ""}
        </p>
      )}

      {/* Four priority blocks */}
      <div className="grid gap-4 lg:grid-cols-2">
        {CATS.map((c) => {
          const items = cats[c.key];
          // Every block shows a progress bar of items the founder has cleared:
          // review blocks count any verdict (decision); meetings/reminders count 結案.
          const isReview = c.kind === "review";
          const total = items.length;
          const handledCount = items.filter((it) => (isReview ? !!it.decision : it.closed)).length;
          const pct = total > 0 ? Math.round((handledCount / total) * 100) : 0;
          return (
            <Card key={c.key} className={cn("border-l-4", c.accent)}>
              <CardHeader className="flex flex-row items-center justify-between gap-2 px-5 pt-5 pb-2">
                <CardTitle className="text-base">{c.title}</CardTitle>
                {total > 0 ? (
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {t("founder.handledProgress", { done: handledCount, total, defaultValue: "{{done}}/{{total}} handled" })}
                  </span>
                ) : (
                  <span className="text-xs tabular-nums text-muted-foreground">{total}</span>
                )}
              </CardHeader>
              {total > 0 && (
                <div
                  className="mx-5 mb-1 h-1.5 overflow-hidden rounded-full bg-muted"
                  role="progressbar"
                  aria-valuenow={handledCount}
                  aria-valuemin={0}
                  aria-valuemax={total}
                >
                  <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} />
                </div>
              )}
              <CardContent className="px-5 pb-5 pt-1">
                {items.length === 0 ? (
                  <p className="py-2 text-sm text-muted-foreground">{t("founder.noItems", { defaultValue: "Nothing here." })}</p>
                ) : (
                  <ul className="divide-y divide-border">
                    {items.map((it) => (
                      <FounderRow
                        key={it.gid}
                        item={it}
                        kind={c.kind}
                        pending={pendingGid === it.gid}
                        onDecide={(decision, note) => onDecide(it.gid, decision, note)}
                        onClose={(closed) => onClose(it.gid, closed)}
                      />
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

const TONE: Record<string, string> = {
  red: "text-red-500",
  sky: "text-sky-500",
  amber: "text-amber-500",
  violet: "text-violet-500",
  primary: "text-primary",
};

function StatTile({ label, value, tone, highlight }: { label: string; value: number; tone: string; highlight?: boolean }) {
  return (
    <div className={cn("rounded-lg border px-3 py-2", highlight && value > 0 ? "border-primary/50 bg-primary/5" : "border-border bg-card")}>
      <div className="truncate text-[11px] text-muted-foreground">{label}</div>
      <div className={cn("mt-0.5 text-2xl font-bold tabular-nums", value > 0 ? TONE[tone] : "text-muted-foreground")}>{value}</div>
    </div>
  );
}

/** Visual + label config for each decided verdict. */
const DECISION_META: Record<
  FounderDecision,
  { icon: typeof Check; labelKey: string; fallback: string; badge: string }
> = {
  approved: {
    icon: Check,
    labelKey: "founder.approved",
    fallback: "已核准",
    badge: "border-emerald-500/40 text-emerald-600 dark:text-emerald-400",
  },
  changes_requested: {
    icon: MessageSquare,
    labelKey: "founder.changesRequested",
    fallback: "已請求變更",
    badge: "border-amber-500/40 text-amber-600 dark:text-amber-400",
  },
  rejected: {
    icon: X,
    labelKey: "founder.rejected",
    fallback: "已拒絕",
    badge: "border-red-500/40 text-red-600 dark:text-red-400",
  },
};

/** The three action buttons offered on an undecided 待批閱 item. */
const DECISION_ACTIONS: { decision: FounderDecision; labelKey: string; fallback: string; cls: string }[] = [
  { decision: "approved", labelKey: "founder.approve", fallback: "核准", cls: "border-emerald-500/50 text-emerald-700 hover:bg-emerald-500/10 dark:text-emerald-400" },
  { decision: "changes_requested", labelKey: "founder.requestChanges", fallback: "請求變更", cls: "border-amber-500/50 text-amber-700 hover:bg-amber-500/10 dark:text-amber-400" },
  { decision: "rejected", labelKey: "founder.reject", fallback: "拒絕", cls: "border-red-500/50 text-red-700 hover:bg-red-500/10 dark:text-red-400" },
];

function FounderRow({
  item,
  kind,
  pending,
  onDecide,
  onClose,
}: {
  item: FounderItem;
  kind: "review" | "meeting" | "reminder";
  pending: boolean;
  onDecide: (decision: FounderDecision | null, note?: string) => void;
  onClose: (closed: boolean) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  // Which verdict the founder is composing a note for (null = not composing).
  const [composing, setComposing] = useState<FounderDecision | null>(null);
  const [note, setNote] = useState("");
  const hasDetail = kind === "review" ? !!(item.summary || item.review || item.notes) : kind === "meeting" ? !!(item.prep || item.notes) : !!item.notes;
  const isReview = kind === "review";

  const submit = () => {
    if (!composing) return;
    onDecide(composing, note);
    setComposing(null);
    setNote("");
  };

  return (
    <li className="py-2 text-sm">
      <div className="flex flex-col gap-1.5 sm:flex-row sm:items-start sm:gap-2">
        <div className="flex min-w-0 flex-1 items-start gap-2">
        <button
          type="button"
          onClick={() => hasDetail && setOpen((v) => !v)}
          className={cn("mt-0.5 shrink-0 text-muted-foreground", hasDetail ? "hover:text-foreground" : "opacity-0")}
          aria-label={t("asana.toggleDetails", { defaultValue: "Toggle details" })}
          aria-expanded={open}
        >
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
        {item.permalinkUrl ? (
          <a href={item.permalinkUrl} target="_blank" rel="noreferrer" className={cn("group min-w-0 flex-1 hover:underline", item.closed && "text-muted-foreground line-through")}>
            {item.name}
            <ExternalLink className="ml-1 inline h-3 w-3 align-text-top text-muted-foreground/0 transition-colors group-hover:text-muted-foreground" />
          </a>
        ) : (
          <span className={cn("min-w-0 flex-1", item.closed && "text-muted-foreground line-through")}>{item.name}</span>
        )}
        {isReview && item.triage && !item.decision && (
          <span
            className={cn(
              "inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium",
              item.triage === "now"
                ? "border border-emerald-500/40 text-emerald-600 dark:text-emerald-400"
                : "border border-amber-500/40 text-amber-600 dark:text-amber-400",
            )}
          >
            {item.triage === "now"
              ? t("founder.triageNow", { defaultValue: "現在可先處理" })
              : t("founder.triageEvening", { defaultValue: "留待晚上" })}
          </span>
        )}
        </div>
        {isReview && (item.decision ? (
          // Decided → verdict badge + a quiet undo (reverts to undecided).
          <div className="flex shrink-0 items-center gap-1">
            <span className={cn("inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium", DECISION_META[item.decision].badge)}>
              {(() => { const Icon = DECISION_META[item.decision].icon; return <Icon className="h-3 w-3" />; })()}
              {t(DECISION_META[item.decision].labelKey, { defaultValue: DECISION_META[item.decision].fallback })}
            </span>
            <button
              type="button"
              onClick={() => onDecide(null)}
              disabled={pending}
              aria-label={t("founder.reset", { defaultValue: "Reset decision" })}
              className="rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
            </button>
          </div>
        ) : (
          // Undecided → three verdict buttons (open an optional-note composer).
          <div className="flex shrink-0 flex-wrap items-center gap-1">
            {DECISION_ACTIONS.map((a) => (
              <button
                key={a.decision}
                type="button"
                onClick={() => { setComposing(a.decision); setNote(""); }}
                disabled={pending}
                className={cn("rounded-md border px-2 py-0.5 text-[11px] font-medium disabled:opacity-50", a.cls)}
              >
                {t(a.labelKey, { defaultValue: a.fallback })}
              </button>
            ))}
          </div>
        ))}
        {!isReview && (item.closed ? (
          // 已結案 → badge + quiet reopen.
          <div className="flex shrink-0 items-center gap-1">
            <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
              <Check className="h-3 w-3" />{t("founder.closed", { defaultValue: "已結案" })}
            </span>
            <button
              type="button"
              onClick={() => onClose(false)}
              disabled={pending}
              aria-label={t("founder.reopen", { defaultValue: "Reopen" })}
              className="rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => onClose(true)}
            disabled={pending}
            className="shrink-0 rounded-md border border-primary/50 px-2 py-0.5 text-[11px] font-medium text-primary hover:bg-primary/10 disabled:opacity-50"
          >
            {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : t("founder.close", { defaultValue: "結案" })}
          </button>
        ))}
      </div>

      {/* Optional comment / suggestion composer for the chosen verdict. */}
      {composing && (
        <div className="ml-6 mt-2 space-y-2">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            autoFocus
            placeholder={t("founder.notePlaceholder", { defaultValue: "留言 / 建議（選填）— 將張貼為 Asana 評論" })}
            className="w-full rounded-md border border-border bg-background p-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={submit}
              disabled={pending}
              className={cn(
                "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium disabled:opacity-50",
                DECISION_ACTIONS.find((a) => a.decision === composing)?.cls,
              )}
            >
              {pending && <Loader2 className="h-3 w-3 animate-spin" />}
              {(() => {
                const a = DECISION_ACTIONS.find((x) => x.decision === composing)!;
                return `${t("founder.confirm", { defaultValue: "Confirm" })} · ${t(a.labelKey, { defaultValue: a.fallback })}`;
              })()}
            </button>
            <button
              type="button"
              onClick={() => { setComposing(null); setNote(""); }}
              className="rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              {t("common.cancel", { defaultValue: "Cancel" })}
            </button>
          </div>
        </div>
      )}

      {open && (
        <div className="ml-6 mt-2 space-y-2 text-xs">
          {isReview && item.summary && (
            <Block label={t("founder.summary", { defaultValue: "AI summary" })} text={item.summary} />
          )}
          {isReview && item.review && (
            <Block label={t("founder.draftReview", { defaultValue: "Draft 批閱 (review before approving)" })} text={item.review} accent />
          )}
          {kind === "meeting" && item.prep && (
            <Block label={t("founder.meetingPrep", { defaultValue: "Meeting prep" })} text={item.prep} />
          )}
          {item.notes && <Block label={t("founder.source", { defaultValue: "From Asana" })} text={item.notes} muted />}
        </div>
      )}

      {/* The founder's own comment, once recorded — shown inline even when collapsed. */}
      {item.decision && item.decisionNote && (
        <div className="ml-6 mt-2 rounded-md border border-border bg-muted/20 p-2 text-xs">
          <div className="mb-0.5 font-medium text-muted-foreground">{t("founder.yourNote", { defaultValue: "Your note" })}</div>
          <p className="whitespace-pre-wrap break-words text-foreground">{item.decisionNote}</p>
        </div>
      )}
    </li>
  );
}

function Block({ label, text, accent, muted }: { label: string; text: string; accent?: boolean; muted?: boolean }) {
  return (
    <div className={cn("rounded-md border p-2", accent ? "border-primary/30 bg-primary/5" : "border-border", muted && "opacity-80")}>
      <div className="mb-0.5 font-medium text-muted-foreground">{label}</div>
      <p className="whitespace-pre-wrap break-words text-foreground">{text}</p>
    </div>
  );
}
