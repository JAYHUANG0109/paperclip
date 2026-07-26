import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "@/i18n";
import type { Project } from "@paperclipai/shared";
import { projectsApi } from "../api/projects";
import { accessApi } from "../api/access";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useDialogActions } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EntityRow } from "../components/EntityRow";
import { ProjectTile } from "../components/ProjectTile";
import { StatusBadge } from "../components/StatusBadge";
import { MembershipAction } from "../components/MembershipAction";
import { StarToggle } from "../components/StarToggle";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { formatDate, formatNumber, formatProjectBudget, projectUrl } from "../lib/utils";
import {
  isStarred,
  resourceMembershipState,
  useResourceMembershipMutation,
  useResourceMemberships,
} from "../hooks/useResourceMemberships";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ArrowUpDown, Check, ChevronRight, Hexagon, Plus } from "lucide-react";
import { Card } from "@/components/ui/card";

type ProjectSortField = "name" | "updated" | "created" | "targetDate";
type ProjectSortDir = "asc" | "desc";

const PROJECT_SORT_OPTIONS: Array<{ field: ProjectSortField; labelKey: string }> = [
  { field: "name", labelKey: "projects.sort.name" },
  { field: "updated", labelKey: "projects.sort.updated" },
  { field: "created", labelKey: "projects.sort.created" },
  { field: "targetDate", labelKey: "projects.sort.targetDate" },
];

function compareProjectNames(left: Project, right: Project) {
  const nameDiff = left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
  return nameDiff !== 0 ? nameDiff : left.id.localeCompare(right.id);
}

