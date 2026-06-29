import { useEffect, useMemo, useState } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { Trophy, Crown, Medal, Award, Search, ArrowUp, ArrowDown, ChevronsUpDown } from "lucide-react";
import { useTranslation } from "@/i18n";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { leaderboardApi, type LeaderboardEntry } from "../api/leaderboard";
import { cn } from "../lib/utils";
import { queryKeys } from "../lib/queryKeys";

function currentMonth(): string {
  // Server stamps usage with its own clock; the UI just needs a YYYY-MM label.
  return new Date().toISOString().slice(0, 7);
}

// Distinct medal/tier identity for the top three — this is what sets the
// leaderboard apart from the issue/card pages (gold / silver / bronze).
const TIER = [
  {
    Icon: Crown,
    ring: "ring-amber-400/50",
    border: "border-amber-400/60",
    grad: "from-amber-100/80 to-transparent dark:from-amber-500/15",
    badge: "bg-amber-400 text-amber-950",
    icon: "text-amber-500",
    bar: "bg-amber-400",
    labelKey: "leaderboard.tierChampion",
    labelDefault: "Champion",
  },
  {
    Icon: Medal,
    ring: "ring-slate-300/50",
    border: "border-slate-300/60 dark:border-slate-500/50",
    grad: "from-slate-100/80 to-transparent dark:from-slate-400/10",
    badge: "bg-slate-300 text-slate-900 dark:bg-slate-400",
    icon: "text-slate-400",
    bar: "bg-slate-400",
    labelKey: "leaderboard.tierRunnerUp",
    labelDefault: "Runner-up",
  },
  {
    Icon: Award,
    ring: "ring-orange-400/40",
    border: "border-orange-400/50",
    grad: "from-orange-100/70 to-transparent dark:from-orange-700/10",
    badge: "bg-orange-400 text-orange-950",
    icon: "text-orange-500",
    bar: "bg-orange-400",
    labelKey: "leaderboard.tierThird",
    labelDefault: "Third place",
  },
] as const;

type SortKey = "score" | "minutesSaved" | "usageMinutes" | "skillCount" | "beneficiaries" | "bountyCount" | "runCount";

