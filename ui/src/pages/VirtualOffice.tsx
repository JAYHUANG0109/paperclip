import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { Wrench, Zap, Building2, ExternalLink } from "lucide-react";
import { useTranslation } from "@/i18n";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { agentsApi } from "../api/agents";
import { heartbeatsApi } from "../api/heartbeats";
import { leaderboardApi } from "../api/leaderboard";
import { AgentIcon } from "../components/AgentIconPicker";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { agentUrl } from "../lib/utils";
import { cn } from "../lib/utils";
import type { Agent } from "@paperclipai/shared";

export function VirtualOffice() {
  const { t } = useTranslation();
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: t("office.title", { defaultValue: "Virtual Office" }) }]);
  }, [setBreadcrumbs, t]);

  const { data: agents } = useQuery({
    queryKey: ["office-agents", selectedCompanyId],
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  // Live runs poll so the "working" state animates in near-real-time.
  const { data: liveRuns } = useQuery({
    queryKey: ["office-live-runs", selectedCompanyId],
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!, { limit: 100 }),
    enabled: !!selectedCompanyId,
    refetchInterval: 8000,
  });
  const { data: skillCounts } = useQuery({
    queryKey: ["office-skill-counts", selectedCompanyId],
    queryFn: () => agentsApi.skillCounts(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: leaderboard } = useQuery({
    queryKey: ["office-leaderboard", selectedCompanyId],
    queryFn: () => leaderboardApi.get(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const workingAgentIds = useMemo(
    () => new Set((liveRuns ?? []).map((r) => r.agentId)),
    [liveRuns],
  );

  const visibleAgents = useMemo(
    () => (agents ?? []).filter((a) => a.status !== "terminated"),
    [agents],
  );
  const workingCount = visibleAgents.filter((a) => workingAgentIds.has(a.id)).length;
  const teamMinutes = (leaderboard?.entries ?? []).reduce((sum, e) => sum + e.rawMinutes, 0);

  return (
    <div className="w-full max-w-6xl space-y-5">
      {/* Header with live stats */}
      <div className="flex flex-wrap items-end justify-between gap-4 rounded-xl border border-border bg-card px-5 py-4">
        <div>
          <h1 className="text-2xl font-bold">{t("office.title", { defaultValue: "Virtual Office" })}</h1>
          <p className="text-sm text-muted-foreground">
            {selectedCompany?.name ? `${selectedCompany.name} ` : ""}{t("office.subtitle", { defaultValue: "The AI team at work ✨" })}
          </p>
        </div>
        <div className="flex items-center gap-6">
          <Stat value={visibleAgents.length} label={t("office.colleagues", { defaultValue: "colleagues" })} />
          <Stat value={workingCount} label={t("office.working", { defaultValue: "Working" })} accent={workingCount > 0} />
          <Stat value={teamMinutes.toLocaleString()} label={t("office.teamMinutes", { defaultValue: "Team minutes saved" })} />
        </div>
      </div>

      {/* The office floor */}
      <div className="rounded-2xl border border-border bg-[repeating-linear-gradient(45deg,hsl(var(--muted)/0.25)_0_12px,transparent_12px_24px)] p-4 sm:p-6">
        <div className="mb-4 flex items-center justify-center gap-2">
          <span>🪴</span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-3 py-1 text-sm font-medium">
            <Building2 className="h-3.5 w-3.5" />
            {selectedCompany?.name ?? t("office.officeName", { defaultValue: "Office" })}
          </span>
          <span>🌿</span>
        </div>

        <div className="grid grid-cols-2 gap-x-3 gap-y-6 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-7">
          {visibleAgents.map((agent) => (
            <Desk
              key={agent.id}
              agent={agent}
              working={workingAgentIds.has(agent.id)}
              skillCount={skillCounts?.[agent.id] ?? 0}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function Stat({ value, label, accent }: { value: number | string; label: string; accent?: boolean }) {
  return (
    <div className="text-right">
      <div className={cn("text-2xl font-bold tabular-nums", accent && "text-emerald-500")}>{value}</div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
    </div>
  );
}

function Desk({ agent, working, skillCount }: { agent: Agent; working: boolean; skillCount: number }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  const statusLabel = agent.pauseReason
    ? t("office.paused", { defaultValue: "Paused" })
    : agent.errorReason
      ? t("office.error", { defaultValue: "Needs attention" })
      : working
        ? t("office.busy", { defaultValue: "Working" })
        : t("office.idle", { defaultValue: "Idle" });

  const dotClass = agent.pauseReason
    ? "bg-muted-foreground"
    : agent.errorReason
      ? "bg-red-500"
      : working
        ? "bg-emerald-500 animate-pulse"
        : "bg-muted-foreground/40";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="group flex flex-col items-center gap-1 rounded-lg p-2 text-center transition-transform hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {/* Avatar on a desk */}
          <div className="relative">
            <div className={cn(
              "flex h-14 w-14 items-center justify-center rounded-full border-2 bg-background transition-shadow group-hover:shadow-md",
              working ? "border-emerald-400/60" : "border-border",
            )}>
              <AgentIcon icon={agent.icon} className="h-7 w-7 text-foreground" />
            </div>
            {working && (
              <span className="absolute -right-0.5 -top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500 text-white">
                <Zap className="h-2.5 w-2.5" />
              </span>
            )}
          </div>
          {/* Desk surface */}
          <div className="-mt-1 h-1.5 w-16 rounded-full bg-amber-200/70 dark:bg-amber-900/40" />
          <div className="mt-0.5 max-w-[7rem] truncate text-xs font-medium">{agent.name}</div>
          <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <span className={cn("h-1.5 w-1.5 rounded-full", dotClass)} />
            {statusLabel}
          </div>
          {skillCount > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground">
              <Wrench className="h-2.5 w-2.5" />{skillCount} {t("office.skills", { defaultValue: "skills" })}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-60" align="center">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-full border border-border">
            <AgentIcon icon={agent.icon} className="h-6 w-6" />
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{agent.name}</div>
            <div className="truncate text-xs text-muted-foreground">{agent.title ?? agent.role}</div>
          </div>
        </div>
        <div className="mt-3 flex items-center gap-2 text-xs">
          <span className={cn("h-2 w-2 rounded-full", dotClass)} />
          <span className="text-muted-foreground">{statusLabel}</span>
          {skillCount > 0 && <span className="ml-auto text-muted-foreground">{skillCount} {t("office.skills", { defaultValue: "skills" })}</span>}
        </div>
        <Link
          to={agentUrl(agent)}
          className="mt-3 flex items-center justify-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-accent"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          {t("office.viewAgent", { defaultValue: "View agent" })}
        </Link>
      </PopoverContent>
    </Popover>
  );
}
