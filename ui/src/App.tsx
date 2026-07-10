import { lazy, Suspense, useEffect, type ComponentType } from "react";
import { useQuery } from "@tanstack/react-query";
import { Navigate, Outlet, Route, Routes, useLocation, useParams } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/i18n";
import { authApi } from "@/api/auth";
import { queryKeys } from "@/lib/queryKeys";
import { applyLocale, resolveLocale } from "@/i18n/resolveLocale";
import { Layout } from "./components/Layout";
import { ConferenceRoomChatGate } from "./components/ConferenceRoomChatGate";
import { OnboardingWizardVariant } from "./components/OnboardingWizardVariant";
import { CloudAccessGate } from "./components/CloudAccessGate";
// NotFoundPage stays eager: it's tiny and rendered synchronously for invalid
// routes/prefixes, so lazy-loading it would only add a needless loading flash.
import { NotFoundPage } from "./pages/NotFound";

// Every page below is code-split into its own chunk via React.lazy, so opening
// the app no longer downloads + parses the JS for all ~50 pages up front — only
// the shell (this file + Layout) plus the one page you land on. This is the main
// lever on first-load speed; a Suspense boundary inside Layout shows a skeleton
// in the content area (sidebar stays) while a page chunk streams in.
// `lazyPage` unwraps our named page exports into the default export React.lazy expects.
function lazyPage<M, K extends keyof M>(loader: () => Promise<M>, key: K) {
  return lazy(() => loader().then((m) => ({ default: m[key] as unknown as ComponentType })));
}