export function Leaderboard() {
  const { t } = useTranslation();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [tab, setTab] = useState<"month" | "lifetime">("month");
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("score");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const month = currentMonth();

  useEffect(() => {
    setBreadcrumbs([{ label: t("leaderboard.title", { defaultValue: "Leaderboard & Awards" }) }]);
  }, [setBreadcrumbs, t]);

  const scope = tab === "month" ? month : "lifetime";
  const { data, isPending } = useQuery({
    queryKey: queryKeys.leaderboard(selectedCompanyId ?? "", scope),
    queryFn: () => leaderboardApi.get(selectedCompanyId!, tab === "month" ? month : undefined),
    enabled: !!selectedCompanyId,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });

  const entries = data?.entries ?? [];
  const podium = entries.slice(0, 3);
  const topScore = entries[0]?.score ?? 0;
  // Rank is always by score (the canonical standing); the table sort is a view-only re-order.
  const rankByUser = useMemo(() => {
    const m = new Map<string, number>();
    entries.forEach((e, i) => m.set(e.userId, i + 1));
    return m;
  }, [entries]);

  const tableRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q ? entries.filter((e) => e.displayName.toLowerCase().includes(q)) : entries;
    const dir = sortDir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => (Number(a[sortKey] ?? 0) - Number(b[sortKey] ?? 0)) * dir);
  }, [entries, query, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  const awards = useMemo(() => [
    { key: "awardChampion", awardKey: "champion", emoji: "🏆", accent: "border-l-amber-400" },
    { key: "awardLifetime", awardKey: "lifetime", emoji: "💎", accent: "border-l-sky-400" },
    { key: "awardCrossDept", awardKey: "crossDept", emoji: "🌐", accent: "border-l-emerald-400" },
    { key: "awardBounty", awardKey: "bounty", emoji: "🎯", accent: "border-l-rose-400" },
    { key: "awardViral", awardKey: "viral", emoji: "🦠", accent: "border-l-violet-400" },
    { key: "awardRookie", awardKey: "rookie", emoji: "🌟", accent: "border-l-yellow-400" },
  ], []);
  const winnerByKey = useMemo(
    () => new Map((data?.awards ?? []).filter((a) => a.winnerName).map((a) => [a.awardKey, a])),
    [data],
  );

  const columns: { key: SortKey; label: string; default: string }[] = [
    { key: "score", label: "leaderboard.score", default: "Score" },
    { key: "minutesSaved", label: "leaderboard.minutesSaved", default: "Minutes saved" },
    { key: "usageMinutes", label: "leaderboard.minutesUsed", default: "Minutes used" },
    { key: "skillCount", label: "leaderboard.skills", default: "Skills" },
    { key: "beneficiaries", label: "leaderboard.beneficiaries", default: "Beneficiaries" },
    { key: "bountyCount", label: "leaderboard.bounties", default: "Bounties" },
    { key: "runCount", label: "leaderboard.runs", default: "Runs" },
  ];

  return (
    <div className="w-full max-w-6xl space-y-6">
      {/* Header */}
      <div className="flex items-start gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-amber-400 to-orange-500 shadow-sm">
          <Trophy className="h-5 w-5 text-white" />
        </div>
        <div>
          <h1 className="text-2xl font-bold">{t("leaderboard.title", { defaultValue: "Leaderboard & Awards" })}</h1>
          <p className="text-sm text-muted-foreground">{t("leaderboard.subtitle", { defaultValue: "Score = approved minutes × monthly uses × team bonus × bounty bonus" })}</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-4 border-b border-border">
        {(["month", "lifetime"] as const).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            className={cn(
              "-mb-px border-b-2 px-1 pb-2.5 text-sm font-medium transition-colors",
              tab === value ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {value === "month"
              ? `${t("leaderboard.tabMonth", { defaultValue: "This month" })} ${month}`
              : t("leaderboard.tabLifetime", { defaultValue: "Lifetime" })}
          </button>
        ))}
      </div>

      {isPending ? (
        <LeaderboardSkeleton />
      ) : entries.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-6 py-12 text-center text-sm text-muted-foreground">
          {t("leaderboard.noData", { defaultValue: "No scores yet this period." })}
        </div>
      ) : (
        <>
          {/* Gamified podium hero — #1 elevated and centered on desktop */}
          <div className="grid items-end gap-4 sm:grid-cols-3">
            {podium.map((entry, i) => (
              <PodiumCard
                key={entry.userId}
                entry={entry}
                rank={i + 1}
                topScore={topScore}
                className={cn(
                  i === 0 && "order-1 sm:order-2",
                  i === 1 && "order-2 sm:order-1 sm:mt-6",
                  i === 2 && "order-3 sm:order-3 sm:mt-6",
                )}
              />
            ))}
          </div>

          {/* Dense, sortable, searchable full ranking */}
          <div className="rounded-lg border border-border">
            <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
              <h2 className="text-sm font-semibold">{t("leaderboard.fullRanking", { defaultValue: "Full ranking" })}</h2>
              <div className="relative">
                <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t("leaderboard.searchPeople", { defaultValue: "Search people" })}
                  className="h-8 w-44 rounded-md border border-border bg-background pl-7 pr-2 text-xs outline-none focus:ring-1 focus:ring-ring"
                />
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-xs text-muted-foreground">
                    <th className="px-3 py-2 text-left font-medium">{t("leaderboard.rank", { defaultValue: "Rank" })}</th>
                    <th className="px-3 py-2 text-left font-medium">{t("leaderboard.person", { defaultValue: "Person" })}</th>
                    {columns.map((c) => (
                      <th key={c.key} className="px-3 py-2 text-right font-medium">
                        <button
                          type="button"
                          onClick={() => toggleSort(c.key)}
                          className="ml-auto inline-flex items-center gap-1 hover:text-foreground"
                        >
                          {t(c.label, { defaultValue: c.default })}
                          <SortIcon active={sortKey === c.key} dir={sortDir} />
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {tableRows.length === 0 ? (
                    <tr>
                      <td colSpan={columns.length + 2} className="px-3 py-8 text-center text-xs text-muted-foreground">
                        {t("leaderboard.noMatch", { defaultValue: "No one matches your search." })}
                      </td>
                    </tr>
                  ) : (
                    tableRows.map((entry) => {
                      const rank = rankByUser.get(entry.userId) ?? 0;
                      return (
                        <tr
                          key={entry.userId}
                          className={cn(
                            "border-b border-border/60 last:border-b-0 hover:bg-accent/40",
                            rank <= 3 && "bg-muted/30",
                          )}
                        >
                          <td className="px-3 py-2">
                            <RankBadge rank={rank} />
                          </td>
                          <td className="px-3 py-2 font-medium">{entry.displayName}</td>
                          {columns.map((c) => (
                            <td
                              key={c.key}
                              className={cn(
                                "px-3 py-2 text-right tabular-nums",
                                c.key === "score" ? "font-semibold" : "text-muted-foreground",
                              )}
                            >
                              {Number(entry[c.key] ?? 0).toLocaleString()}
                            </td>
                          ))}
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* Awards */}
      <div>
        <div className="mb-3 flex items-center gap-2">
          <span>🏅</span>
          <h2 className="text-base font-semibold">
            {tab === "month" ? `${month} ` : ""}{t("leaderboard.awardsTitle", { defaultValue: "Monthly awards" })}
          </h2>
          <span className="text-xs text-muted-foreground">{t("leaderboard.awardsNote", { defaultValue: "(revealed by the monthly rollup)" })}</span>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {isPending
            ? Array.from({ length: 6 }).map((_, i) => (
                <div key={`award-skel-${i}`} className="h-28 animate-pulse rounded-lg border border-border bg-muted/30" />
              ))
            : awards.map((a) => (
                <div key={a.key} className={cn("rounded-lg border border-l-4 border-border bg-card p-4", a.accent)}>
                  <div className="flex items-start justify-between">
                    <div className="text-sm font-semibold">{t(`leaderboard.${a.key}`, { defaultValue: a.key })}</div>
                    <span className="text-xl">{a.emoji}</span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{t(`leaderboard.${a.key}Desc`, { defaultValue: "" })}</p>
                  {winnerByKey.get(a.awardKey) ? (
                    <p className="mt-3 text-sm font-semibold text-foreground">
                      {winnerByKey.get(a.awardKey)!.winnerName}
                      {winnerByKey.get(a.awardKey)!.value > 0 && (
                        <span className="ml-1.5 text-xs font-normal text-muted-foreground">· {winnerByKey.get(a.awardKey)!.value.toLocaleString()}</span>
                      )}
                    </p>
                  ) : (
                    <p className="mt-3 text-xs italic text-muted-foreground">{t("leaderboard.noWinner", { defaultValue: "No winner yet this month" })}</p>
                  )}
                </div>
              ))}
        </div>
      </div>

      {/* Formula footer */}
      <div className="rounded-lg bg-muted/40 px-4 py-3 text-xs text-muted-foreground">
        {t("leaderboard.formula", { defaultValue: "Score = approved minutes × monthly uses × team bonus (≥3 ppl ×2.0) × bounty bonus (90d ×1.3)" })}
      </div>
    </div>
  );
}

function SortIcon({ active, dir }: { active: boolean; dir: "asc" | "desc" }) {
  if (!active) return <ChevronsUpDown className="h-3 w-3 opacity-40" />;
  return dir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />;
}

function RankBadge({ rank }: { rank: number }) {
  if (rank >= 1 && rank <= 3) {
    const tier = TIER[rank - 1];
    return (
      <span className={cn("inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold", tier.badge)}>
        {rank}
      </span>
    );
  }
  return <span className="inline-flex h-6 w-6 items-center justify-center text-xs font-semibold text-muted-foreground">{rank}</span>;
}

function LeaderboardSkeleton() {
  // Render the loaded layout's footprint while data is cold so navigating in
  // doesn't paint the empty state first and then pop the podium/rows in.
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-52 animate-pulse rounded-xl border border-border bg-muted/30" />
        ))}
      </div>
      <div className="overflow-hidden rounded-lg border border-border">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="h-11 animate-pulse border-b border-border bg-muted/20 last:border-b-0" />
        ))}
      </div>
    </div>
  );
}

