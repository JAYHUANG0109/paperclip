import { useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { accessApi } from "../api/access";
import { projectsApi } from "../api/projects";
import { agentsApi } from "../api/agents";
import { companySkillsApi } from "../api/companySkills";
import { projectMembersApi } from "../api/project-members";
import { goalsApi } from "../api/goals";
import { assetsApi } from "../api/assets";
import { buildMarkdownMentionOptions } from "../lib/company-members";
import { queryKeys } from "../lib/queryKeys";
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Maximize2,
  Minimize2,
  Target,
  Calendar,
  Plus,
  X,
  HelpCircle,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "../lib/utils";
import { MarkdownEditor, type MarkdownEditorRef, type MentionOption } from "./MarkdownEditor";
import { StatusBadge } from "./StatusBadge";
import { ChoosePathButton } from "./PathInstructionsModal";
import { useTranslation } from "@/i18n";

const projectStatuses = [
  { value: "backlog", labelKey: "newProject.status.backlog" },
  { value: "planned", labelKey: "newProject.status.planned" },
  { value: "in_progress", labelKey: "newProject.status.inProgress" },
  { value: "completed", labelKey: "newProject.status.completed" },
  { value: "cancelled", labelKey: "newProject.status.cancelled" },
];

export function NewProjectDialog() {
  const { t } = useTranslation();
  const { newProjectOpen, closeNewProject } = useDialog();
  const { selectedCompanyId, selectedCompany } = useCompany();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState("planned");
  const [goalIds, setGoalIds] = useState<string[]>([]);
  const [targetDate, setTargetDate] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [workspaceLocalPath, setWorkspaceLocalPath] = useState("");
  const [workspaceRepoUrl, setWorkspaceRepoUrl] = useState("");
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);

  const [statusOpen, setStatusOpen] = useState(false);
  const [goalOpen, setGoalOpen] = useState(false);
  // Access scope: company (all), team (a chosen team), private (owner + shared).
  const [visibility, setVisibility] = useState<"company" | "team" | "private">("company");
  const [team, setTeam] = useState<string | null>(null);
  const [scopeOpen, setScopeOpen] = useState(false);
  // Private-scope: extra principals granted access (none = just the creator).
  const [sharedPrincipals, setSharedPrincipals] = useState<Array<{ type: "user" | "agent"; id: string; label: string }>>([]);
  const [shareOpen, setShareOpen] = useState(false);
  const descriptionEditorRef = useRef<MarkdownEditorRef>(null);

  const { data: shareableTeams } = useQuery({
    queryKey: ["shareable-teams", selectedCompanyId],
    queryFn: () => companySkillsApi.shareableTeams(selectedCompanyId!),
    enabled: !!selectedCompanyId && newProjectOpen,
  });

  const { data: goals } = useQuery({
    queryKey: queryKeys.goals.list(selectedCompanyId!),
    queryFn: () => goalsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && newProjectOpen,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && newProjectOpen,
  });

  const { data: companyMembers } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(selectedCompanyId!),
    queryFn: () => accessApi.listUserDirectory(selectedCompanyId!),
    enabled: !!selectedCompanyId && newProjectOpen,
  });

  const mentionOptions = useMemo<MentionOption[]>(() => {
    return buildMarkdownMentionOptions({
      agents,
      members: companyMembers?.users,
    });
  }, [agents, companyMembers?.users]);

  const createProject = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      projectsApi.create(selectedCompanyId!, data),
  });

  const uploadDescriptionImage = useMutation({
    mutationFn: async (file: File) => {
      if (!selectedCompanyId) throw new Error("No company selected");
      return assetsApi.uploadImage(selectedCompanyId, file, "projects/drafts");
    },
  });

  function reset() {
    setName("");
    setDescription("");
    setStatus("planned");
    setGoalIds([]);
    setTargetDate("");
    setExpanded(false);
    setWorkspaceLocalPath("");
    setWorkspaceRepoUrl("");
    setWorkspaceError(null);
    setVisibility("company");
    setTeam(null);
    setSharedPrincipals([]);
  }

  const isAbsolutePath = (value: string) => value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);

  const looksLikeRepoUrl = (value: string) => {
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== "https:") return false;
      const segments = parsed.pathname.split("/").filter(Boolean);
      return segments.length >= 2;
    } catch {
      return false;
    }
  };

  const deriveWorkspaceNameFromPath = (value: string) => {
    const normalized = value.trim().replace(/[\\/]+$/, "");
    const segments = normalized.split(/[\\/]/).filter(Boolean);
    return segments[segments.length - 1] ?? t("newProject.localFolderFallback");
  };

  const deriveWorkspaceNameFromRepo = (value: string) => {
    try {
      const parsed = new URL(value);
      const segments = parsed.pathname.split("/").filter(Boolean);
      const repo = segments[segments.length - 1]?.replace(/\.git$/i, "") ?? "";
      return repo || t("newProject.githubRepoFallback");
    } catch {
      return t("newProject.githubRepoFallback");
    }
  };

  async function handleSubmit() {
    if (!selectedCompanyId || !name.trim()) return;
    const localPath = workspaceLocalPath.trim();
    const repoUrl = workspaceRepoUrl.trim();

    if (localPath && !isAbsolutePath(localPath)) {
      setWorkspaceError(t("newProject.errorAbsolutePath"));
      return;
    }
    if (repoUrl && !looksLikeRepoUrl(repoUrl)) {
      setWorkspaceError(t("newProject.errorRepoUrl"));
      return;
    }

    setWorkspaceError(null);

    try {
      const created = await createProject.mutateAsync({
        name: name.trim(),
        description: description.trim() || undefined,
        status,
        // No color is sent — new projects persist color = null (neutral gray). See PAP-68.
        visibility,
        ...(visibility === "team" && team ? { team } : {}),
        ...(goalIds.length > 0 ? { goalIds } : {}),
        ...(targetDate ? { targetDate } : {}),
      });

      // Private scope: grant the picked users/agents access (owner already implicit).
      if (visibility === "private" && sharedPrincipals.length > 0) {
        await Promise.all(sharedPrincipals.map((p) =>
          projectMembersApi.add(created.id, { principalType: p.type, principalId: p.id, projectRole: "editor" }).catch(() => null),
        ));
      }

      if (localPath || repoUrl) {
        const workspacePayload: Record<string, unknown> = {
          name: localPath
            ? deriveWorkspaceNameFromPath(localPath)
            : deriveWorkspaceNameFromRepo(repoUrl),
          ...(localPath ? { cwd: localPath } : {}),
          ...(repoUrl ? { repoUrl } : {}),
        };
        await projectsApi.createWorkspace(created.id, workspacePayload);
      }

      queryClient.invalidateQueries({ queryKey: queryKeys.projects.list(selectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(created.id) });
      reset();
      closeNewProject();
    } catch {
      // surface through createProject.isError
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
  }

  const selectedGoals = (goals ?? []).filter((g) => goalIds.includes(g.id));
  const availableGoals = (goals ?? []).filter((g) => !goalIds.includes(g.id));

  return (
    <Dialog
      open={newProjectOpen}
      onOpenChange={(open) => {
        if (!open) {
          reset();
          closeNewProject();
        }
      }}
    >
      <DialogContent
        showCloseButton={false}
        className={cn("p-0 gap-0", expanded ? "sm:max-w-2xl" : "sm:max-w-lg")}
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            {selectedCompany && (
              <span className="bg-muted px-1.5 py-0.5 rounded text-xs font-medium">
                {selectedCompany.name.slice(0, 3).toUpperCase()}
              </span>
            )}
            <span className="text-muted-foreground/60">&rsaquo;</span>
            <span>{t("newProject.title")}</span>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground"
              onClick={() => { reset(); closeNewProject(); }}
            >
              <span className="text-lg leading-none">&times;</span>
            </Button>
          </div>
        </div>

        {/* Name */}
        <div className="px-4 pt-4 pb-2 shrink-0">
          <input
            className="w-full text-lg font-semibold bg-transparent outline-none placeholder:text-muted-foreground/50"
            placeholder={t("newProject.namePlaceholder")}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Tab" && !e.shiftKey) {
                e.preventDefault();
                descriptionEditorRef.current?.focus();
              }
            }}
            autoFocus
          />
        </div>

        {/* Description */}
        <div className="px-4 pb-2">
          <MarkdownEditor
            ref={descriptionEditorRef}
            value={description}
            onChange={setDescription}
            placeholder={t("newProject.descriptionPlaceholder")}
            bordered={false}
            mentions={mentionOptions}
            contentClassName={cn("text-sm text-muted-foreground", expanded ? "min-h-[220px]" : "min-h-[120px]")}
            imageUploadHandler={async (file) => {
              const asset = await uploadDescriptionImage.mutateAsync(file);
              return asset.contentPath;
            }}
          />
        </div>

        <div className="px-4 pt-3 pb-3 space-y-3 border-t border-border">
          <div>
            <div className="mb-1 flex items-center gap-1.5">
              <label className="block text-xs text-muted-foreground">{t("newProject.repoUrl")}</label>
              <span className="text-xs text-muted-foreground/50">{t("newProject.optional")}</span>
              <Tooltip delayDuration={300}>
                <TooltipTrigger asChild>
                  <HelpCircle className="h-3 w-3 text-muted-foreground/50 cursor-help" />
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-[240px] text-xs">
                  {t("newProject.repoUrlTooltip")}
                </TooltipContent>
              </Tooltip>
            </div>
            <input
              className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs outline-none"
              value={workspaceRepoUrl}
              onChange={(e) => { setWorkspaceRepoUrl(e.target.value); setWorkspaceError(null); }}
              placeholder="https://github.com/org/repo"
            />
          </div>

          <div>
            <div className="mb-1 flex items-center gap-1.5">
              <label className="block text-xs text-muted-foreground">{t("newProject.localFolder")}</label>
              <span className="text-xs text-muted-foreground/50">{t("newProject.optional")}</span>
              <Tooltip delayDuration={300}>
                <TooltipTrigger asChild>
                  <HelpCircle className="h-3 w-3 text-muted-foreground/50 cursor-help" />
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-[240px] text-xs">
                  {t("newProject.localFolderTooltip")}
                </TooltipContent>
              </Tooltip>
            </div>
            <div className="flex items-center gap-2">
              <input
                className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs font-mono outline-none"
                value={workspaceLocalPath}
                onChange={(e) => { setWorkspaceLocalPath(e.target.value); setWorkspaceError(null); }}
                placeholder="/absolute/path/to/workspace"
              />
              <ChoosePathButton />
            </div>
          </div>

          {workspaceError && (
            <p className="text-xs text-destructive">{workspaceError}</p>
          )}
        </div>

        {/* Property chips */}
        <div className="flex items-center gap-1.5 px-4 py-2 border-t border-border flex-wrap">
          {/* Status */}
          <Popover open={statusOpen} onOpenChange={setStatusOpen}>
            <PopoverTrigger asChild>
              <button className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/50 transition-colors">
                <StatusBadge status={status} />
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-40 p-1" align="start">
              {projectStatuses.map((s) => (
                <button
                  key={s.value}
                  className={cn(
                    "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
                    s.value === status && "bg-accent"
                  )}
                  onClick={() => { setStatus(s.value); setStatusOpen(false); }}
                >
                  {t(s.labelKey)}
                </button>
              ))}
            </PopoverContent>
          </Popover>

          {/* Access scope: 公司 / 團隊(pick one) / 私人 */}
          <Popover open={scopeOpen} onOpenChange={setScopeOpen}>
            <PopoverTrigger asChild>
              <button className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/50 transition-colors">
                {visibility === "team"
                  ? t("newProject.scopeTeamWith", { defaultValue: "團隊：{{team}}", team: team ?? "—" })
                  : visibility === "private"
                    ? t("projects.scopePersonal", { defaultValue: "個人專案" })
                    : t("projects.scopeCompany", { defaultValue: "公司專案" })}
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-56 p-1" align="start">
              <button
                className={cn("flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-accent/50", visibility === "company" && "bg-accent")}
                onClick={() => { setVisibility("company"); setTeam(null); setScopeOpen(false); }}
              >
                {t("projects.scopeCompany", { defaultValue: "公司專案" })}
                <span className="ml-auto text-[11px] text-muted-foreground">{t("newProject.scopeCompanyHint", { defaultValue: "全公司可見" })}</span>
              </button>
              <button
                className={cn("flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-accent/50", visibility === "private" && "bg-accent")}
                onClick={() => { setVisibility("private"); setTeam(null); setScopeOpen(false); }}
              >
                {t("projects.scopePersonal", { defaultValue: "個人專案" })}
                <span className="ml-auto text-[11px] text-muted-foreground">{t("newProject.scopePrivateHint", { defaultValue: "只有你與受邀者" })}</span>
              </button>
              <div className="my-1 border-t border-border" />
              <div className="px-2 py-1 text-[11px] font-medium text-muted-foreground">{t("newProject.scopeTeamPick", { defaultValue: "團隊專案（選一個團隊）" })}</div>
              <div className="max-h-40 overflow-y-auto">
                {(shareableTeams?.teams ?? []).length === 0 ? (
                  <div className="px-2 py-1.5 text-[11px] text-muted-foreground">{t("newProject.noTeams", { defaultValue: "沒有可分享的團隊" })}</div>
                ) : (
                  (shareableTeams?.teams ?? []).map((tm) => (
                    <button
                      key={tm}
                      className={cn("flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-accent/50", visibility === "team" && team === tm && "bg-accent")}
                      onClick={() => { setVisibility("team"); setTeam(tm); setScopeOpen(false); }}
                    >
                      <span className="truncate">{tm}</span>
                    </button>
                  ))
                )}
              </div>
            </PopoverContent>
          </Popover>

          {/* Private scope: pick users/agents to also grant access (none = just you). */}
          {visibility === "private" && (
            <Popover open={shareOpen} onOpenChange={setShareOpen}>
              <PopoverTrigger asChild>
                <button className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/50 transition-colors">
                  {sharedPrincipals.length > 0
                    ? t("newProject.sharedWithCount", { defaultValue: "分享給 {{count}} 人", count: sharedPrincipals.length })
                    : t("newProject.shareWith", { defaultValue: "分享給…（預設只有你）" })}
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-64 p-1" align="start">
                <div className="max-h-56 overflow-y-auto">
                  <div className="px-2 py-1 text-[11px] font-medium text-muted-foreground">{t("newProject.people", { defaultValue: "成員" })}</div>
                  {(companyMembers?.users ?? []).map((u) => {
                    const id = u.user?.id ?? u.principalId;
                    const on = sharedPrincipals.some((p) => p.type === "user" && p.id === id);
                    const label = u.user?.name ?? u.user?.email ?? id;
                    return (
                      <button key={`u:${id}`} className={cn("flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-accent/50", on && "bg-accent")}
                        onClick={() => setSharedPrincipals((cur) => on ? cur.filter((p) => !(p.type === "user" && p.id === id)) : [...cur, { type: "user", id, label }])}>
                        <input type="checkbox" checked={on} readOnly className="pointer-events-none" />
                        <span className="truncate">{label}</span>
                      </button>
                    );
                  })}
                  <div className="mt-1 border-t border-border px-2 py-1 text-[11px] font-medium text-muted-foreground">{t("newProject.agents", { defaultValue: "代理人" })}</div>
                  {(agents ?? []).map((a) => {
                    const id = a.id;
                    const on = sharedPrincipals.some((p) => p.type === "agent" && p.id === id);
                    return (
                      <button key={`a:${id}`} className={cn("flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-accent/50", on && "bg-accent")}
                        onClick={() => setSharedPrincipals((cur) => on ? cur.filter((p) => !(p.type === "agent" && p.id === id)) : [...cur, { type: "agent", id, label: a.name }])}>
                        <input type="checkbox" checked={on} readOnly className="pointer-events-none" />
                        <span className="truncate">{a.name}</span>
                      </button>
                    );
                  })}
                </div>
              </PopoverContent>
            </Popover>
          )}

          {selectedGoals.map((goal) => (
            <span
              key={goal.id}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs"
            >
              <Target className="h-3 w-3 text-muted-foreground" />
              <span className="max-w-[160px] truncate">{goal.title}</span>
              <button
                className="text-muted-foreground hover:text-foreground"
                onClick={() => setGoalIds((prev) => prev.filter((id) => id !== goal.id))}
                aria-label={t("newProject.removeGoal", { title: goal.title })}
                type="button"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}

          <Popover open={goalOpen} onOpenChange={setGoalOpen}>
            <PopoverTrigger asChild>
              <button
                className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/50 transition-colors disabled:opacity-60"
                disabled={selectedGoals.length > 0 && availableGoals.length === 0}
              >
                {selectedGoals.length > 0 ? <Plus className="h-3 w-3 text-muted-foreground" /> : <Target className="h-3 w-3 text-muted-foreground" />}
                {selectedGoals.length > 0 ? t("newProject.addGoal") : t("newProject.goal")}
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-56 p-1" align="start">
              {selectedGoals.length === 0 && (
                <button
                  className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 text-muted-foreground"
                  onClick={() => setGoalOpen(false)}
                >
                  {t("newProject.noGoal")}
                </button>
              )}
              {availableGoals.map((g) => (
                <button
                  key={g.id}
                  className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 truncate"
                  onClick={() => {
                    setGoalIds((prev) => [...prev, g.id]);
                    setGoalOpen(false);
                  }}
                >
                  {g.title}
                </button>
              ))}
              {selectedGoals.length > 0 && availableGoals.length === 0 && (
                <div className="px-2 py-1.5 text-xs text-muted-foreground">
                  {t("newProject.allGoalsSelected")}
                </div>
              )}
            </PopoverContent>
          </Popover>

          {/* Target date */}
          <div className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs">
            <Calendar className="h-3 w-3 text-muted-foreground" />
            <input
              type="date"
              className="bg-transparent outline-none text-xs w-24"
              value={targetDate}
              onChange={(e) => setTargetDate(e.target.value)}
              placeholder={t("newProject.targetDate")}
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-2.5 border-t border-border">
          {createProject.isError ? (
            <p className="text-xs text-destructive">{t("newProject.failedToCreate")}</p>
          ) : (
            <span />
          )}
          <Button
            size="sm"
            disabled={!name.trim() || createProject.isPending}
            onClick={handleSubmit}
          >
            {createProject.isPending ? t("common.creating") : t("newProject.createProject")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
