import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { Wrench, Zap, ExternalLink, Clock, Trophy, Lock, Camera, RefreshCw, Users, LayoutGrid, Building2, Award } from "lucide-react";
import { useTranslation } from "@/i18n";
import { useCompany } from "../context/CompanyContext";
import { useToastActions } from "../context/ToastContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { agentsApi, type AgentProgression, type AgentBadgeState } from "../api/agents";
import { assetsApi } from "../api/assets";
import { heartbeatsApi } from "../api/heartbeats";
import { leaderboardApi, type LeaderboardEntry } from "../api/leaderboard";
import { OfficeAvatar } from "../components/OfficeAvatar";
import { LivingOfficeFloor } from "../components/LivingOfficeFloor";
import { MobileOfficeRooms } from "../components/MobileOfficeRooms";
import { useIsMobile } from "../hooks/useIsMobile";
import { displayAgentName } from "../lib/agent-name";
import { TeamFilterBar } from "../components/TeamFilterBar";
import { ViewSwitchButton } from "../components/ViewSwitchButton";
import { agentMatchesTeams, agentTeams, listAllTeams, useAgentTeamFilter } from "../lib/agent-teams";
import { sortAgentsByAccessLevel } from "../lib/agent-order";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { agentUrl } from "../lib/utils";
import { cn } from "../lib/utils";
import { queryKeys } from "../lib/queryKeys";
import { OFFICE_BADGES, OFFICE_BADGE_BY_KEY, rankLadder, XP_SOURCES } from "../lib/office-badges";
import type { Agent } from "@paperclipai/shared";

const OFFICE_VIEW_KEY = "paperclip:office-view";
// The system-automation team folder — its agents (e.g. Reflection Coach) are
// infrastructure, not colleagues, so they sort to the very bottom of the office.
const AUTOMATION_TEAM = "系統自動化";