const Dashboard = lazyPage(() => import("./pages/Dashboard"), "Dashboard");
const DashboardLive = lazyPage(() => import("./pages/DashboardLive"), "DashboardLive");
const Timeline = lazyPage(() => import("./pages/Timeline"), "Timeline");
const Companies = lazyPage(() => import("./pages/Companies"), "Companies");
const Agents = lazyPage(() => import("./pages/Agents"), "Agents");
const AgentDetail = lazyPage(() => import("./pages/AgentDetail"), "AgentDetail");
const Projects = lazyPage(() => import("./pages/Projects"), "Projects");
const ProjectDetail = lazyPage(() => import("./pages/ProjectDetail"), "ProjectDetail");
const ProjectWorkspaceDetail = lazyPage(() => import("./pages/ProjectWorkspaceDetail"), "ProjectWorkspaceDetail");
const Workspaces = lazyPage(() => import("./pages/Workspaces"), "Workspaces");
const Issues = lazyPage(() => import("./pages/Issues"), "Issues");
const MyCalendar = lazyPage(() => import("./pages/MyCalendar"), "MyCalendar");
const Leaderboard = lazyPage(() => import("./pages/Leaderboard"), "Leaderboard");
const Bounties = lazyPage(() => import("./pages/Bounties"), "Bounties");
const VirtualOffice = lazyPage(() => import("./pages/VirtualOffice"), "VirtualOffice");
const Search = lazyPage(() => import("./pages/Search"), "Search");
const IssueDetail = lazyPage(() => import("./pages/IssueDetail"), "IssueDetail");
const IssueChatLongThreadPerf = lazyPage(() => import("./pages/IssueChatLongThreadPerf"), "IssueChatLongThreadPerf");
const Routines = lazyPage(() => import("./pages/Routines"), "Routines");
const RoutineDetail = lazyPage(() => import("./pages/RoutineDetail"), "RoutineDetail");
const UserProfile = lazyPage(() => import("./pages/UserProfile"), "UserProfile");
const ExecutionWorkspaceDetail = lazyPage(() => import("./pages/ExecutionWorkspaceDetail"), "ExecutionWorkspaceDetail");
const Goals = lazyPage(() => import("./pages/Goals"), "Goals");
const Artifacts = lazyPage(() => import("./pages/Artifacts"), "Artifacts");
const GoalDetail = lazyPage(() => import("./pages/GoalDetail"), "GoalDetail");
const Approvals = lazyPage(() => import("./pages/Approvals"), "Approvals");
const ApprovalDetail = lazyPage(() => import("./pages/ApprovalDetail"), "ApprovalDetail");
const Costs = lazyPage(() => import("./pages/Costs"), "Costs");
const Activity = lazyPage(() => import("./pages/Activity"), "Activity");
const Inbox = lazyPage(() => import("./pages/Inbox"), "Inbox");
const BoardChat = lazyPage(() => import("./pages/BoardChat"), "BoardChat");
const CompanySettings = lazyPage(() => import("./pages/CompanySettings"), "CompanySettings");
const CompanyEnvironments = lazyPage(() => import("./pages/CompanyEnvironments"), "CompanyEnvironments");
const CloudUpstream = lazyPage(() => import("./pages/CloudUpstream"), "CloudUpstream");
const CloudUpstreamUxLab = lazyPage(() => import("./pages/CloudUpstreamUxLab"), "CloudUpstreamUxLab");
const BootstrapSetupUxLab = lazyPage(() => import("./pages/BootstrapSetupUxLab"), "BootstrapSetupUxLab");
const ResponsibleUserDenialUxLab = lazyPage(() => import("./pages/ResponsibleUserDenialUxLab"), "ResponsibleUserDenialUxLab");
const CompanySettingsPluginPage = lazyPage(() => import("./pages/CompanySettingsPluginPage"), "CompanySettingsPluginPage");
const CompanyAccess = lazyPage(() => import("./pages/CompanyAccess"), "CompanyAccess");
const CompanyAccessLegacyRoute = lazyPage(() => import("./pages/CompanyAccess"), "CompanyAccessLegacyRoute");
const CompanyInvites = lazyPage(() => import("./pages/CompanyInvites"), "CompanyInvites");
const CompanySkills = lazyPage(() => import("./pages/CompanySkills"), "CompanySkills");
const Secrets = lazyPage(() => import("./pages/Secrets"), "Secrets");
const CompanyExport = lazyPage(() => import("./pages/CompanyExport"), "CompanyExport");
const CompanyImport = lazyPage(() => import("./pages/CompanyImport"), "CompanyImport");
const DesignGuide = lazyPage(() => import("./pages/DesignGuide"), "DesignGuide");
const InstanceGeneralSettings = lazyPage(() => import("./pages/InstanceGeneralSettings"), "InstanceGeneralSettings");
const InstanceAccess = lazyPage(() => import("./pages/InstanceAccess"), "InstanceAccess");
const InstanceSettings = lazyPage(() => import("./pages/InstanceSettings"), "InstanceSettings");
const InstanceExperimentalSettings = lazyPage(() => import("./pages/InstanceExperimentalSettings"), "InstanceExperimentalSettings");
const ProfileSettings = lazyPage(() => import("./pages/ProfileSettings"), "ProfileSettings");
const PluginManager = lazyPage(() => import("./pages/PluginManager"), "PluginManager");
const PluginSettings = lazyPage(() => import("./pages/PluginSettings"), "PluginSettings");
const AdapterManager = lazyPage(() => import("./pages/AdapterManager"), "AdapterManager");
const PluginPage = lazyPage(() => import("./pages/PluginPage"), "PluginPage");
const OrgChart = lazyPage(() => import("./pages/OrgChart"), "OrgChart");
const NewAgent = lazyPage(() => import("./pages/NewAgent"), "NewAgent");
const AuthPage = lazyPage(() => import("./pages/Auth"), "AuthPage");
const BoardClaimPage = lazyPage(() => import("./pages/BoardClaim"), "BoardClaimPage");
const CliAuthPage = lazyPage(() => import("./pages/CliAuth"), "CliAuthPage");
const InviteLandingPage = lazyPage(() => import("./pages/InviteLanding"), "InviteLandingPage");
const JoinRequestQueue = lazyPage(() => import("./pages/JoinRequestQueue"), "JoinRequestQueue");
import { useCompany } from "./context/CompanyContext";
import { useDialogActions, useDialogState } from "./context/DialogContext";
import { loadLastInboxTab } from "./lib/inbox";
import {
  isOnboardingWizardActive,
  shouldRedirectCompanylessRouteToOnboarding,
} from "./lib/onboarding-route";
import { normalizeRememberedInstanceSettingsPath } from "./lib/instance-settings";
import { SHOW_LEADERBOARD, SHOW_BOUNTIES } from "./lib/feature-flags";

