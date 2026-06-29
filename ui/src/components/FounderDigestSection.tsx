import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Check, Loader2, ChevronDown, ChevronRight } from "lucide-react";
import { useTranslation } from "@/i18n";
import { dashboardApi, type FounderDigest, type FounderItem } from "../api/dashboard";
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
 * Founder daily-calendar console (創辦人每日行事曆). Four priority blocks; 待批閱
 * items expand to the agent's summary + DRAFT 批閱 with an Approve button (the
 * agent never auto-submits — approval routes back through the agent). Renders
 * nothing until a founder digest exists, so it's inert for non-founder users.
 */
export function FounderDigestSection({ companyId }: { companyId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: KEY(companyId),
    queryFn: () => dashboardApi.founderDigest(companyId),
    enabled: !!companyId,
    staleTime: 60_000,
  });

  const approve = useMutation({
    mutationFn: ({ gid, approved }: { gid: string; approved: boolean }) => dashboardApi.approveFounderItem(companyId, gid, approved),
    onMutate: async ({ gid, approved }) => {
      await queryClient.cancelQueries({ queryKey: KEY(companyId) });
      const prev = queryClient.getQueryData<FounderDigest>(KEY(companyId));
      if (prev?.categories) {
        const apply = (l: FounderItem[]) => (l ?? []).map((it) => (it.gid === gid ? { ...it, approved } : it));
        queryClient.setQueryData<FounderDigest>(KEY(companyId), {
          ...prev,
          categories: {
            urgent: apply(prev.categories.urgent),
            meetings: apply(prev.categories.meetings),
            nonUrgent: apply(prev.categories.nonUrgent),
            reminders: apply(prev.categories.reminders),
          },
        });
      }
      return { prev };
    },
    onError: (_e, _v, ctx) => ctx?.prev && queryClient.setQueryData(KEY(companyId), ctx.prev),
    onSettled: (res) => res?.digest && queryClient.setQueryData(KEY(companyId), res.digest),
  });
  const pendingGid = approve.isPending ? approve.variables?.gid : undefined;

  const cats = data?.categories;
  const total = cats ? cats.urgent.length + cats.meetings.length + cats.nonUrgent.length + cats.reminders.length : 0;
  if (!cats || total === 0) return null;

  const pendingApproval =
    [...cats.urgent, ...cats.nonUrgent].filter((it) => (it.summary || it.review) && !it.approved).length;
  const generated = data?.generatedAt ? new Date(data.generatedAt) : null;

  return (
    <div className="space-y-3">
      {/* Founder workflow status bar */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <StatTile label="🔴 急件待批" value={cats.urgent.length} tone="red" />
        <StatTile label="📅 今日會議" value={cats.meetings.length} tone="sky" />
        <StatTile label="🟡 非急件待批" value={cats.nonUrgent.length} tone="amber" />
        <StatTile label="🔔 提醒" value={cats.reminders.length} tone="violet" />
        <StatTile label={t("founder.pendingApproval", { defaultValue: "Awaiting your approval" })} value={pendingApproval} tone="primary" highlight />
      </div>
      {(generated || data?.lastRunLabel) && (
        <p className="text-[11px] text-muted-foreground">
          {t("asana.updatedAt", { defaultValue: "Updated" })} {generated ? generated.toLocaleString() : ""}
          {data?.lastRunLabel ? ` · ${data.lastRunLabel}` : ""}
        </p>
      )}

      {/* Four priority blocks */}
      <div className="grid gap-4 lg:grid-cols-2">
        {CATS.map((c) => {
          const items = cats[c.key];
          // Review blocks (急件 / 非急件) get an approval progress bar: how many
          // draft 批閱 you've cleared. Meetings/reminders have no done-state, so
          // they show just their count.
          const isReview = c.kind === "review";
          const total = items.length;
          const approvedCount = isReview ? items.filter((it) => it.approved).length : 0;
          const pct = isReview && total > 0 ? Math.round((approvedCount / total) * 100) : 0;
          return (
            <Card key={c.key} className={cn("border-l-4", c.accent)}>
              <CardHeader className="flex flex-row items-center justify-between gap-2 px-5 pt-5 pb-2">
                <CardTitle className="text-base">{c.title}</CardTitle>
                {isReview && total > 0 ? (
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {t("founder.approvedProgress", { done: approvedCount, total, defaultValue: "{{done}}/{{total}} approved" })}
                  </span>
                ) : (
                  <span className="text-xs tabular-nums text-muted-foreground">{total}</span>
                )}
              </CardHeader>
              {isReview && total > 0 && (
                <div
                  className="mx-5 mb-1 h-1.5 overflow-hidden rounded-full bg-muted"
                  role="progressbar"
                  aria-valuenow={approvedCount}
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
                        onApprove={(approved) => approve.mutate({ gid: it.gid, approved })}
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

function FounderRow({
  item,
  kind,
  pending,
  onApprove,
}: {
  item: FounderItem;
  kind: "review" | "meeting" | "reminder";
  pending: boolean;
  onApprove: (approved: boolean) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const hasDetail = kind === "review" ? !!(item.summary || item.review || item.notes) : kind === "meeting" ? !!(item.prep || item.notes) : !!item.notes;

  return (
    <li className="py-2 text-sm">
      <div className="flex items-start gap-2">
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
          <a href={item.permalinkUrl} target="_blank" rel="noreferrer" className="group min-w-0 flex-1 hover:underline">
            {item.name}
            <ExternalLink className="ml-1 inline h-3 w-3 align-text-top text-muted-foreground/0 transition-colors group-hover:text-muted-foreground" />
          </a>
        ) : (
          <span className="min-w-0 flex-1">{item.name}</span>
        )}
        {kind === "review" && item.triage && !item.approved && (
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
        {kind === "review" && (
          item.approved ? (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-emerald-500/40 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
              <Check className="h-3 w-3" />{t("founder.approved", { defaultValue: "Approved" })}
            </span>
          ) : (
            <button
              type="button"
              onClick={() => onApprove(true)}
              disabled={pending}
              className="shrink-0 rounded-md border border-primary/50 px-2 py-0.5 text-[11px] font-medium text-primary hover:bg-primary/10 disabled:opacity-50"
            >
              {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : t("founder.approve", { defaultValue: "Approve" })}
            </button>
          )
        )}
      </div>

      {open && (
        <div className="ml-6 mt-2 space-y-2 text-xs">
          {kind === "review" && item.summary && (
            <Block label={t("founder.summary", { defaultValue: "AI summary" })} text={item.summary} />
          )}
          {kind === "review" && item.review && (
            <Block label={t("founder.draftReview", { defaultValue: "Draft 批閱 (review before approving)" })} text={item.review} accent />
          )}
          {kind === "meeting" && item.prep && (
            <Block label={t("founder.meetingPrep", { defaultValue: "Meeting prep" })} text={item.prep} />
          )}
          {item.notes && <Block label={t("founder.source", { defaultValue: "From Asana" })} text={item.notes} muted />}
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
