import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Trophy, Sparkles } from "lucide-react";
import { useTranslation } from "@/i18n";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { leaderboardApi, type LeaderboardEntry } from "../api/leaderboard";
import { cn } from "../lib/utils";

function currentMonth(): string {
  // Server stamps usage with its own clock; the UI just needs a YYYY-MM label.
  return new Date().toISOString().slice(0, 7);
}

const PODIUM_RANK_STYLES = [
  "border-amber-400/60 bg-gradient-to-b from-amber-50 to-transparent dark:from-amber-500/10",
  "border-border",
  "border-border",
];

export function Leaderboard() {
  const { t } = useTranslation();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [tab, setTab] = useState<"month" | "lifetime">("month");
  const month = currentMonth();

  useEffect(() => {
    setBreadcrumbs([{ label: t("leaderboard.title", { defaultValue: "Leaderboard & Awards" }) }]);
  }, [setBreadcrumbs, t]);

  const { data } = useQuery({
    queryKey: ["leaderboard", selectedCompanyId, tab, month],
    queryFn: () => leaderboardApi.get(selectedCompanyId!, tab === "month" ? month : undefined),
    enabled: !!selectedCompanyId,
  });

  const entries = data?.entries ?? [];
  const podium = entries.slice(0, 3);
  const rest = entries.slice(3);

  const awards = useMemo(() => [
    { key: "awardChampion", emoji: "🏆" },
    { key: "awardLifetime", emoji: "💎" },
    { key: "awardCrossDept", emoji: "🌐" },
    { key: "awardBounty", emoji: "🎯" },
    { key: "awardViral", emoji: "🦠" },
    { key: "awardRookie", emoji: "🌟" },
  ], []);

  return (
    <div className="w-full max-w-6xl space-y-6">
      {/* Header */}
      <div className="flex items-start gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/40">
          <Trophy className="h-5 w-5 text-amber-500" />
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

      {entries.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-6 py-12 text-center text-sm text-muted-foreground">
          {t("leaderboard.noData", { defaultValue: "No scores yet this period." })}
        </div>
      ) : (
        <>
          {/* Podium */}
          <div className="grid gap-4 sm:grid-cols-3">
            {podium.map((entry, i) => (
              <PodiumCard key={entry.userId} entry={entry} rank={i + 1} highlight={i === 0} />
            ))}
          </div>

          {/* Rest of the ranking */}
          {rest.length > 0 && (
            <div className="overflow-hidden rounded-lg border border-border">
              {rest.map((entry, i) => (
                <div key={entry.userId} className="flex items-center gap-3 border-b border-border px-4 py-2.5 last:border-b-0">
                  <span className="w-6 text-center text-sm font-semibold text-muted-foreground">#{i + 4}</span>
                  <span className="flex-1 truncate text-sm font-medium">{entry.displayName}</span>
                  <span className="text-sm tabular-nums">{entry.score.toLocaleString()}</span>
                  <span className="text-xs text-muted-foreground">{t("leaderboard.minutesSaved", { defaultValue: "Minutes saved" })}</span>
                </div>
              ))}
            </div>
          )}
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
          {awards.map((a) => (
            <div key={a.key} className="rounded-lg border border-border p-4">
              <div className="flex items-start justify-between">
                <div className="text-sm font-semibold">{t(`leaderboard.${a.key}`, { defaultValue: a.key })}</div>
                <span className="text-xl">{a.emoji}</span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{t(`leaderboard.${a.key}Desc`, { defaultValue: "" })}</p>
              <p className="mt-3 text-xs italic text-muted-foreground">{t("leaderboard.noWinner", { defaultValue: "No winner yet this month" })}</p>
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

function PodiumCard({ entry, rank, highlight }: { entry: LeaderboardEntry; rank: number; highlight: boolean }) {
  const { t } = useTranslation();
  return (
    <div className={cn("relative rounded-xl border p-5 text-center", PODIUM_RANK_STYLES[rank - 1], highlight && "ring-1 ring-amber-400/40")}>
      {highlight && (
        <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-amber-400 px-3 py-0.5 text-[11px] font-semibold text-amber-950">
          {t("leaderboard.hallOfFame", { defaultValue: "Hall of Fame" })} 🏆
        </div>
      )}
      <div className="text-sm font-semibold text-muted-foreground">#{rank}</div>
      <div className="mt-1 truncate text-lg font-bold">{entry.displayName}</div>
      <div className="mt-3 inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-0.5 text-[11px] text-muted-foreground">
        <Sparkles className="h-3 w-3" /> {t("leaderboard.rookie", { defaultValue: "Rookie" })}
      </div>
      <div className="mt-3 text-3xl font-bold tabular-nums">{entry.score.toLocaleString()}</div>
      <div className="text-xs text-muted-foreground">{t("leaderboard.minutesSaved", { defaultValue: "Minutes saved" })}</div>
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