function boardRoutes() {
  return (
    <>
      <Route index element={<Navigate to="dashboard" replace />} />
      <Route path="dashboard" element={<Dashboard />} />
      <Route path="dashboard/live" element={<DashboardLive />} />
      <Route path="timeline" element={<Timeline />} />
      <Route path="onboarding" element={<OnboardingRoutePage />} />
      <Route path="companies" element={<Companies />} />
      <Route path="company/settings" element={<CompanySettings />} />
      <Route path="company/settings/environments" element={<Navigate to="/company/settings/instance/environments" replace />} />
      <Route path="company/settings/cloud-upstream" element={<CloudUpstream />} />
      <Route path="company/settings/members" element={<CompanyAccess />} />
      <Route path="company/settings/access" element={<CompanyAccessLegacyRoute />} />
      <Route path="company/settings/cloud-upstream" element={<CloudUpstream />} />
      <Route path="company/settings/invites" element={<CompanyInvites />} />
      <Route path="company/export/*" element={<CompanyExport />} />
      <Route path="company/import" element={<CompanyImport />} />
      <Route path="company/settings/secrets" element={<Secrets />} />
      <Route path="company/settings/instance" element={<Navigate to="general" replace />} />
      <Route path="company/settings/instance/profile" element={<ProfileSettings />} />
      <Route path="company/settings/instance/general" element={<InstanceGeneralSettings />} />
      <Route path="company/settings/instance/environments" element={<CompanyEnvironments />} />
      <Route path="company/settings/instance/access" element={<InstanceAccess />} />
      <Route path="company/settings/instance/heartbeats" element={<InstanceSettings />} />
      <Route path="company/settings/instance/experimental" element={<InstanceExperimentalSettings />} />
      <Route path="company/settings/instance/plugins" element={<PluginManager />} />
      <Route path="company/settings/instance/plugins/:pluginId" element={<PluginSettings />} />
      <Route path="company/settings/instance/adapters" element={<AdapterManager />} />
      <Route path="company/settings/:settingsRoutePath/*" element={<CompanySettingsPluginPage />} />
      <Route path="skills/*" element={<CompanySkills />} />
      <Route path="settings" element={<LegacySettingsRedirect />} />
      <Route path="settings/*" element={<LegacySettingsRedirect />} />
      <Route path="plugins/:pluginId" element={<PluginPage />} />
      <Route path="org" element={<OrgChart />} />
      <Route path="agents" element={<Navigate to="/agents/all" replace />} />
      <Route path="agents/all" element={<Agents />} />
      <Route path="agents/active" element={<Agents />} />
      <Route path="agents/paused" element={<Agents />} />
      <Route path="agents/error" element={<Agents />} />
      <Route path="agents/new" element={<NewAgent />} />
      <Route path="agents/:agentId" element={<AgentDetail />} />
      <Route path="agents/:agentId/:tab" element={<AgentDetail />} />
      <Route path="agents/:agentId/runs/:runId" element={<AgentDetail />} />
      <Route path="projects" element={<Projects />} />
      <Route path="projects/:projectId" element={<ProjectDetail />} />
      <Route path="projects/:projectId/overview" element={<ProjectDetail />} />
      <Route path="projects/:projectId/issues" element={<ProjectDetail />} />
      <Route path="projects/:projectId/issues/:filter" element={<ProjectDetail />} />
      <Route path="projects/:projectId/fields" element={<ProjectDetail />} />
      <Route path="projects/:projectId/workspaces/:workspaceId" element={<ProjectWorkspaceDetail />} />
      <Route path="projects/:projectId/workspaces" element={<ProjectDetail />} />
      <Route path="projects/:projectId/configuration" element={<ProjectDetail />} />
      <Route path="projects/:projectId/budget" element={<ProjectDetail />} />
      <Route path="workspaces" element={<Workspaces />} />
      <Route path="issues" element={<Issues />} />
      <Route path="calendar" element={<MyCalendar />} />
      <Route path="leaderboard" element={SHOW_LEADERBOARD ? <Leaderboard /> : <Navigate to="../dashboard" replace />} />
      <Route path="bounties" element={SHOW_BOUNTIES ? <Bounties /> : <Navigate to="../dashboard" replace />} />
      <Route path="office" element={<VirtualOffice />} />
      <Route path="search" element={<Search />} />
      <Route path="issues/all" element={<Navigate to="/issues" replace />} />
      <Route path="issues/active" element={<Navigate to="/issues" replace />} />
      <Route path="issues/backlog" element={<Navigate to="/issues" replace />} />
      <Route path="issues/done" element={<Navigate to="/issues" replace />} />
      <Route path="issues/recent" element={<Navigate to="/issues" replace />} />
      <Route path="issues/:issueId" element={<IssueDetail />} />
      {import.meta.env.DEV ? (
        <Route path="tests/perf/long-thread" element={<IssueChatLongThreadPerf />} />
      ) : null}
      <Route path="routines" element={<Routines />} />
      <Route path="routines/:routineId" element={<RoutineDetail />} />
      <Route path="routines/:routineId/:section" element={<RoutineDetail />} />
      <Route path="execution-workspaces/:workspaceId" element={<ExecutionWorkspaceDetail />} />
      <Route path="execution-workspaces/:workspaceId/services" element={<ExecutionWorkspaceDetail />} />
      <Route path="execution-workspaces/:workspaceId/configuration" element={<ExecutionWorkspaceDetail />} />
      <Route path="execution-workspaces/:workspaceId/runtime-logs" element={<ExecutionWorkspaceDetail />} />
      <Route path="execution-workspaces/:workspaceId/issues" element={<ExecutionWorkspaceDetail />} />
      <Route path="execution-workspaces/:workspaceId/routines" element={<ExecutionWorkspaceDetail />} />
      <Route path="goals" element={<Goals />} />
      <Route path="goals/:goalId" element={<GoalDetail />} />
      <Route path="artifacts" element={<Artifacts />} />
      <Route path="approvals" element={<Navigate to="/approvals/pending" replace />} />
      <Route path="approvals/pending" element={<Approvals />} />
      <Route path="approvals/all" element={<Approvals />} />
      <Route path="approvals/:approvalId" element={<ApprovalDetail />} />
      <Route path="costs" element={<Costs />} />
      <Route path="activity" element={<Activity />} />
      {/* Conference Room Chat surfaces (PAP-136/PAP-137): routes stay
          registered but redirect to the company home while the experimental
          flag is off. The board-level `artifacts` mount below is the new
          conference-room one; the master-level mount above it still serves
          `/artifacts` in both modes. */}
      <Route element={<ConferenceRoomChatGate />}>
        <Route path="board-chat" element={<BoardChat />} />
        <Route path="artifacts" element={<Artifacts />} />
      </Route>
      <Route path="inbox" element={<InboxRootRedirect />} />
      <Route path="inbox/mine" element={<Inbox />} />
      <Route path="inbox/recent" element={<Inbox />} />
      <Route path="inbox/unread" element={<Inbox />} />
      <Route path="inbox/blocked" element={<Inbox />} />
      <Route path="inbox/all" element={<Inbox />} />
      <Route path="inbox/requests" element={<JoinRequestQueue />} />
      <Route path="inbox/new" element={<Navigate to="/inbox/mine" replace />} />
      <Route path="u/:userSlug" element={<UserProfile />} />
      <Route path="design-guide" element={<DesignGuide />} />
      <Route path="instance/settings/adapters" element={<AdapterManager />} />
      <Route path=":pluginRoutePath/*" element={<PluginPage />} />
      <Route path="*" element={<NotFoundPage scope="board" />} />
    </>
  );
}

