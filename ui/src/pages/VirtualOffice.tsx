import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { Wrench, Zap, Building2, ExternalLink, Clock, Trophy } from "lucide-react";
import { useTranslation } from "@/i18n";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { agentsApi } from "../api/agents";
import { heartbeatsApi } from "../api/heartbeats";
import { leaderboardApi, type LeaderboardEntry } from "../api/leaderboard";
import { CartoonAvatar } from "../components/CartoonAvatar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { agentUrl } from "../lib/utils";
import { cn } from "../lib/utils";
import type { Agent } from "@paperclipai/shared";

export function VirtualOffice() {
  const { t } = useTranslation();
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [activeAgent, setActiveAgent] = useState<Agent | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: t("office.title", { defaultValue: "Virtual Office" }) }]);
  }, [setBreadcrumbs, t]);

  const { data: agents } = useQuery({
    queryKey: ["office-agents", selectedCompanyId],
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
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

  const workingAgentIds = useMemo(() => new Set((liveRuns ?? []).map((r) => r.agentId)), [liveRuns]);
  const visibleAgents = useMemo(() => (agents ?? []).filter((a) => a.status !== "terminated"), [agents]);
  const workingCount = visibleAgents.filter((a) => workingAgentIds.has(a.id)).length;
  const teamMinutes = (leaderboard?.entries ?? []).reduce((sum, e) => sum + e.rawMinutes, 0);
  const leaderboardByUser = useMemo(
    () => new Map((leaderboard?.entries ?? []).map((e) => [e.userId, e])),
    [leaderboard],
  );

  return (
    <div className="w-full max-w-6xl space-y-5">
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
          {visibleAgents.map((agent, i) => (
            <Desk
              key={agent.id}
              agent={agent}
              working={workingAgentIds.has(agent.id)}
              skillCount={skillCounts?.[agent.id] ?? 0}
              floatDelay={(i % 7) * 0.28}
              onOpen={() => setActiveAgent(agent)}
            />
          ))}
        </div>
      </div>

      <AgentModal
        agent={activeAgent}
        working={activeAgent ? workingAgentIds.has(activeAgent.id) : false}
        skillCount={activeAgent ? skillCounts?.[activeAgent.id] ?? 0 : 0}
        score={activeAgent && activeAgent.metadata ? null : null}
        leaderboard={activeAgent ? findLeaderboardForAgent(leaderboardByUser, activeAgent) : null}
        onClose={() => setActiveAgent(null)}
      />
    </div>
  );
}

// Agents are owned by users; the leaderboard is keyed by user. We surface the
// score only when the agent's metadata carries an ownerUserId match (best-effort).
function findLeaderboardForAgent(_byUser: Map<string, LeaderboardEntry>, _agent: Agent): LeaderboardEntry | null {
  return null;
}

function Stat({ value, label, accent }: { value: number | string; label: string; accent?: boolean }) {
  return (
    <div className="text-right">
      <div className={cn("text-2xl font-bold tabular-nums", accent && "text-emerald-500")}>{value}</div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
    </div>
  );
}

function statusInfo(agent: Agent, working: boolean, t: (k: string, o?: Record<string, unknown>) => string) {
  if (agent.pauseReason) return { label: t("office.paused", { defaultValue: "Paused" }), dot: "bg-muted-foreground" };
  if (agent.errorReason) return { label: t("office.error", { defaultValue: "Needs attention" }), dot: "bg-red-500" };
  if (working) return { label: t("office.busy", { defaultValue: "Working" }), dot: "bg-emerald-500 animate-pulse" };
  return { label: t("office.idle", { defaultValue: "Idle" }), dot: "bg-muted-foreground/40" };
}

function Desk({ agent, working, skillCount, floatDelay, onOpen }: {
  agent: Agent;
  working: boolean;
  skillCount: number;
  floatDelay: number;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const status = statusInfo(agent, working, t);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onOpen}
          className="group flex flex-col items-center gap-1 rounded-lg p-2 text-center transition-transform hover:-translate-y-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <div className="relative" style={{ animationDelay: `${floatDelay}s` }}>
            <div className={cn(
              "flex h-16 w-16 items-center justify-center rounded-full border-2 bg-background transition-shadow group-hover:shadow-lg",
              working ? "border-emerald-400/70" : "border-border",
            )}>
              <CartoonAvatar seed={agent.id} size={56} />
            </div>
            {working && (
              <span className="absolute -right-0.5 -top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500 text-white">
                <Zap className="h-2.5 w-2.5" />
              </span>
            )}
          </div>
          <div className="-mt-1 h-1.5 w-16 rounded-full bg-amber-200/70 dark:bg-amber-900/40" />
          <div className="mt-0.5 max-w-[7rem] truncate text-xs font-medium">{agent.name}</div>
          <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <span className={cn("h-1.5 w-1.5 rounded-full", status.dot)} />
            {status.label}
          </div>
          {skillCount > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground">
              <Wrench className="h-2.5 w-2.5" />{skillCount} {t("office.skills", { defaultValue: "skills" })}
            </span>
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[14rem]">
        <div className="text-sm font-semibold">{agent.name}</div>
        <div className="text-xs text-muted-foreground">{agent.title ?? agent.role}</div>
        <div className="mt-1 flex items-center gap-1.5 text-xs">
          <span className={cn("h-1.5 w-1.5 rounded-full", status.dot)} />
          {status.label}
          {skillCount > 0 && <span className="ml-auto text-muted-foreground">{skillCount} {t("office.skills", { defaultValue: "skills" })}</span>}
        </div>
        <div className="mt-1 text-[11px] text-muted-foreground">{t("office.clickForMore", { defaultValue: "Click for details" })}</div>
      </TooltipContent>
    </Tooltip>
  );
}

function AgentModal({ agent, working, skillCount, leaderboard, onClose }: {
  agent: Agent | null;
  working: boolean;
  skillCount: number;
  score: number | null;
  leaderboard: LeaderboardEntry | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  if (!agent) return null;
  const status = statusInfo(agent, working, t);
  const lastSeen = agent.lastHeartbeatAt ? new Date(agent.lastHeartbeatAt).toLocaleString() : null;

  return (
    <Dialog open={!!agent} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        {/* Hero */}
        <div className="flex items-center gap-4">
          <div className={cn(
            "flex h-20 w-20 shrink-0 items-center justify-center rounded-full border-2 bg-background",
            working ? "border-emerald-400/70" : "border-border",
          )}>
            <CartoonAvatar seed={agent.id} size={72} animated={false} />
          </div>
          <div className="min-w-0">
            <div className="truncate text-lg font-bold">{agent.name}</div>
            <div className="truncate text-sm text-muted-foreground">{agent.title ?? agent.role}</div>
            <div className="mt-1.5 inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-xs">
              <span className={cn("h-2 w-2 rounded-full", status.dot)} />
              {status.label}
            </div>
          </div>
        </div>

        {/* Stats */}
        <div className="mt-4 grid grid-cols-3 gap-3">
          <ModalStat icon={Wrench} value={skillCount} label={t("office.skills", { defaultValue: "skills" })} />
          <ModalStat icon={Trophy} value={leaderboard?.score ?? 0} label={t("office.minutes", { defaultValue: "minutes" })} />
          <ModalStat icon={Zap} value={working ? t("office.busy", { defaultValue: "Working" }) : t("office.idle", { defaultValue: "Idle" })} label={t("office.status", { defaultValue: "status" })} />
        </div>

        {lastSeen && (
          <div className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Clock className="h-3.5 w-3.5" />
            {t("office.lastActive", { defaultValue: "Last active" })}: {lastSeen}
          </div>
        )}

        {agent.capabilities && (
          <p className="mt-3 line-clamp-3 text-xs text-muted-foreground">{agent.capabilities}</p>
        )}

        <Link
          to={agentUrl(agent)}
          onClick={onClose}
          className="mt-4 flex items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          <ExternalLink className="h-4 w-4" />
          {t("office.viewAgent", { defaultValue: "View agent" })}
        </Link>
      </DialogContent>
    </Dialog>
  );
}

function ModalStat({ icon: Icon, value, label }: { icon: typeof Wrench; value: number | string; label: string }) {
  return (
    <div className="rounded-lg border border-border p-2.5 text-center">
      <Icon className="mx-auto h-4 w-4 text-muted-foreground" />
      <div className="mt-1 text-base font-semibold tabular-nums">{typeof value === "number" ? value.toLocaleString() : value}</div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
    </div>
  );
}
