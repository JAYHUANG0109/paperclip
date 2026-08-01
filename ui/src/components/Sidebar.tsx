import {
  Inbox,
  CircleDot,
  Target,
  LayoutDashboard,
  DollarSign,
  History,
  Search,
  SquarePen,
  Network,
  Boxes,
  Repeat,
  GitBranch,
  Package,
  Settings,
  FolderOpen,
  PanelLeftClose,
  PanelLeftOpen,
  Pin,
  MessagesSquare,
  CalendarDays,
  Trophy,
  Lightbulb,
  Building2,
  Bot,
  ListChecks,
  GanttChartSquare,
  LayoutGrid,
  Brain,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { attentionApi } from "../api/attention";
import { attentionBadgeCount } from "../lib/attention";
import { usePublishSharedQueryData, useSharedPollingQuery } from "../hooks/useSharedPolling";
import { NavLink } from "@/lib/router";
import { SidebarSection } from "./SidebarSection";
import { SidebarNavItem } from "./SidebarNavItem";
import { SidebarMyTasks } from "./SidebarMyTasks";
import { SidebarAgents } from "./SidebarAgents";
import { SidebarChat } from "./SidebarChat";
import { SidebarProjects } from "./SidebarProjects";
import { useDialogActions } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { useSidebar } from "../context/SidebarContext";
import { heartbeatsApi } from "../api/heartbeats";
import { instanceSettingsApi } from "../api/instanceSettings";
import { agentsApi } from "../api/agents";
import { accessApi } from "../api/access";
import { queryKeys } from "../lib/queryKeys";
import { useInboxBadge } from "../hooks/useInboxBadge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn, SIDEBAR_RAIL_HIDDEN_LABEL, agentUrl } from "../lib/utils";
import { PluginSlotOutlet } from "@/plugins/slots";
import { PluginLauncherOutlet } from "@/plugins/launchers";
import { SidebarCompanyMenu } from "./SidebarCompanyMenu";
import { useTranslation } from "@/i18n";
import { SHOW_LEADERBOARD, SHOW_BOUNTIES } from "@/lib/feature-flags";

// The three full-access people who still see the decluttered nav items
// (Leaderboard / Bounties / Goals / Wiki): 創辦人(tang) / Jay / 惠君(betty1).
// Nav-only allowlist — not a security control.
const NAV_ADMIN_EMAILS = new Set([
  "tang@seasonart.org",
  "jay20020109@seasonart.org",
  "betty1@seasonart.org",
]);

export function Sidebar() {
  const { t } = useTranslation();
  const { openNewIssue } = useDialogActions();
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { isMobile, collapsed, collapseLocked, peeking, toggleCollapsed, setCollapsed } = useSidebar();
  const rail = collapsed && !peeking;
  const inboxBadge = useInboxBadge(selectedCompanyId);
  // The agent this user is paired with (joined) — for the one-click "My Agent"
  // shortcut. Empty for unpaired users (the nav item is then hidden).
  const { data: myAgents } = useQuery({
    queryKey: queryKeys.agents.mine(selectedCompanyId!),
    queryFn: () => agentsApi.mine(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const myAgent = myAgents?.[0];
  const { data: experimentalSettings } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });
  const liveRunsQueryKey = queryKeys.liveRuns(selectedCompanyId!);
  const sharedLiveRuns = useSharedPollingQuery({
    companyId: selectedCompanyId,
    resourceKey: "live-runs",
    queryKey: liveRunsQueryKey,
    enabled: !!selectedCompanyId,
    // Event-sourced via LiveUpdatesProvider (GitHub issue 9627) + reconnect reconcile — no
    // interval poll needed. Polling here also re-armed React Query's timer on
    // every live-event cache write, a major source of steady-state churn.
    refetchInterval: false,
    leaderOnly: true,
  });
  const { data: liveRuns, dataUpdatedAt: liveRunsUpdatedAt } = useQuery({
    queryKey: liveRunsQueryKey,
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    // Driven by the shared leader-election gate rather than a per-tab interval,
    // so N open tabs no longer each poll live-runs every 10s.
    enabled: sharedLiveRuns.enabled,
    refetchInterval: sharedLiveRuns.refetchInterval,
  });
  usePublishSharedQueryData(sharedLiveRuns, liveRuns, liveRunsUpdatedAt);
  const liveRunCount = liveRuns?.length ?? 0;
  // Live indicator on "My Agent": lit only when THIS user's own agent has a live
  // run (mirrors the per-company "N live" on Dashboard, scoped to one agent).
  const myAgentLive = !!myAgent && (liveRuns ?? []).some((r) => r.agentId === myAgent.id);
  const showWorkspacesLink = experimentalSettings?.enableIsolatedWorkspaces === true;
  const showApps = experimentalSettings?.enableApps === true;
  const showPipelines = experimentalSettings?.enablePipelines === true;
  const showStatusCards = experimentalSettings?.enableStatusCards === true;
  const goalsLinkPending = experimentalSettings === undefined;
  const showGoalsLink = experimentalSettings?.enableGoalsSidebarLink === true;
  // Decisions (attention home) is an experimental surface (PAP-13481): the nav
  // item is hidden entirely until the flag is enabled (same no-flash pattern as
  // showWorkspacesLink — it defaults hidden, so no placeholder is needed).
  const showDecisions = experimentalSettings?.enableDecisions === true;
  const { data: attentionFeed } = useQuery({
    queryKey: queryKeys.attention(selectedCompanyId!),
    queryFn: () => attentionApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && showDecisions,
    refetchInterval: 60_000,
  });
  const attentionCount = attentionBadgeCount(attentionFeed);
  const showCases = experimentalSettings?.enableCases === true;
  // IA flag: branch the sidebar nav presentation. Default ON = streamlined
  // (top-level Projects link); users can opt out in experiments to get classic
  // (per-project collapsible, no Projects nav link). Upstream retired this
  // opt-out and hardcodes `true` (PAP-12472); the fork keeps the flag, so the
  // classic branch below stays reachable. Gating is navigation-only — all
  // routes stay registered in both modes.
  const streamlined = experimentalSettings?.enableStreamlinedLeftNavigation !== false;
  // Conference Room Chat flag (PAP-136/PAP-137): the Conference Room nav item
  // is a new surface, hidden entirely while the flag is off (same no-flash
  // pattern as showWorkspacesLink above).
  const conferenceRoomChatEnabled = experimentalSettings?.enableConferenceRoomChat === true;

  // Admin-only nav trimming: hide low-priority pages (Leaderboard, Bounties,
  // Goals, Wiki) from everyone EXCEPT the three full-access people, so the rest
  // aren't overwhelmed. Pinned to an explicit email allowlist (創辦人 / Jay /
  // 惠君) — mirrors RESTRICTED_FOLDER_EMAILS server-side — so it's exactly these
  // three regardless of role drift. Features/routes stay live; nav-only, not a
  // security boundary.
  const { data: boardAccess } = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
  });
  const viewerEmail = (boardAccess?.user?.email ?? "").trim().toLowerCase();
  const isAdminViewer = NAV_ADMIN_EMAILS.has(viewerEmail);

  const pluginContext = {
    companyId: selectedCompanyId,
    companyPrefix: selectedCompany?.issuePrefix ?? null,
  };

  return (
    <aside className="w-full h-full min-h-0 border-r border-border bg-background flex flex-col">
      {/* Top bar: Company name (bold) + Search — aligned with top sections (no visible border) */}
      <div className="flex items-center gap-1 px-3 h-12 shrink-0">
        <SidebarCompanyMenu />
        {/* In the collapsed rail the search/toggle controls don't fit beside the
            logo — keeping them would overflow the 64px rail and squeeze the logo
            out of alignment with the icon column below it (PAP-10676). They return
            as soon as the panel is expanded (pinned) or peeking. Expansion in the
            rail is still reachable via hover-peek + Pin and Cmd/Ctrl+B. */}
        {!rail ? (
          <>
            <Button
              asChild
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground shrink-0"
              aria-label={t("nav.search", { defaultValue: "Open search" })}
              title={t("nav.search", { defaultValue: "Open search" })}
            >
              <NavLink to="/search">
                <Search className="h-4 w-4" />
              </NavLink>
            </Button>
            {/* Desktop-only collapse/expand affordance. While peeking (hover flyout
                over the collapsed rail) it becomes a Pin that promotes the peek to a
                pinned-expanded sidebar; otherwise it toggles the pinned rail. Mobile
                uses the off-canvas drawer, so this control is hidden there. It is
                also hidden while a secondary sidebar forces the rail (collapseLocked):
                the user cannot expand the primary while a secondary sidebar is shown. */}
            {!isMobile && !collapseLocked ? (
              peeking ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground shrink-0"
                  aria-label={t("sidebar.keepExpanded", { defaultValue: "Keep sidebar expanded" })}
                  title={t("sidebar.keepExpanded", { defaultValue: "Keep sidebar expanded" })}
                  onClick={() => setCollapsed(false)}
                >
                  <Pin className="h-4 w-4" />
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground shrink-0"
                  aria-expanded={!collapsed}
                  aria-label={collapsed ? t("sidebar.expand", { defaultValue: "Expand sidebar" }) : t("sidebar.collapse", { defaultValue: "Collapse sidebar" })}
                  title={collapsed ? t("sidebar.expand", { defaultValue: "Expand sidebar" }) : t("sidebar.collapse", { defaultValue: "Collapse sidebar" })}
                  onClick={() => toggleCollapsed()}
                >
                  {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
                </Button>
              )
            ) : null}
          </>
        ) : null}
      </div>

      <nav className="flex-1 min-h-0 overflow-y-auto scrollbar-auto-hide flex flex-col gap-4 pointer-coarse:gap-3 px-3 py-2">
        <div className="flex flex-col gap-0.5">
          {/* New Task button aligned with nav items */}
          {(() => {
            const newTaskButton = (
              <button
                onClick={() => openNewIssue()}
                data-slot="icon-button"
                aria-label={rail ? t("nav.newIssue", { defaultValue: "New Task" }) : undefined}
                className="flex items-center gap-2.5 px-3 py-2 pointer-coarse:py-1.5 text-[13px] font-medium text-foreground/80 hover:bg-accent/50 hover:text-foreground transition-colors"
              >
                <SquarePen className="h-4 w-4 shrink-0" />
                <span className={rail ? SIDEBAR_RAIL_HIDDEN_LABEL : "truncate"}>{t("nav.newIssue", { defaultValue: "New Task" })}</span>
              </button>
            );
            return rail ? (
              <Tooltip>
                <TooltipTrigger asChild>{newTaskButton}</TooltipTrigger>
                <TooltipContent side="right">{t("nav.newIssue", { defaultValue: "New Task" })}</TooltipContent>
              </Tooltip>
            ) : (
              newTaskButton
            );
          })()}
          <SidebarNavItem to="/dashboard" label={t("nav.dashboard", { defaultValue: "Dashboard" })} icon={LayoutDashboard} liveCount={liveRunCount} />
          {myAgent ? (
            <SidebarNavItem to={agentUrl(myAgent)} label={t("nav.myAgent", { defaultValue: "My Agent" })} icon={Bot} liveCount={myAgentLive ? 1 : 0} />
          ) : null}
          <SidebarNavItem
            to="/inbox"
            label={t("nav.inbox", { defaultValue: "Inbox" })}
            icon={Inbox}
            badge={inboxBadge.inbox}
            badgeLabel={t("sidebar.unread", { defaultValue: "unread" })}
            badgeTone={inboxBadge.failedRuns > 0 ? "danger" : "default"}
            alert={inboxBadge.failedRuns > 0}
          />
          {showDecisions ? (
            <SidebarNavItem
              to="/decisions"
              label="Decisions"
              icon={ListChecks}
              badge={attentionCount}
              badgeLabel="decisions"
            />
          ) : null}
          {showStatusCards ? (
            <SidebarNavItem to="/status" label="Status" icon={LayoutGrid} textBadge="beta" />
          ) : null}
          {conferenceRoomChatEnabled ? (
            <SidebarNavItem to="/board-chat" label={t("nav.conferenceRoom", { defaultValue: "Conference Room" })} icon={MessagesSquare} />
          ) : null}
          <SidebarNavItem to="/decisions" label={t("nav.decisions", { defaultValue: "Decisions" })} icon={ListChecks} />
        </div>

        <SidebarSection label={t("nav.work", { defaultValue: "Work" })}>
          <SidebarNavItem to="/issues" label={t("nav.issues", { defaultValue: "Tasks" })} icon={CircleDot} />
          {/* This person's own open tasks, nested under Tasks. Scoped to the
              agent they are paired with, so every user sees their own list and
              nobody sees anyone else's. */}
          <SidebarMyTasks companyId={selectedCompanyId} agentId={myAgent?.id} rail={rail} />
          <SidebarNavItem to="/calendar" label={t("nav.calendar", { defaultValue: "Calendar" })} icon={CalendarDays} />
          {SHOW_LEADERBOARD && isAdminViewer && <SidebarNavItem to="/leaderboard" label={t("nav.leaderboard", { defaultValue: "Leaderboard" })} icon={Trophy} />}
          {SHOW_BOUNTIES && isAdminViewer && <SidebarNavItem to="/bounties" label={t("nav.bounties", { defaultValue: "Bounties" })} icon={Lightbulb} />}
          <SidebarNavItem to="/office" label={t("nav.office", { defaultValue: "Virtual Office" })} icon={Building2} />
          <SidebarNavItem to="/routines" label={t("nav.routines", { defaultValue: "Routines" })} icon={Repeat} />
          {isAdminViewer && <SidebarNavItem to="/goals" label={t("nav.goals", { defaultValue: "Goals" })} icon={Target} />}
          {/* Deliberately NOT behind isAdminViewer: everyone has their own
              memory, and it is scoped to the signed-in user server-side. Hiding
              it would leave people unable to see or correct what their agents
              remember about them. */}
          <SidebarNavItem to="/memory" label={t("nav.memory", { defaultValue: "Memory" })} icon={Brain} />
          <SidebarNavItem to="/artifacts" label={t("nav.artifacts", { defaultValue: "Artifacts" })} icon={Package} />
          <SidebarNavItem to="/skills" label={t("nav.skills", { defaultValue: "Skills" })} icon={Boxes} />
          {showWorkspacesLink ? (
            <SidebarNavItem to="/workspaces" label={t("nav.workspaces", { defaultValue: "Workspaces" })} icon={GitBranch} />
          ) : null}
          {streamlined ? (
            <SidebarNavItem to="/projects" label={t("nav.projects", { defaultValue: "Projects" })} icon={FolderOpen} />
          ) : null}
          {/* Plugin sidebar items (currently the LLM Wiki "Wiki" button) — hidden
              from non-admins for now to declutter. Admins still see it; the plugin
              and its pages stay installed/live. */}
          {isAdminViewer && (
            <PluginSlotOutlet
              slotTypes={["sidebar"]}
              context={pluginContext}
              className="flex flex-col gap-0.5"
              itemClassName="text-[13px] font-medium"
              missingBehavior="placeholder"
            />
          )}
          <PluginLauncherOutlet
            placementZones={["sidebar"]}
            context={pluginContext}
            className="flex flex-col gap-0.5"
            itemClassName="text-[13px] font-medium"
          />
        </SidebarSection>

        {/* Google Chat connector's "Chat" section (Chat Logs, Assignments).
            Renders nothing unless the plugin is installed and the viewer is an
            owner/admin. Restored after a merge dropped the mount. */}
        <SidebarChat />

        {/* Classic mode restores the per-project collapsible below Work. */}
        {streamlined ? null : <SidebarProjects />}

        <SidebarAgents streamlined={streamlined} />

        <SidebarSection label={t("nav.company", { defaultValue: "Company" })}>
          <SidebarNavItem to="/org" label={t("nav.org", { defaultValue: "Org" })} icon={Network} />
          <SidebarNavItem to="/costs" label={t("nav.costs", { defaultValue: "Costs" })} icon={DollarSign} />
          <SidebarNavItem to="/activity" label={t("nav.activity", { defaultValue: "Activity" })} icon={History} />
          <SidebarNavItem to="/company/settings" label={t("nav.settings", { defaultValue: "Settings" })} icon={Settings} />
        </SidebarSection>

        <PluginSlotOutlet
          slotTypes={["sidebarPanel"]}
          context={pluginContext}
          className="flex flex-col gap-3"
          itemClassName="rounded-lg border border-border p-3"
          missingBehavior="placeholder"
        />
      </nav>
    </aside>
  );
}