/** Minimal, theme-neutral fallback while an out-of-Layout route chunk loads. */
function FullPageLoader() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div
        className="h-6 w-6 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground"
        aria-label="Loading"
      />
    </div>
  );
}

function InboxRootRedirect() {
  return <Navigate to={`/inbox/${loadLastInboxTab()}`} replace />;
}

function LegacySettingsRedirect() {
  const location = useLocation();
  const { companies, selectedCompany, loading } = useCompany();
  const { companyPrefix } = useParams<{ companyPrefix?: string }>();

  if (loading) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">Loading...</div>;
  }

  const targetCompany =
    (companyPrefix
      ? companies.find((company) => company.issuePrefix.toUpperCase() === companyPrefix.toUpperCase())
      : null) ??
    selectedCompany ??
    companies[0] ??
    null;

  if (!targetCompany) {
    if (
      shouldRedirectCompanylessRouteToOnboarding({
        pathname: location.pathname,
        hasCompanies: false,
      })
    ) {
      return <Navigate to="/onboarding" replace />;
    }
    return <NoCompaniesStartPage />;
  }

  const normalizedPath = normalizeRememberedInstanceSettingsPath(
    `${location.pathname}${location.search}${location.hash}`,
  );

  return (
    <Navigate
      to={`/${targetCompany.issuePrefix}${normalizedPath}`}
      replace
    />
  );
}

