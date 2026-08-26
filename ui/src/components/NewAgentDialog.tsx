import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { accessApi } from "../api/access";
import { agentsApi } from "../api/agents";
import { adaptersApi } from "../api/adapters";
import { queryKeys } from "@/lib/queryKeys";
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  ArrowLeft,
  Bot,
  Check,
  MailPlus,
  Settings2,
  UserRoundPlus,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { NewColleagueAgentForm } from "@/components/NewColleagueAgentForm";
import { buildAgentOnboardingPrompt } from "@/lib/agent-onboarding-prompt";
import { listUIAdapters } from "../adapters";
import { isVisualAdapterChoice } from "../adapters/metadata";
import { getAdapterDisplay } from "../adapters/adapter-display-registry";
import { useDisabledAdaptersSync } from "../adapters/use-disabled-adapters";
import { useToast } from "../context/ToastContext";
import { useTranslation } from "@/i18n";
import { copyTextToClipboard } from "@/lib/clipboard";

/**
 * Adapter types that are suitable for agent creation (excludes internal
 * system adapters like "process" and "http").
 */
const SYSTEM_ADAPTER_TYPES = new Set(["process", "http"]);

type NewAgentDialogMode = "choices" | "colleague" | "runtime" | "invite" | "prompt";

function isAgentAdapterType(type: string): boolean {
  return !SYSTEM_ADAPTER_TYPES.has(type);
}