export function VirtualOffice() {
  const { t, i18n } = useTranslation();
  const { pushToast } = useToastActions();
  const { selectedCompanyId } = useCompany();
  const isMobile = useIsMobile();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [activeAgent, setActiveAgent] = useState<Agent | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);
  // Two ways to look at the same (team-filtered) roster: the pixel-art floor, or
  // a catalog of player cards. The choice is remembered so a reload keeps it.
  const [view, setView] = useState<"office" | "catalog">(() => {
    try {
      return localStorage.getItem(OFFICE_VIEW_KEY) === "catalog" ? "catalog" : "office";
    } catch {
      return "office";
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(OFFICE_VIEW_KEY, view);
    } catch {
      /* ignore */
    }
  }, [view]);
  // Zoom lives here (not in the floor) so its control can sit in the filters row.
  const [userZoom, setUserZoom] = useState<number | null>(null); // null = auto-fit
  const [fitZoom, setFitZoom] = useState(1);
  const clampZoom = (v: number) => Math.min(4, Math.max(0.3, v));

  useEffect(() => {
    setBreadcrumbs([{ label: t("office.title", { defaultValue: "Virtual Office" }) }]);
  }, [setBreadcrumbs, t]);

  // Reuse the SAME query keys the always-mounted sidebar (and the Agents page)
  // populate, so navigating here finds a warm cache instead of rendering an
  // empty grid first and popping all the desks in — that cold-render cascade is
  // what made this page "twitch/flash" while others felt instant.
  // Company-wide roster: EVERY agent is visible on the floor + catalog for every
  // user (display-safe fields only). Interaction is still access-gated below via
  // canViewAgent (myVisibleAgents) — that's what controls the 查看代理人 button.
  // Distinct query key from the access-filtered agents.list used elsewhere.
  const { data: agents } = useQuery({
    queryKey: ["office-roster", selectedCompanyId],
    queryFn: () => agentsApi.officeRoster(selectedCompanyId!),
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
  const { data: progressionByAgent } = useQuery({
    queryKey: ["office-agent-progression", selectedCompanyId],
    queryFn: () => agentsApi.progression(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const canViewAgent = (agentId: string) =>
    Boolean(viewable?.privileged) || (viewable?.agentIds ?? []).includes(agentId);

  // The agent(s) THIS user is paired with — used to float the current user's own
  // agent to the very first card (top-left), so everyone sees themselves first.
  const { data: myAgents } = useQuery({
    queryKey: queryKeys.agents.mine(selectedCompanyId!),
    queryFn: () => agentsApi.mine(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const myAgentIds = useMemo(() => new Set((myAgents ?? []).map((a) => a.id)), [myAgents]);

  const { selected: teamFilter, toggle: toggleTeam, clear: clearTeams } = useAgentTeamFilter(selectedCompanyId);
  const workingAgentIds = useMemo(() => new Set((liveRuns ?? []).map((r) => r.agentId)), [liveRuns]);
  const allAgents = useMemo(() => (agents ?? []).filter((a) => a.status !== "terminated"), [agents]);
  const allTeams = useMemo(() => listAllTeams(allAgents), [allAgents]);
  // Avatars are filtered by the shared team selection (same one the Agents page
  // uses), so switching between the two views keeps the same filter applied.
  // Ordering (top-left → bottom-right):
  //   1. the current user's OWN agent(s) — so you always see yourself first;
  //   2. everyone else ranked by access level (org seniority);
  //   3. the 系統自動化 (system-automation) team last, in any order — these are
  //      infrastructure agents (e.g. Reflection Coach), not real colleagues.
  const visibleAgents = useMemo(() => {
    const ranked = sortAgentsByAccessLevel(
      allAgents.filter((a) => agentMatchesTeams(a, teamFilter)),
      allAgents,
    );
    const isAutomation = (a: (typeof ranked)[number]) => agentTeams(a).includes(AUTOMATION_TEAM);
    // Partition while preserving the access-level order within each bucket.
    const mine = ranked.filter((a) => myAgentIds.has(a.id));
    const automation = ranked.filter((a) => !myAgentIds.has(a.id) && isAutomation(a));
    const rest = ranked.filter((a) => !myAgentIds.has(a.id) && !isAutomation(a));
    return [...mine, ...rest, ...automation];
  }, [allAgents, teamFilter, myAgentIds]);
  const leaderboardByUser = useMemo(
    () => new Map((leaderboard?.entries ?? []).map((e) => [e.userId, e])),
    [leaderboard],
  );

  // Game feel: when you open the office, toast any level-ups / newly-earned
  // badges since you last looked. The per-company snapshot is stored locally and
  // seeded silently on first ever view (no spam), so only real changes surface.
  useEffect(() => {
    if (!progressionByAgent || !selectedCompanyId) return;
    const key = `paperclip:office-progress-seen:${selectedCompanyId}`;
    let seen: Record<string, { level: number; badges: string[] }> | null = null;
    try {
      const raw = localStorage.getItem(key);
      if (raw) seen = JSON.parse(raw);
    } catch {
      /* ignore */
    }
    const snapshot: Record<string, { level: number; badges: string[] }> = {};
    for (const [id, p] of Object.entries(progressionByAgent)) {
      snapshot[id] = { level: p.level, badges: p.badges.filter((b) => b.earned).map((b) => b.key) };
    }
    if (seen) {
      const zh = i18n.language?.startsWith("zh");
      const nameById = new Map((agents ?? []).map((a) => [a.id, displayAgentName(a.name)]));
      const events: string[] = [];
      for (const [id, cur] of Object.entries(snapshot)) {
        const prev = seen[id];
        if (!prev) continue; // agent new since last view — don't retro-toast
        const name = nameById.get(id) ?? id.slice(0, 6);
        if (cur.level > prev.level) {
          const title = progressionByAgent[id]!.title;
          events.push(`🆙 ${t("office.leveledUp", { name, level: cur.level, title: zh ? title.zh : title.en, defaultValue: `${name} reached Lv${cur.level} · ${zh ? title.zh : title.en}` })}`);
        }
        for (const bk of cur.badges.filter((k) => !prev.badges.includes(k))) {
          const info = OFFICE_BADGE_BY_KEY[bk];
          if (info) events.push(`${info.emoji} ${t("office.earnedBadgeToast", { name, badge: zh ? info.zh : info.en, defaultValue: `${name} unlocked: ${zh ? info.zh : info.en}` })}`);
        }
      }
      if (events.length > 3) {
        pushToast({ title: t("office.progressSummary", { count: events.length, defaultValue: `${events.length} agents leveled up or unlocked badges` }), tone: "success" });
      } else {
        for (const e of events) pushToast({ title: e, tone: "success" });
      }
    }
    try {
      localStorage.setItem(key, JSON.stringify(snapshot));
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progressionByAgent, selectedCompanyId]);

  return (
    <div className="w-full space-y-2">
      {/* Shared controls row: team chip filter + view-switch buttons. On phones
          this stacks (filters on their own row, buttons wrap below) so the chips
          never collide with the buttons; on ≥sm it's one row with the filter
          taking the free space and the buttons grouped on the right. */}
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <div className="min-w-0 sm:flex-1">
          <TeamFilterBar teams={allTeams} selected={teamFilter} onToggle={toggleTeam} onClear={clearTeams} />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
        {/* Zoom control — same row as the filters, left of the view switch. Uses
            theme tokens so it flips with dark/light mode (dark bg + light text in
            dark mode, and the reverse in light mode). Only meaningful for the
            pixel floor, so it's hidden in the catalog view. */}
        {view === "office" && !isMobile && (
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => setUserZoom(clampZoom((userZoom ?? fitZoom) - 0.2))}
              title="Zoom out"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-background text-sm font-bold text-foreground transition-colors hover:bg-accent"
            >−</button>
            <button
              type="button"
              onClick={() => setUserZoom(null)}
              title="Fit to screen"
              className="inline-flex h-7 items-center justify-center rounded-md border border-border bg-background px-2.5 text-xs font-bold text-foreground transition-colors hover:bg-accent"
            >FIT</button>
            <button
              type="button"
              onClick={() => setUserZoom(clampZoom((userZoom ?? fitZoom) + 0.2))}
              title="Zoom in"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-background text-sm font-bold text-foreground transition-colors hover:bg-accent"
            >+</button>
          </div>
        )}
        {/* Badge & level guide (圖鑑) — a static reference of all 15 badges and
            how levels are earned. Available in both views. */}
        <button
          type="button"
          onClick={() => setGuideOpen(true)}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Award className="h-3.5 w-3.5" />
          {t("office.guide", { defaultValue: "Guide" })}
        </button>
        {/* Toggle between the pixel floor and the player-card catalog. The label
            names the view you'll switch TO, mirroring the ViewSwitchButton style. */}
        <button
          type="button"
          onClick={() => setView((v) => (v === "office" ? "catalog" : "office"))}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          {view === "office" ? <LayoutGrid className="h-3.5 w-3.5" /> : <Building2 className="h-3.5 w-3.5" />}
          {view === "office"
            ? t("office.agentCatalog", { defaultValue: "Agent catalog" })
            : t("office.title", { defaultValue: "Virtual Office" })}
        </button>
        <ViewSwitchButton to="/agents" label={t("office.browseAgents", { defaultValue: "Browse agents" })} icon={Users} />
        </div>
      </div>

      {view === "office" ? (
        isMobile ? (
          /* Phones: the desktop floor is a single wide pixel-art image that scales
             down to unreadable, so swap in a stacked list of room cards (founder
             first, then by agent count). */
          <MobileOfficeRooms agents={visibleAgents} workingIds={workingAgentIds} onOpen={setActiveAgent} />
        ) : (
          /* Break out of the page's padding so the floor uses the full width/height —
             less wasted black space around the rooms. */
          <div className="-mx-4 -mb-4 md:-mx-6 md:-mb-6">
            <LivingOfficeFloor agents={visibleAgents} workingIds={workingAgentIds} skillCounts={skillCounts} liveRuns={liveRuns ?? []} onOpen={setActiveAgent} userZoom={userZoom} onFitZoomChange={setFitZoom} />
          </div>
        )
      ) : (
        <AgentCatalog
          agents={visibleAgents}
          workingIds={workingAgentIds}
          skillCounts={skillCounts}
          leaderboardByUser={leaderboardByUser}
          progressionByAgent={progressionByAgent}
          canView={canViewAgent}
          onOpen={setActiveAgent}
        />
      )}

      <OfficeGuideDialog open={guideOpen} onClose={() => setGuideOpen(false)} />

      <AgentModal
        agent={activeAgent}
        companyId={selectedCompanyId ?? ""}
        canManage={activeAgent ? canViewAgent(activeAgent.id) : false}
        canView={activeAgent ? canViewAgent(activeAgent.id) : false}
        working={activeAgent ? workingAgentIds.has(activeAgent.id) : false}
        skillCount={activeAgent ? skillCounts?.[activeAgent.id] ?? 0 : 0}
        score={activeAgent && activeAgent.metadata ? null : null}
        leaderboard={activeAgent ? findLeaderboardForAgent(leaderboardByUser, activeAgent) : null}
        progression={activeAgent ? progressionByAgent?.[activeAgent.id] ?? null : null}
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

// Level + XP progress toward the next level. Reuses the shared rank ladder.
function LevelBar({ progression, className }: { progression: AgentProgression; className?: string }) {
  const { t, i18n } = useTranslation();
  const zh = i18n.language?.startsWith("zh");
  const span = Math.max(1, progression.nextLevelXp - progression.levelFloorXp);
  const filled = Math.min(1, Math.max(0, (progression.totalXp - progression.levelFloorXp) / span));
  return (
    <div className={cn("w-full", className)}>
      <div className="flex items-baseline justify-between gap-2 text-[11px]">
        <span className="min-w-0 truncate font-semibold">
          {t("office.levelShort", { defaultValue: "Lv" })}{progression.level} · {zh ? progression.title.zh : progression.title.en}
        </span>
        <span className="shrink-0 tabular-nums text-muted-foreground">{progression.totalXp.toLocaleString()} XP</span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${Math.round(filled * 100)}%` }} />
      </div>
    </div>
  );
}

// Badge shelf. Compact (catalog card) = earned emoji row + count; full (modal) =
// all 15 with locked ones dimmed and showing progress toward their threshold.
function BadgeShelf({ progression, full }: { progression: AgentProgression; full?: boolean }) {
  const { t, i18n } = useTranslation();
  const zh = i18n.language?.startsWith("zh");
  const label = (b: AgentBadgeState) => (zh ? b.zh : b.en);
  if (!full) {
    const earned = progression.badges.filter((b) => b.earned);
    return (
      <div className="mt-2 flex min-h-5 w-full flex-wrap items-center justify-center gap-1">
        {earned.length === 0 ? (
          <span className="text-[11px] text-muted-foreground/70">{t("office.noBadgesYet", { defaultValue: "No badges yet" })}</span>
        ) : (
          <>
            {earned.slice(0, 6).map((b) => (
              <span key={b.key} title={label(b)} className="text-base leading-none">{b.emoji}</span>
            ))}
            <span className="ml-0.5 text-[11px] tabular-nums text-muted-foreground">
              {earned.length}/{progression.badges.length}
            </span>
          </>
        )}
      </div>
    );
  }
  return (
    <div className="mt-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold">{t("office.badges", { defaultValue: "Badges" })}</span>
        <span className="text-[11px] tabular-nums text-muted-foreground">
          {progression.earnedCount}/{progression.badges.length}
        </span>
      </div>
      <div className="grid grid-cols-5 gap-2">
        {progression.badges.map((b) => {
          const info = OFFICE_BADGE_BY_KEY[b.key];
          const req = info ? (zh ? info.reqZh : info.reqEn) : "";
          const state = b.earned ? t("office.badgeEarned", { defaultValue: "Earned" }) : `${b.current}/${b.target}`;
          return (
            <div
              key={b.key}
              title={`${label(b)} · +${b.xp} XP\n${req}\n(${state})`}
              className={cn(
                "flex flex-col items-center gap-1 rounded-lg border p-2 text-center",
                b.earned ? "border-border bg-accent/40" : "border-border/60 opacity-50",
              )}
            >
              <span className={cn("text-xl leading-none", b.earned ? "" : "grayscale")}>{b.emoji}</span>
              <span className="line-clamp-2 text-[10px] leading-tight">{label(b)}</span>
              {!b.earned && <span className="text-[9px] tabular-nums text-muted-foreground">{b.current}/{b.target}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AgentModal({ agent, companyId, canManage, canView, working, skillCount, leaderboard, progression, onClose }: {
  agent: Agent | null;
  companyId: string;
  canManage: boolean;
  canView: boolean;
  working: boolean;
  skillCount: number;
  score: number | null;
  leaderboard: LeaderboardEntry | null;
  progression: AgentProgression | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const upload = useMutation({
    mutationFn: async (file: File) => {
      const asset = await assetsApi.uploadImage(companyId, file, "office-avatar");
      return agentsApi.setOfficeAvatar(agent!.id, asset.contentPath, companyId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) });
      // The office floor/catalog render from the roster, not agents.list.
      queryClient.invalidateQueries({ queryKey: ["office-roster", companyId] });
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

        {progression && <LevelBar progression={progression} className="mt-4" />}

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

        {progression && <BadgeShelf progression={progression} full />}

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

// Catalog view: the same player-card content as the modal, laid out as a
// responsive grid of cards. Uses the already-team-filtered `agents`, so the
// team chips filter this view exactly like they filter the floor.
function AgentCatalog({ agents, workingIds, skillCounts, leaderboardByUser, progressionByAgent, canView, onOpen }: {
  agents: Agent[];
  workingIds: Set<string>;
  skillCounts: Record<string, number> | undefined;
  leaderboardByUser: Map<string, LeaderboardEntry>;
  progressionByAgent: Record<string, AgentProgression> | undefined;
  canView: (agentId: string) => boolean;
  onOpen: (agent: Agent) => void;
}) {
  const { t } = useTranslation();
  if (agents.length === 0) {
    return (
      <div className="py-20 text-center text-sm text-muted-foreground">
        {t("office.noAgents", { defaultValue: "No agents match this filter." })}
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
      {agents.map((agent) => (
        <AgentCatalogCard
          key={agent.id}
          agent={agent}
          working={workingIds.has(agent.id)}
          skillCount={skillCounts?.[agent.id] ?? 0}
          leaderboard={findLeaderboardForAgent(leaderboardByUser, agent)}
          progression={progressionByAgent?.[agent.id] ?? null}
          canView={canView(agent.id)}
          onOpen={onOpen}
        />
      ))}
    </div>
  );
}

function AgentCatalogCard({ agent, working, skillCount, leaderboard, progression, canView, onOpen }: {
  agent: Agent;
  working: boolean;
  skillCount: number;
  leaderboard: LeaderboardEntry | null;
  progression: AgentProgression | null;
  canView: boolean;
  onOpen: (agent: Agent) => void;
}) {
  const { t } = useTranslation();
  const status = statusInfo(agent, working, t);
  const lastSeen = agent.lastHeartbeatAt ? new Date(agent.lastHeartbeatAt).toLocaleString() : null;
  return (
    // The whole card opens the player-card detail (level + earned badges). The
    // "view agent" button below stops propagation to go to the full agent page.
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(agent)}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(agent); } }}
      className="flex cursor-pointer flex-col items-center rounded-xl border border-border bg-card p-4 text-center transition-colors hover:border-foreground/30 hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <div className={cn(
        "relative flex h-24 w-24 shrink-0 items-center justify-center rounded-full border-2 bg-background",
        working ? "border-emerald-400/70" : "border-border",
      )}>
        <OfficeAvatar agent={agent} size={88} animated={false} clip={false} />
      </div>
      <div className="mt-3 w-full min-w-0">
        <div className="truncate text-sm font-bold">{displayAgentName(agent.name)}</div>
        <div className="truncate text-xs text-muted-foreground">{agent.title ?? agent.role}</div>
        <div className="mt-1.5 inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-[11px]">
          <span className={cn("h-2 w-2 rounded-full", status.dot)} />
          {status.label}
        </div>
      </div>
      {progression && <LevelBar progression={progression} className="mt-3" />}
      <div className="mt-3 grid w-full grid-cols-3 gap-2">
        <ModalStat icon={Wrench} value={skillCount} label={t("office.skills", { defaultValue: "skills" })} />
        <ModalStat icon={Trophy} value={leaderboard?.score ?? 0} label={t("office.minutes", { defaultValue: "minutes" })} />
        <ModalStat icon={Zap} value={working ? t("office.busy", { defaultValue: "Working" }) : t("office.idle", { defaultValue: "Idle" })} label={t("office.status", { defaultValue: "status" })} />
      </div>
      {progression && <BadgeShelf progression={progression} />}
      {lastSeen && (
        <div className="mt-2.5 flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
          <Clock className="h-3 w-3" />
          <span className="truncate">{t("office.lastActive", { defaultValue: "Last active" })}: {lastSeen}</span>
        </div>
      )}
      {canView ? (
        <Link
          to={agentUrl(agent)}
          onClick={(e) => e.stopPropagation()}
          className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          {t("office.viewAgent", { defaultValue: "View agent" })}
        </Link>
      ) : (
        <div className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-[11px] text-muted-foreground">
          <Lock className="h-3 w-3" />
          {t("office.noAccess", { defaultValue: "You don't manage this agent" })}
        </div>
      )}
    </div>
  );
}

// The 圖鑑: a static reference of how levels are earned + all 15 badges and
// their unlock requirements. Opened from the toolbar; independent of any agent.
function OfficeGuideDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const zh = i18n.language?.startsWith("zh");
  const ranks = rankLadder();
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <div className="flex items-center gap-2">
          <Award className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-bold">{t("office.guideTitle", { defaultValue: "Levels & Badges" })}</h2>
        </div>

        {/* How levels work */}
        <section className="mt-4">
          <h3 className="text-sm font-semibold">{t("office.levelsHeading", { defaultValue: "How levels work" })}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("office.levelsIntro", { defaultValue: "Agents earn XP for the work they do. XP never goes down — it sets the level and rank." })}
          </p>
          <ul className="mt-2 space-y-1">
            {XP_SOURCES.map((s, i) => (
              <li key={i} className="flex items-start gap-1.5 text-xs">
                <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-primary" />
                <span>{zh ? s.zh : s.en}</span>
              </li>
            ))}
          </ul>
          <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg border border-border p-3 sm:grid-cols-2">
            {ranks.map((r) => (
              <div key={r.level} className="flex items-baseline justify-between gap-2 text-xs">
                <span className="truncate">
                  <span className="font-semibold tabular-nums">Lv{r.level}</span>{" "}
                  <span className="text-muted-foreground">{zh ? r.zh : r.en}</span>
                </span>
                <span className="shrink-0 tabular-nums text-muted-foreground">{r.xp.toLocaleString()} XP</span>
              </div>
            ))}
          </div>
        </section>

        {/* All badges */}
        <section className="mt-5">
          <h3 className="text-sm font-semibold">
            {t("office.badgesHeading", { defaultValue: "Badges" })}{" "}
            <span className="font-normal text-muted-foreground">({OFFICE_BADGES.length})</span>
          </h3>
          <ul className="mt-2 space-y-1.5">
            {OFFICE_BADGES.map((b) => (
              <li key={b.key} className="flex items-center gap-3 rounded-lg border border-border p-2.5">
                <span className="text-2xl leading-none">{b.emoji}</span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{zh ? b.zh : b.en}</div>
                  <div className="text-xs text-muted-foreground">{zh ? b.reqZh : b.reqEn}</div>
                </div>
                <span className="shrink-0 rounded-full bg-accent px-2 py-0.5 text-[11px] font-semibold tabular-nums text-accent-foreground">
                  +{b.xp} XP
                </span>
              </li>
            ))}
          </ul>
        </section>
      </DialogContent>
    </Dialog>
  );
}