function OnboardingRoutePage() {
  const { companies } = useCompany();
  const { openOnboarding } = useDialogActions();
  const { onboardingOpen, onboardingRouteDismissed } = useDialogState();
  const { companyPrefix } = useParams<{ companyPrefix?: string }>();

  // The OnboardingWizard auto-opens on this route (and can also be opened
  // explicitly). While it is showing it covers the whole screen, so the
  // launcher card below must not stay interactive behind it — otherwise users
  // can tab/click through to the form behind the modal (PAP-52). The launcher
  // only needs to render as a re-entry point once the wizard is dismissed.
  if (isOnboardingWizardActive({ onboardingOpen, routeDismissed: onboardingRouteDismissed })) {
    return null;
  }
  const matchedCompany = companyPrefix
    ? companies.find((company) => company.issuePrefix.toUpperCase() === companyPrefix.toUpperCase()) ?? null
    : null;

  const title = matchedCompany
    ? `Add another agent to ${matchedCompany.name}`
    : companies.length > 0
      ? "Create another company"
      : "Create your first company";
  const description = matchedCompany
    ? "Run onboarding again to add an agent and a starter task for this company."
    : companies.length > 0
      ? "Run onboarding again to create another company and seed its first agent."
      : "Get started by creating a company and your first agent.";

  return (
    <div className="mx-auto max-w-xl py-10">
      <div className="rounded-lg border border-border bg-card p-6">
        <h1 className="text-xl font-semibold">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{description}</p>
        <div className="mt-4">
          <Button
            onClick={() =>
              matchedCompany
                ? openOnboarding({ initialStep: 2, companyId: matchedCompany.id })
                : openOnboarding()
            }
          >
            {matchedCompany ? "Add Agent" : "Start Onboarding"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function CompanyRootRedirect() {
  const { companies, selectedCompany, loading } = useCompany();
  const location = useLocation();

  if (loading) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">Loading...</div>;
  }

  const targetCompany = selectedCompany ?? companies[0] ?? null;
  if (!targetCompany) {
    if (
      shouldRedirectCompanylessRouteToOnboarding({
        pathname: location.pathname,
        hasCompanies: false,
      })
    ) {
      return <Navigate to="/onboarding" replace />;
    }
    return <NoCompaniesStartPage />;
  }

  return <Navigate to={`/${targetCompany.issuePrefix}/dashboard`} replace />;
}

function UnprefixedBoardRedirect() {
  const location = useLocation();
  const { companies, selectedCompany, loading } = useCompany();

  if (loading) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">Loading...</div>;
  }

  const targetCompany = selectedCompany ?? companies[0] ?? null;
  if (!targetCompany) {
    if (
      shouldRedirectCompanylessRouteToOnboarding({
        pathname: location.pathname,
        hasCompanies: false,
      })
    ) {
      return <Navigate to="/onboarding" replace />;
    }
    return <NoCompaniesStartPage />;
  }

  return (
    <Navigate
      to={`/${targetCompany.issuePrefix}${location.pathname}${location.search}${location.hash}`}
      replace
    />
  );
}

function NoCompaniesStartPage() {
  const { openOnboarding } = useDialogActions();
  const { t } = useTranslation();

  return (
    <div className="mx-auto max-w-xl py-10">
      <div className="rounded-lg border border-border bg-card p-6">
        <h1 className="text-xl font-semibold">
          {t("app.noCompanies.title", { defaultValue: "Create your first company" })}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("app.noCompanies.description", { defaultValue: "Get started by creating a company." })}
        </p>
        <div className="mt-4">
          <Button onClick={() => openOnboarding()}>
            {t("app.noCompanies.newCompany", { defaultValue: "New Company" })}
          </Button>
        </div>
      </div>
    </div>
  );
}

function LocaleSync() {
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: authApi.getSession,
  });
  const email = session?.user?.email ?? null;
  useEffect(() => {
    applyLocale(resolveLocale(email));
  }, [email]);
  return null;
}