function projectTime(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function compareOptionalTime(
  left: Date | string | null | undefined,
  right: Date | string | null | undefined,
  sortDir: ProjectSortDir,
) {
  const leftTime = projectTime(left);
  const rightTime = projectTime(right);
  if (leftTime === null && rightTime === null) return 0;
  if (leftTime === null) return 1;
  if (rightTime === null) return -1;
  return sortDir === "asc" ? leftTime - rightTime : rightTime - leftTime;
}

function sortProjects(projects: Project[], sortField: ProjectSortField, sortDir: ProjectSortDir) {
  return [...projects].sort((left, right) => {
    let comparison = 0;
    if (sortField === "name") {
      comparison = compareProjectNames(left, right);
      return sortDir === "asc" ? comparison : -comparison;
    }

    if (sortField === "updated") comparison = compareOptionalTime(left.updatedAt, right.updatedAt, sortDir);
    else if (sortField === "created") comparison = compareOptionalTime(left.createdAt, right.createdAt, sortDir);
    else comparison = compareOptionalTime(left.targetDate, right.targetDate, sortDir);

    if (comparison === 0) comparison = compareProjectNames(left, right);
    return comparison;
  });
}

export function Projects() {
  const { t } = useTranslation();
  const { selectedCompanyId } = useCompany();
  const { openNewProject } = useDialogActions();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [sortField, setSortField] = useState<ProjectSortField>("name");
  const [sortDir, setSortDir] = useState<ProjectSortDir>("asc");

  useEffect(() => {
    setBreadcrumbs([{ label: t("nav.projects") }]);
  }, [setBreadcrumbs]);

  const { data: allProjects, isLoading, error } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const membershipsQuery = useResourceMemberships(selectedCompanyId);
  const membershipMutation = useResourceMembershipMutation(selectedCompanyId);

  // Resolve owner/shared-member display names for private-project access tags.
  const hasPrivate = useMemo(() => (allProjects ?? []).some((p) => p.visibility === "private"), [allProjects]);
  const { data: userDirectory } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(selectedCompanyId!),
    queryFn: () => accessApi.listUserDirectory(selectedCompanyId!),
    enabled: !!selectedCompanyId && hasPrivate,
  });
  const { data: agentsList } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && hasPrivate,
  });
  const userNameById = useMemo(
    () => new Map((userDirectory?.users ?? []).map((e) => [e.principalId, e.user?.name ?? e.user?.email ?? e.principalId.slice(0, 8)])),
    [userDirectory],
  );
  const agentNameById = useMemo(
    () => new Map((agentsList ?? []).map((a) => [a.id, a.name])),
    [agentsList],
  );
  const privateAccessLabels = (project: Project): string[] => {
    const labels: string[] = [];
    if (project.ownerUserId) labels.push(userNameById.get(project.ownerUserId) ?? project.ownerUserId.slice(0, 8));
    for (const m of project.accessMembers ?? []) {
      const label = m.principalType === "agent" ? agentNameById.get(m.principalId) : userNameById.get(m.principalId);
      if (label && !labels.includes(label)) labels.push(label);
    }
    return labels;
  };

  const projects = useMemo(
    () => (allProjects ?? []).filter((p) => !p.archivedAt),
    [allProjects],
  );
  const sortedProjects = useMemo(
    () => sortProjects(projects, sortField, sortDir),
    [projects, sortDir, sortField],
  );
  // Group by ACCESS SCOPE: 公司 (company/legacy) / 團隊 (team) / 個人 (private).
  // The server already access-filters the list per viewer, so a non-admin only
  // receives projects they may see; admins receive all three scopes.
  const groupedProjects = useMemo(() => {
    const groups = {
      company: [] as typeof sortedProjects,
      team: [] as typeof sortedProjects,
      personal: [] as typeof sortedProjects,
    };
    for (const project of sortedProjects) {
      if (project.visibility === "private") groups.personal.push(project);
      else if (project.visibility === "team") groups.team.push(project);
      else groups.company.push(project);
    }
    return groups;
  }, [sortedProjects]);
  const sortLabel = PROJECT_SORT_OPTIONS.find((option) => option.field === sortField)?.labelKey ?? "projects.sort.name";

  if (!selectedCompanyId) {
    return <EmptyState icon={Hexagon} message={t("projects.selectCompany")} />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="sm" className="w-fit text-xs" title={t("projects.sortTitle")}>
              <ArrowUpDown className="h-3.5 w-3.5 sm:h-3 sm:w-3 sm:mr-1" />
              <span>{t("projects.sortPrefix", { label: t(sortLabel) })}</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-44 p-0">
            <div className="p-2 space-y-0.5">
              {PROJECT_SORT_OPTIONS.map((option) => (
                <button
                  key={option.field}
                  type="button"
                  className={`flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm ${
                    sortField === option.field
                      ? "bg-accent/50 text-foreground"
                      : "text-muted-foreground hover:bg-accent/50"
                  }`}
                  onClick={() => {
                    if (sortField === option.field) {
                      setSortDir((current) => (current === "asc" ? "desc" : "asc"));
                      return;
                    }
                    setSortField(option.field);
                    setSortDir(option.field === "name" || option.field === "targetDate" ? "asc" : "desc");
                  }}
                >
                  <span>{t(option.labelKey)}</span>
                  {sortField === option.field ? (
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Check className="h-3 w-3" />
                      {sortDir === "asc" ? t("projects.asc") : t("projects.desc")}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
        <Button size="sm" variant="outline" onClick={openNewProject}>
          <Plus className="h-4 w-4 mr-1" />
          {t("projects.addProject")}
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {!isLoading && projects.length === 0 && (
        <EmptyState
          icon={Hexagon}
          message={t("projects.empty")}
          action={t("projects.addProject")}
          onAction={openNewProject}
        />
      )}

      {projects.length > 0 && (
        <div className="space-y-6">
          {([
            [t("projects.scopeCompany", { defaultValue: "公司專案" }), groupedProjects.company],
            [t("projects.scopeTeam", { defaultValue: "團隊專案" }), groupedProjects.team],
            [t("projects.scopePersonal", { defaultValue: "個人專案" }), groupedProjects.personal],
          ] as const).map(([label, sectionProjects]) => {
            if (sectionProjects.length === 0) return null;

            return (
              <details key={label} className="group space-y-2">
                <summary className="flex cursor-pointer select-none items-center justify-between rounded-md px-1 py-1 hover:bg-accent/40">
                  <span className="flex items-center gap-1.5">
                    <ChevronRight className="h-3.5 w-3.5 text-muted-foreground transition-transform group-open:rotate-90" />
                    <h2 className="text-sm font-medium">{label}</h2>
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {t("projects.projectCount", { count: sectionProjects.length })}
                  </span>
                </summary>
                <Card className="block py-0 overflow-hidden divide-y divide-border">
                  {sectionProjects.map((project) => {
                    const state = resourceMembershipState(membershipsQuery.data, "project", project.id);
                    const pending = membershipMutation.isPending &&
                      membershipMutation.variables?.resourceType === "project" &&
                      membershipMutation.variables.resourceId === project.id;
                    const starPending = pending && membershipMutation.variables?.starred !== undefined;
                    const joinLeavePending = pending && membershipMutation.variables?.starred === undefined;
                    const starred = isStarred(membershipsQuery.data, "project", project.id);
                    return (
                      <EntityRow
                        key={project.id}
                        leading={<ProjectTile color={project.color ?? null} icon={project.icon ?? null} size="sm" />}
                        title={project.name}
                        subtitle={project.description ?? undefined}
                        reserveSubtitleSpace
                        to={projectUrl(project)}
                        className={state === "left" ? "group text-foreground/55" : "group"}
                        trailing={
                          <div className="flex items-center gap-3">
                            {project.visibility === "team" && (project.teams?.length || project.team) ? (
                              (() => {
                                const label = project.teams?.length ? project.teams.join("、") : project.team!;
                                return (
                                  <span className="hidden max-w-[10rem] truncate rounded-full border border-border bg-accent/40 px-2 py-0.5 text-[11px] text-muted-foreground sm:inline" title={label}>
                                    {label}
                                  </span>
                                );
                              })()
                            ) : project.visibility === "private" ? (
                              (() => {
                                const labels = privateAccessLabels(project);
                                const shown = labels.slice(0, 2);
                                const extra = labels.length - shown.length;
                                const full = labels.length > 0
                                  ? `${t("projects.scopePrivateTag", { defaultValue: "私人" })} · ${labels.join("、")}`
                                  : t("projects.scopePrivateTag", { defaultValue: "私人" });
                                return (
                                  <span className="hidden max-w-[16rem] truncate rounded-full border border-border bg-accent/40 px-2 py-0.5 text-[11px] text-muted-foreground sm:inline" title={full}>
                                    {t("projects.scopePrivateTag", { defaultValue: "私人" })}
                                    {shown.length > 0 ? ` · ${shown.join("、")}` : ""}
                                    {extra > 0 ? ` +${extra}` : ""}
                                  </span>
                                );
                              })()
                            ) : null}
                            <span
                              className="hidden text-xs text-muted-foreground tabular-nums sm:inline"
                              title={`${formatNumber(project.taskCount ?? 0)} task${(project.taskCount ?? 0) === 1 ? "" : "s"}`}
                            >
                              {formatNumber(project.taskCount ?? 0)} task{(project.taskCount ?? 0) === 1 ? "" : "s"}
                            </span>
                            {project.budget && (
                              <span className="hidden text-xs text-muted-foreground tabular-nums sm:inline">
                                {formatProjectBudget(project.budget)}
                              </span>
                            )}
                            {project.targetDate && (
                              <span className="hidden text-xs text-muted-foreground md:inline">
                                {formatDate(project.targetDate)}
                              </span>
                            )}
                            <StatusBadge status={project.status} />
                            <MembershipAction
                              state={state}
                              pending={joinLeavePending}
                              pendingState={joinLeavePending ? membershipMutation.variables?.state : null}
                              resourceName={project.name}
                              onJoin={() => membershipMutation.mutate({
                                resourceType: "project",
                                resourceId: project.id,
                                resourceName: project.name,
                                state: "joined",
                              })}
                              onLeave={() => membershipMutation.mutate({
                                resourceType: "project",
                                resourceId: project.id,
                                resourceName: project.name,
                                state: "left",
                              })}
                            />
                            <StarToggle
                              size="row"
                              starred={starred}
                              pending={starPending}
                              resourceName={project.name}
                              onToggle={(next) => membershipMutation.mutate({
                                resourceType: "project",
                                resourceId: project.id,
                                resourceName: project.name,
                                starred: next,
                              })}
                            />
                          </div>
                        }
                      />
                    );
                  })}
                </Card>
              </details>
            );
          })}
        </div>
      )}
    </div>
  );
}