function PodiumCard({
  entry,
  rank,
  topScore,
  className,
}: {
  entry: LeaderboardEntry;
  rank: number;
  topScore: number;
  className?: string;
}) {
  const { t } = useTranslation();
  const tier = TIER[rank - 1] ?? TIER[2];
  const TierIcon = tier.Icon;
  const pct = topScore > 0 ? Math.max(6, Math.round((entry.score / topScore) * 100)) : 0;
  return (
    <div
      className={cn(
        "relative rounded-xl border bg-gradient-to-b p-5 text-center ring-1",
        tier.border,
        tier.grad,
        tier.ring,
        rank === 1 && "sm:scale-[1.04]",
        className,
      )}
    >
      <div className={cn("absolute -top-3 left-1/2 -translate-x-1/2 rounded-full px-3 py-0.5 text-[11px] font-bold", tier.badge)}>
        #{rank} · {t(tier.labelKey, { defaultValue: tier.labelDefault })}
      </div>
      <TierIcon className={cn("mx-auto mt-2 h-7 w-7", tier.icon)} />
      <div className="mt-2 truncate text-lg font-bold">{entry.displayName}</div>
      <div className="mt-2 text-3xl font-bold tabular-nums">{entry.score.toLocaleString()}</div>
      <div className="text-xs text-muted-foreground">{t("leaderboard.minutesSaved", { defaultValue: "Minutes saved" })}</div>
      {/* Relative-score bar (gamified) */}
      <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full rounded-full", tier.bar)} style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-4 grid grid-cols-3 gap-2 border-t border-border pt-3 text-center">
        <Stat value={entry.skillCount} label={t("leaderboard.skills", { defaultValue: "Skills" })} />
        <Stat value={entry.beneficiaries} label={t("leaderboard.beneficiaries", { defaultValue: "Beneficiaries" })} />
        <Stat value={entry.bountyCount} label={t("leaderboard.bounties", { defaultValue: "Bounties" })} />
      </div>
    </div>
  );
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div>
      <div className="text-base font-semibold tabular-nums">{value}</div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
    </div>
  );
}