export function App() {
  return (
    <>
      <LocaleSync />
      {/* Outermost boundary for lazy routes that render OUTSIDE Layout (auth,
          invite, ux-lab). In-app pages suspend against the finer boundary inside
          Layout instead, so navigating between them never blanks the sidebar. */}
      <Suspense fallback={<FullPageLoader />}>
      <Routes>
        <Route path="auth" element={<AuthPage />} />
        <Route path="board-claim/:token" element={<BoardClaimPage />} />
        <Route path="cli-auth/:id" element={<CliAuthPage />} />
        <Route path="invite/:token" element={<InviteLandingPage />} />
        <Route path="tests/perf/long-thread" element={<IssueChatLongThreadPerf />} />
        <Route path="ux-lab/cloud-upstream" element={<CloudUpstreamUxLab />} />
        <Route path="ux-lab/bootstrap-setup" element={<BootstrapSetupUxLab />} />
        <Route path="ux-lab/responsible-user-denial" element={<ResponsibleUserDenialUxLab />} />

        <Route element={<CloudAccessGate />}>
          <Route index element={<CompanyRootRedirect />} />
          <Route path="onboarding" element={<OnboardingRoutePage />} />
          <Route path="instance" element={<LegacySettingsRedirect />} />
          <Route path="instance/settings" element={<LegacySettingsRedirect />} />
          <Route path="instance/settings/*" element={<LegacySettingsRedirect />} />
          <Route path="companies" element={<UnprefixedBoardRedirect />} />
          <Route path="issues" element={<UnprefixedBoardRedirect />} />
          <Route path="issues/:issueId" element={<UnprefixedBoardRedirect />} />
          <Route path="routines" element={<UnprefixedBoardRedirect />} />
          <Route path="routines/:routineId" element={<UnprefixedBoardRedirect />} />
          <Route path="artifacts" element={<UnprefixedBoardRedirect />} />
          <Route path="calendar" element={<UnprefixedBoardRedirect />} />
          <Route path="leaderboard" element={<UnprefixedBoardRedirect />} />
          <Route path="bounties" element={<UnprefixedBoardRedirect />} />
          <Route path="office" element={<UnprefixedBoardRedirect />} />
          <Route path="u/:userSlug" element={<UnprefixedBoardRedirect />} />
          <Route path="skills/*" element={<UnprefixedBoardRedirect />} />
          <Route path="settings" element={<LegacySettingsRedirect />} />
          <Route path="settings/*" element={<LegacySettingsRedirect />} />
          <Route path="agents" element={<UnprefixedBoardRedirect />} />
          <Route path="agents/new" element={<UnprefixedBoardRedirect />} />
          <Route path="agents/:agentId" element={<UnprefixedBoardRedirect />} />
          <Route path="agents/:agentId/:tab" element={<UnprefixedBoardRedirect />} />
          <Route path="agents/:agentId/runs/:runId" element={<UnprefixedBoardRedirect />} />
          <Route path="projects" element={<UnprefixedBoardRedirect />} />
          <Route path="projects/:projectId" element={<UnprefixedBoardRedirect />} />
          <Route path="projects/:projectId/overview" element={<UnprefixedBoardRedirect />} />
          <Route path="projects/:projectId/issues" element={<UnprefixedBoardRedirect />} />
          <Route path="projects/:projectId/issues/:filter" element={<UnprefixedBoardRedirect />} />
          <Route path="projects/:projectId/workspaces" element={<UnprefixedBoardRedirect />} />
          <Route path="projects/:projectId/workspaces/:workspaceId" element={<UnprefixedBoardRedirect />} />
          <Route path="projects/:projectId/configuration" element={<UnprefixedBoardRedirect />} />
          <Route path="workspaces" element={<UnprefixedBoardRedirect />} />
          <Route path="execution-workspaces/:workspaceId" element={<UnprefixedBoardRedirect />} />
          <Route path="execution-workspaces/:workspaceId/services" element={<UnprefixedBoardRedirect />} />
          <Route path="execution-workspaces/:workspaceId/configuration" element={<UnprefixedBoardRedirect />} />
          <Route path="execution-workspaces/:workspaceId/runtime-logs" element={<UnprefixedBoardRedirect />} />
          <Route path="execution-workspaces/:workspaceId/issues" element={<UnprefixedBoardRedirect />} />
          <Route path="execution-workspaces/:workspaceId/routines" element={<UnprefixedBoardRedirect />} />
          <Route path=":companyPrefix" element={<Layout />}>
            {boardRoutes()}
          </Route>
          <Route path="*" element={<NotFoundPage scope="global" />} />
        </Route>
      </Routes>
      </Suspense>
      <OnboardingWizardVariant />
    </>
  );
}
