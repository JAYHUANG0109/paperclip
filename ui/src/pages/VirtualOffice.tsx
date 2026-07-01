import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { Wrench, Zap, ExternalLink, Clock, Trophy, Lock, Camera, RefreshCw, Users, Palette } from "lucide-react";
import { useTranslation } from "@/i18n";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { agentsApi } from "../api/agents";
import { assetsApi } from "../api/assets";
import { heartbeatsApi } from "../api/heartbeats";
import { leaderboardApi, type LeaderboardEntry } from "../api/leaderboard";
import { OfficeAvatar } from "../components/OfficeAvatar";
import { LivingOfficeFloor } from "../components/LivingOfficeFloor";
import { OfficeCharacterPicker } from "../components/OfficeCharacterPicker";
import { displayAgentName } from "../lib/agent-name";
import { TeamFilterBar } from "../components/TeamFilterBar";
import { ViewSwitchButton } from "../components/ViewSwitchButton";
import { agentMatchesTeams, listAllTeams, useAgentTeamFilter } from "../lib/agent-teams";
import { sortAgentsByAccessLevel } from "../lib/agent-order";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { agentUrl } from "../lib/utils";
import { cn } from "../lib/utils";
import { queryKeys } from "../lib/queryKeys";
import type { Agent } from "@paperclipai/shared";

export function VirtualOffice() {
  const { t } = useTranslation();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [activeAgent, setActiveAgent] = useState<Agent | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: t("office.title", { defaultValue: "Virtual Office" }) }]);
  }, [setBreadcrumbs, t]);

  // Reuse the SAME query keys the always-mounted sidebar (and the Agents page)
  // populate, so navigating here finds a warm cache instead of rendering an
  // empty grid first and popping all the desks in — that cold-render cascade is
  // what made this page "twitch/flash" while others felt instant.
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(selectedCompanyId!),
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!, { limit: 100 }),
    enabled: !!selectedCompanyId,
    refetchInterval: 10_000,
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
  const { data: viewable } = useQuery({
    queryKey: ["office-viewable-agents", selectedCompanyId],
    queryFn: () => agentsApi.myVisibleAgents(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const canViewAgent = (agentId: string) =>
    Boolean(viewable?.privileged) || (viewable?.agentIds ?? []).includes(agentId);

  const { selected: teamFilter, toggle: toggleTeam, clear: clearTeams } = useAgentTeamFilter(selectedCompanyId);
  const workingAgentIds = useMemo(() => new Set((liveRuns ?? []).map((r) => r.agentId)), [liveRuns]);
  const allAgents = useMemo(() => (agents ?? []).filter((a) => a.status !== "terminated"), [agents]);
  const allTeams = useMemo(() => listAllTeams(allAgents), [allAgents]);
  // Avatars are filtered by the shared team selection (same one the Agents page
  // uses), so switching between the two views keeps the same filter applied.
  // Ranked by access level (org seniority) by default; placeholder C-suite
  // agents sort last.
  const visibleAgents = useMemo(
    () => sortAgentsByAccessLevel(allAgents.filter((a) => agentMatchesTeams(a, teamFilter)), allAgents),
    [allAgents, teamFilter],
  );
  const leaderboardByUser = useMemo(
    () => new Map((leaderboard?.entries ?? []).map((e) => [e.userId, e])),
    [leaderboard],
  );

  return (
    <div className="w-full space-y-2">
      {/* Shared controls row: team chip filter (left) + view switch (right) —
          identical layout/style to the Agents page so the switch never moves. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <TeamFilterBar teams={allTeams} selected={teamFilter} onToggle={toggleTeam} onClear={clearTeams} />
        </div>
        <ViewSwitchButton to="/agents" label={t("office.browseAgents", { defaultValue: "Browse agents" })} icon={Users} />
      </div>

      <LivingOfficeFloor agents={visibleAgents} workingIds={workingAgentIds} skillCounts={skillCounts} liveRuns={liveRuns ?? []} onOpen={setActiveAgent} />

      <AgentModal
        agent={activeAgent}
        companyId={selectedCompanyId ?? ""}
        canManage={activeAgent ? canViewAgent(activeAgent.id) : false}
        canView={activeAgent ? canViewAgent(activeAgent.id) : false}
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

function statusInfo(agent: Agent, working: boolean, t: (k: string, o?: Record<string, unknown>) => string) {
  if (agent.pauseReason) return { label: t("office.paused", { defaultValue: "Paused" }), dot: "bg-muted-foreground" };
  if (agent.errorReason) return { label: t("office.error", { defaultValue: "Needs attention" }), dot: "bg-red-500" };
  if (working) return { label: t("office.busy", { defaultValue: "Working" }), dot: "bg-emerald-500 animate-pulse" };
  return { label: t("office.idle", { defaultValue: "Idle" }), dot: "bg-muted-foreground/40" };
}

function AgentModal({ agent, companyId, canManage, canView, working, skillCount, leaderboard, onClose }: {
  agent: Agent | null;
  companyId: string;
  canManage: boolean;
  canView: boolean;
  working: boolean;
  skillCount: number;
  score: number | null;
  leaderboard: LeaderboardEntry | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const upload = useMutation({
    mutationFn: async (file: File) => {
      const asset = await assetsApi.uploadImage(companyId, file, "office-avatar");
      return agentsApi.setOfficeAvatar(agent!.id, asset.contentPath, companyId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) });
    },
  });

  if (!agent) return null;
  const status = statusInfo(agent, working, t);
  const lastSeen = agent.lastHeartbeatAt ? new Date(agent.lastHeartbeatAt).toLocaleString() : null;

  return (
    <Dialog open={!!agent} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        {/* Hero */}
        <div className="flex items-center gap-4">
          <div className={cn(
            "relative flex h-28 w-28 shrink-0 items-center justify-center rounded-full border-2 bg-background",
            working ? "border-emerald-400/70" : "border-border",
          )}>
            <OfficeAvatar agent={agent} size={104} animated={false} clip={false} />
            {canManage && (
              <>
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  disabled={upload.isPending}
                  title={t("office.uploadAvatar", { defaultValue: "Change avatar" })}
                  className="absolute -bottom-1 -right-1 flex h-7 w-7 items-center justify-center rounded-full border border-border bg-background shadow-sm hover:bg-accent"
                >
                  {upload.isPending ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Camera className="h-3.5 w-3.5" />}
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) upload.mutate(f); e.target.value = ""; }}
                />
              </>
            )}
          </div>
          <div className="min-w-0">
            <div className="truncate text-lg font-bold">{displayAgentName(agent.name)}</div>
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

        {canManage && (
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            className="mt-4 flex w-full items-center justify-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-accent"
          >
            <Palette className="h-4 w-4" />
            {t("office.changeCharacter", { defaultValue: "Change character" })}
          </button>
        )}

        {canView ? (
          <Link
            to={agentUrl(agent)}
            onClick={onClose}
            className="mt-2 flex items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            <ExternalLink className="h-4 w-4" />
            {t("office.viewAgent", { defaultValue: "View agent" })}
          </Link>
        ) : (
          <div className="mt-4 flex items-center justify-center gap-1.5 rounded-md border border-border px-3 py-2 text-xs text-muted-foreground">
            <Lock className="h-3.5 w-3.5" />
            {t("office.noAccess", { defaultValue: "You don't manage this agent" })}
          </div>
        )}
      </DialogContent>

      <OfficeCharacterPicker
        agent={pickerOpen ? agent : null}
        companyId={companyId}
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
      />
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