export function NewAgentDialog() {
  const { t } = useTranslation();
  const { newAgentOpen, closeNewAgent, openNewIssue } = useDialog();
  const { selectedCompanyId } = useCompany();
  const { pushToast } = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<NewAgentDialogMode>("choices");
  const [agentMessage, setAgentMessage] = useState("");
  const [latestAgentPrompt, setLatestAgentPrompt] = useState<string | null>(null);
  const [latestAgentPromptCopied, setLatestAgentPromptCopied] = useState(false);
  const [colleagueAssigneeId, setColleagueAssigneeId] = useState<string | null>(null);
  const disabledTypes = useDisabledAdaptersSync();

  function resetDialogState() {
    setMode("choices");
    setAgentMessage("");
    setLatestAgentPrompt(null);
    setLatestAgentPromptCopied(false);
    setColleagueAssigneeId(null);
  }

  useEffect(() => {
    if (!latestAgentPromptCopied) return;
    const timeout = window.setTimeout(() => {
      setLatestAgentPromptCopied(false);
    }, 1600);
    return () => window.clearTimeout(timeout);
  }, [latestAgentPromptCopied]);

  // Fetch registered adapters from server (syncs disabled store + provides data)
  const { data: serverAdapters } = useQuery({
    queryKey: queryKeys.adapters.all,
    queryFn: () => adaptersApi.list(),
    staleTime: 5 * 60 * 1000,
  });

  // Fetch existing agents for the "Ask CEO" flow
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && newAgentOpen,
  });

  // The agent this user is paired with. Creating an agent is work like any
  // other, so it goes to your own agent by default — same source as the
  // sidebar's "My Agent" and NewIssueDialog's default assignee, so all three
  // agree. The CEO is only the fallback for a user who has no agent yet.
  const { data: myAgents } = useQuery({
    queryKey: queryKeys.agents.mine(selectedCompanyId!),
    queryFn: () => agentsApi.mine(selectedCompanyId!),
    enabled: !!selectedCompanyId && newAgentOpen,
  });

  const ceoAgent = (agents ?? []).find((a) => a.role === "ceo");
  // Only the agent PAIRED to this user's email counts as "mine". `mine` returns
  // every agent they have joined — for an owner/admin that is most of the
  // company, including built-ins like Wiki Maintainer — so taking [0] would
  // hand the request to whichever system agent happened to sort first.
  const myAgent = (myAgents ?? []).find((a) => a.paired) ?? null;
  const defaultColleagueAssigneeId = myAgent?.id ?? ceoAgent?.id ?? null;
  const effectiveColleagueAssigneeId = colleagueAssigneeId ?? defaultColleagueAssigneeId;
  const assignableAgents = useMemo(
    () => (agents ?? []).map((a) => ({ id: a.id, name: a.name })),
    [agents],
  );
  const inviteHistoryQueryKey = queryKeys.access.invites(selectedCompanyId ?? "", "all", 5);

  // Build the adapter grid from the UI registry merged with display metadata.
  // This automatically includes external/plugin adapters.
  const adapterGrid = useMemo(() => {
    const registered = listUIAdapters()
      .filter((a) =>
        isAgentAdapterType(a.type) &&
        !disabledTypes.has(a.type) &&
        isVisualAdapterChoice(a.type)
      );

    // Sort: recommended first, then alphabetical
    return registered
      .map((a) => {
        const display = getAdapterDisplay(a.type);
        return {
          value: a.type,
          label: display.label,
          desc: display.description,
          icon: display.icon,
          recommended: display.recommended,
          comingSoon: display.comingSoon,
          disabledLabel: display.disabledLabel,
        };
      })
      .sort((a, b) => {
        if (a.recommended && !b.recommended) return -1;
        if (!a.recommended && b.recommended) return 1;
        return a.label.localeCompare(b.label);
      });
  }, [disabledTypes, serverAdapters]);

  function handleAskCeo() {
    closeNewAgent();
    openNewIssue({
      assigneeAgentId: ceoAgent?.id,
      title: t("newAgent.askCeoIssueTitle"),
      description: t("newAgent.askCeoIssueDesc"),
    });
  }

  function handleAddColleague() {
    setMode("colleague");
  }

  /**
   * The six fields go out as a task for an agent rather than straight to
   * POST /agents: setting `assignedUserEmail` is an ownership grant restricted to
   * company owner/admin, and the reporting line has to be derived from the org
   * chart. Handing a structured request to an agent that holds both keeps this
   * button usable by IT without widening who can grant company access.
   *
   * It lands on the requester's own agent unless they pick someone else — an
   * owner/admin/IT user asking their own agent is the common case, and an agent
   * that cannot finish it escalates up the reporting line on its own.
   */
  function handleColleagueSubmit(_draft: unknown, body: string) {
    const assigneeAgentId = effectiveColleagueAssigneeId ?? undefined;
    closeNewAgent();
    resetDialogState();
    openNewIssue({
      assigneeAgentId,
      title: t("newAgent.askCeoIssueTitle"),
      description: body,
    });
  }

  function handleAdvancedConfig() {
    setMode("runtime");
  }

  function handleInviteExternalAgent() {
    setMode("invite");
  }

  function handleAdvancedAdapterPick(adapterType: string) {
    closeNewAgent();
    resetDialogState();
    navigate(`/agents/new?adapterType=${encodeURIComponent(adapterType)}`);
  }

  async function copyText(text: string, unavailableBody: string) {
    try {
      // No capability guard: copyTextToClipboard does its own secure-context
      // detection and falls back to execCommand, throwing only if both fail.
      await copyTextToClipboard(text);
      return true;
    } catch {
      // Fall through to the unavailable message below.
    }

    pushToast({
      title: t("newAgent.clipboardUnavailable"),
      body: unavailableBody,
      tone: "warn",
    });
    return false;
  }

  const createAgentInviteMutation = useMutation({
    mutationFn: () =>
      accessApi.createCompanyInvite(selectedCompanyId!, {
        allowedJoinTypes: "agent",
        humanRole: null,
        agentMessage: agentMessage.trim() || null,
      }),
    onSuccess: async (invite) => {
      const base = window.location.origin.replace(/\/+$/, "");
      const onboardingTextLink =
        invite.onboardingTextUrl ??
        invite.onboardingTextPath ??
        `/api/invites/${invite.token}/onboarding.txt`;
      const onboardingTextUrl = onboardingTextLink.startsWith("http")
        ? onboardingTextLink
        : `${base}${onboardingTextLink}`;

      let prompt: string;
      try {
        const manifest = await accessApi.getInviteOnboarding(invite.token);
        prompt = buildAgentOnboardingPrompt({
          onboardingTextUrl,
          connectionCandidates:
            manifest.onboarding.connectivity?.connectionCandidates ?? null,
          testResolutionUrl:
            manifest.onboarding.connectivity?.testResolutionEndpoint?.url ??
            null,
        });
      } catch {
        prompt = buildAgentOnboardingPrompt({
          onboardingTextUrl,
          connectionCandidates: null,
          testResolutionUrl: null,
        });
      }

      setLatestAgentPrompt(prompt);
      setLatestAgentPromptCopied(false);
      setMode("prompt");
      const copied = await copyText(prompt, t("newAgent.copyManuallyBelow"));

      await queryClient.invalidateQueries({ queryKey: inviteHistoryQueryKey });
      pushToast({
        title: t("newAgent.inviteCreated"),
        body: copied ? t("newAgent.promptReadyCopied") : t("newAgent.promptReady"),
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: t("newAgent.inviteFailed"),
        body: error instanceof Error ? error.message : t("common.unknownError"),
        tone: "error",
      });
    },
  });

  return (
    <Dialog
      open={newAgentOpen}
      onOpenChange={(open) => {
        if (!open) {
          resetDialogState();
          closeNewAgent();
        }
      }}
    >
      <DialogContent
        showCloseButton={false}
        className={cn(
          "max-h-[min(calc(100dvh-2rem),46rem)] p-0 gap-0 overflow-hidden flex flex-col",
          mode === "invite" || mode === "prompt" ? "sm:max-w-2xl" : "sm:max-w-md",
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
          <span className="text-sm text-muted-foreground">{t("newAgent.header")}</span>
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground"
            onClick={() => {
              resetDialogState();
              closeNewAgent();
            }}
          >
            <span className="text-lg leading-none">&times;</span>
          </Button>
        </div>

        <div className="min-h-0 overflow-y-auto p-6 space-y-6">
          {mode === "choices" ? (
            <>
              {/* Recommendation */}
              <div className="text-center space-y-3">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-accent">
                  <Bot className="h-6 w-6 text-foreground" />
                </div>
                <p className="text-sm text-muted-foreground">
                  {t("newAgent.choicesIntro")}
                </p>
              </div>

              <Button className="w-full" size="lg" onClick={handleAskCeo}>
                <Bot className="h-4 w-4 mr-2" />
                {t("newAgent.askCeo")}
              </Button>

              <div className="grid gap-2">
                <Button variant="outline" className="w-full" onClick={handleAddColleague}>
                  <UserRoundPlus className="h-4 w-4 mr-2" />
                  新增同仁代理人
                </Button>
                <Button variant="outline" className="w-full" onClick={handleAdvancedConfig}>
                  <Settings2 className="h-4 w-4 mr-2" />
                  {t("newAgent.configureRuntime")}
                </Button>
                <div className="space-y-1">
                  <Button variant="outline" className="w-full" onClick={handleInviteExternalAgent}>
                    <MailPlus className="h-4 w-4 mr-2" />
                    {t("newAgent.inviteExternal")}
                  </Button>
                  <p className="text-xs text-muted-foreground text-center">
                    {t("newAgent.inviteExternalHint")}
                  </p>
                </div>
              </div>
            </>
          ) : mode === "colleague" ? (
            <>
              <div className="space-y-2">
                <button
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  onClick={() => setMode("choices")}
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  {t("common.back")}
                </button>
                <p className="text-sm text-muted-foreground">
                  填這六欄就好，其餘（指令、技能、權限、回報線）由代理人依組織圖建置。
                </p>
              </div>
              <NewColleagueAgentForm
                onSubmit={handleColleagueSubmit}
                onBack={() => setMode("choices")}
                assignableAgents={assignableAgents}
                assigneeAgentId={effectiveColleagueAssigneeId}
                onAssigneeAgentIdChange={setColleagueAssigneeId}
              />
            </>
          ) : mode === "runtime" ? (
            <>
              <div className="space-y-2">
                <button
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  onClick={() => setMode("choices")}
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  {t("common.back")}
                </button>
                <p className="text-sm text-muted-foreground">
                  {t("newAgent.runtimeIntro")}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-2">
                {adapterGrid.map((opt) => (
                  <button
                    key={opt.value}
                    className={cn(
                      "flex flex-col items-center gap-1.5 rounded-md border border-border p-3 text-xs transition-colors hover:bg-accent/50 relative",
                      opt.comingSoon && "opacity-40 cursor-not-allowed",
                    )}
                    disabled={!!opt.comingSoon}
                    title={opt.comingSoon ? opt.disabledLabel : undefined}
                    onClick={() => {
                      if (!opt.comingSoon) handleAdvancedAdapterPick(opt.value);
                    }}
                  >
                    {opt.recommended && (
                      <span className="absolute -top-1.5 right-1.5 bg-green-500 text-white text-[9px] font-semibold px-1.5 py-0.5 rounded-full leading-none">
                        {t("newAgent.recommended")}
                      </span>
                    )}
                    <opt.icon className="h-4 w-4" />
                    <span className="font-medium">{opt.label}</span>
                    <span className="text-muted-foreground text-[10px]">
                      {opt.desc}
                    </span>
                  </button>
                ))}
              </div>
            </>
          ) : mode === "invite" ? (
            <div className="space-y-5">
              <div className="space-y-2">
                <button
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  onClick={() => setMode("choices")}
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  {t("common.back")}
                </button>
                <div className="space-y-1">
                  <h2 className="text-sm font-semibold">{t("newAgent.inviteExternal")}</h2>
                  <p className="text-sm text-muted-foreground">
                    {t("newAgent.inviteDescription")}
                  </p>
                </div>
              </div>

              <label className="block space-y-2">
                <span className="text-sm font-medium">{t("newAgent.optionalMessage")}</span>
                <Textarea
                  value={agentMessage}
                  onChange={(event) => setAgentMessage(event.target.value)}
                  className="min-h-24 resize-y"
                  placeholder={t("newAgent.messagePlaceholder")}
                  maxLength={4000}
                />
              </label>

              <div className="rounded-lg border border-border px-4 py-3 text-sm text-muted-foreground">
                {t("newAgent.joinRequestNote")}
              </div>

              <div>
                <Button
                  onClick={() => createAgentInviteMutation.mutate()}
                  disabled={!selectedCompanyId || createAgentInviteMutation.isPending}
                >
                  {createAgentInviteMutation.isPending ? t("newAgent.generating") : t("newAgent.generatePrompt")}
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-5">
              <div className="space-y-2">
                <button
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  onClick={() => setMode("invite")}
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  {t("common.back")}
                </button>
                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-3">
                    <h2 className="text-sm font-semibold">{t("newAgent.promptTitle")}</h2>
                    {latestAgentPromptCopied ? (
                      <div className="inline-flex items-center gap-1 text-xs font-medium text-foreground">
                        <Check className="h-3.5 w-3.5" />
                        {t("common.copiedPlain")}
                      </div>
                    ) : null}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {t("newAgent.promptSendHint")}
                  </p>
                </div>
              </div>

              <Textarea
                readOnly
                value={latestAgentPrompt ?? ""}
                className="h-[24rem] resize-y font-mono text-xs"
              />
              <Button
                size="sm"
                variant="outline"
                disabled={!latestAgentPrompt}
                onClick={async () => {
                  if (!latestAgentPrompt) return;
                  const copied = await copyText(latestAgentPrompt, t("newAgent.copyManuallyAbove"));
                  setLatestAgentPromptCopied(copied);
                }}
              >
                {latestAgentPromptCopied ? t("newAgent.copiedPrompt") : t("newAgent.copyPrompt")}
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
