import { useState, useMemo, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "@/i18n";
import { projectMembersApi, type ProjectMemberRole } from "../api/project-members";
import { agentsApi } from "../api/agents";
import { accessApi, type CompanyUserDirectoryEntry } from "../api/access";
import { companySkillsApi } from "../api/companySkills";
import { queryKeys } from "../lib/queryKeys";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Users, ChevronDown, X, Plus, Lock, Globe } from "lucide-react";
import { cn } from "../lib/utils";

export type ProjectVisibility = "company" | "team" | "private";
export interface ProjectScopePatch {
  visibility?: ProjectVisibility;
  teams?: string[];
  team?: string | null;
}

const ROLE_LABELS: Record<ProjectMemberRole, string> = {
  admin: "管理員 Admin",
  editor: "編輯 Editor",
  commenter: "留言 Commenter",
  viewer: "檢視 Viewer",
};

const ROLE_DESC: Record<ProjectMemberRole, string> = {
  admin: "可管理成員與設定",
  editor: "可編輯任務與欄位",
  commenter: "可留言，不可編輯",
  viewer: "僅可檢視",
};

interface Props {
  projectId: string;
  companyId: string;
  /** Whether the viewer can manage members (owner/admin only) */
  canManage: boolean;
  /** Current project visibility */
  visibility: ProjectVisibility;
  /** Team labels a team-scoped project targets (multi-team). */
  teams?: string[] | null;
  /** Legacy single team label (fallback). */
  team?: string | null;
  /** The project owner (user principalId) — always retains access to private projects. */
  ownerUserId?: string | null;
  onScopeChange: (patch: ProjectScopePatch) => void;
}

export function ProjectMembersPanel({ projectId, companyId, canManage, visibility, teams, team, ownerUserId, onScopeChange }: Props) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const key = ["project-members", projectId];
  const effectiveTeams = useMemo(() => (teams && teams.length > 0 ? teams : team ? [team] : []), [teams, team]);
  const [scopeOpen, setScopeOpen] = useState(false);

  const { data: shareableTeams } = useQuery({
    queryKey: ["shareable-teams", companyId],
    queryFn: () => companySkillsApi.shareableTeams(companyId),
    enabled: !!companyId && canManage,
  });

  const { data: members } = useQuery({
    queryKey: key,
    queryFn: () => projectMembersApi.list(projectId),
    enabled: !!projectId,
  });
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: !!companyId && canManage,
  });
  const { data: userDirectory } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(companyId),
    queryFn: () => accessApi.listUserDirectory(companyId),
    enabled: !!companyId && canManage,
  });

  const agentById = useMemo(() => new Map((agents ?? []).map((a) => [a.id, a])), [agents]);
  const userById = useMemo(() => new Map((userDirectory?.users ?? []).map((e: CompanyUserDirectoryEntry) => [e.principalId, e.user])), [userDirectory]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: key });

  const remove = useMutation({
    mutationFn: ({ principalType, principalId }: { principalType: string; principalId: string }) =>
      projectMembersApi.remove(projectId, principalType, principalId),
    onSuccess: invalidate,
  });

  const updateRole = useMutation({
    mutationFn: ({ principalType, principalId, role }: { principalType: string; principalId: string; role: ProjectMemberRole }) =>
      projectMembersApi.update(projectId, principalType, principalId, role),
    onSuccess: invalidate,
  });

  const add = useMutation({
    mutationFn: (data: { principalType: "user" | "agent"; principalId: string; projectRole?: ProjectMemberRole }) =>
      projectMembersApi.add(projectId, data),
    onSuccess: invalidate,
  });

  const [addOpen, setAddOpen] = useState(false);
  const [addSearch, setAddSearch] = useState("");

  const search = addSearch.trim().toLowerCase();
  const existingIds = new Set(members?.map((m) => m.principalId) ?? []);

  // agent -> owner userId, from each directory user's joined agents.
  const agentOwnerUserId = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of userDirectory?.users ?? []) for (const a of e.agents ?? []) m.set(a.id, e.principalId);
    return m;
  }, [userDirectory]);

  const userLabelById = (uid: string) => {
    const u = userById.get(uid);
    return u?.name ?? u?.email ?? uid.slice(0, 8);
  };

  type Mem = NonNullable<typeof members>[number];
  // Group existing members by person (their user + their agents). Agents whose owner
  // isn't a known directory user fall into a standalone "other agents" bucket.
  const memberGroups = useMemo(() => {
    const byUser = new Map<string, { userId: string; label: string; userMember?: Mem; agentMembers: Mem[] }>();
    const orphanAgents: Mem[] = [];
    const ensure = (uid: string) => {
      let g = byUser.get(uid);
      if (!g) { g = { userId: uid, label: userLabelById(uid), agentMembers: [] }; byUser.set(uid, g); }
      return g;
    };
    for (const m of members ?? []) {
      if (m.principalType === "user") ensure(m.principalId).userMember = m;
      else {
        const owner = agentOwnerUserId.get(m.principalId);
        if (owner) ensure(owner).agentMembers.push(m);
        else orphanAgents.push(m);
      }
    }
    return { groups: [...byUser.values()], orphanAgents };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [members, agentOwnerUserId, userById, agentById]);

  // Picker: people (with their agents) + agents that have no known owner.
  const peopleCandidates = (userDirectory?.users ?? []).filter((e) => {
    if (!search) return true;
    const label = (e.user?.name ?? e.user?.email ?? "").toLowerCase();
    return label.includes(search) || (e.agents ?? []).some((a) => a.name.toLowerCase().includes(search));
  });
  const ownedAgentIds = new Set(agentOwnerUserId.keys());
  const orphanAgentCandidates = (agents ?? []).filter(
    (a) => !ownedAgentIds.has(a.id) && (!search || a.name.toLowerCase().includes(search)),
  );

  const addOne = (principalType: "user" | "agent", principalId: string) => {
    if (!existingIds.has(principalId)) add.mutate({ principalType, principalId, projectRole: "editor" });
  };

  const renderMemberRow = (m: Mem, actorLabel: string) => (
    <div key={m.id} className="flex items-center gap-2 px-2 py-1 hover:bg-accent/30">
      <span className="flex-1 truncate text-[13px] text-muted-foreground">{actorLabel}</span>
      <span className="text-[11px] text-muted-foreground">{m.principalType === "agent" ? "Agent" : "User"}</span>
      {canManage ? (
        <RolePicker
          value={m.projectRole as ProjectMemberRole}
          onChange={(role) => updateRole.mutate({ principalType: m.principalType, principalId: m.principalId, role })}
        />
      ) : (
        <span className="text-[12px] text-muted-foreground">{ROLE_LABELS[m.projectRole as ProjectMemberRole]?.split(" ")[0]}</span>
      )}
      {canManage && (
        <button
          type="button"
          onClick={() => remove.mutate({ principalType: m.principalType, principalId: m.principalId })}
          className="text-muted-foreground hover:text-destructive"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );

  return (
    <div className="rounded-lg border border-border p-4 space-y-4">
      {/* Scope selector: 公司 / 團隊 / 私人 */}
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 items-center gap-1.5">
          {visibility === "private" ? <Lock className="h-4 w-4 text-muted-foreground" /> : visibility === "team" ? <Users className="h-4 w-4 text-muted-foreground" /> : <Globe className="h-4 w-4 text-muted-foreground" />}
          <span className="truncate text-sm font-medium">
            {visibility === "private"
              ? t("projectMembers.private", { defaultValue: "私密專案 Private" })
              : visibility === "team"
                ? t("projectMembers.team", { defaultValue: "團隊專案：{{teams}}", teams: effectiveTeams.length > 0 ? effectiveTeams.join("、") : "—" })
                : t("projectMembers.company", { defaultValue: "全公司可見 Company" })}
          </span>
        </div>
        {canManage && (
          <Popover open={scopeOpen} onOpenChange={setScopeOpen}>
            <PopoverTrigger asChild>
              <button type="button" className="ml-auto shrink-0 rounded border border-border px-2 py-0.5 text-[12px] text-muted-foreground transition-colors hover:text-foreground">
                {t("projectMembers.changeScope", { defaultValue: "變更範圍" })}
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-60 p-1" align="end">
              <button
                className={cn("flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-accent/50", visibility === "company" && "bg-accent")}
                onClick={() => { onScopeChange({ visibility: "company", teams: [], team: null }); setScopeOpen(false); }}
              >
                <Globe className="h-3.5 w-3.5" />{t("projects.scopeCompany", { defaultValue: "公司專案" })}
                <span className="ml-auto text-[11px] text-muted-foreground">{t("newProject.scopeCompanyHint", { defaultValue: "全公司可見" })}</span>
              </button>
              <button
                className={cn("flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-accent/50", visibility === "private" && "bg-accent")}
                onClick={() => { onScopeChange({ visibility: "private", teams: [], team: null }); setScopeOpen(false); }}
              >
                <Lock className="h-3.5 w-3.5" />{t("projects.scopePersonal", { defaultValue: "個人專案" })}
                <span className="ml-auto text-[11px] text-muted-foreground">{t("newProject.scopePrivateHint", { defaultValue: "只有你與受邀者" })}</span>
              </button>
              <div className="my-1 border-t border-border" />
              <div className="px-2 py-1 text-[11px] font-medium text-muted-foreground">{t("newProject.scopeTeamPick", { defaultValue: "團隊專案（可選多個團隊）" })}</div>
              <div className="max-h-40 overflow-y-auto overscroll-contain" onWheel={(e) => { e.currentTarget.scrollTop += e.deltaY; }}>
                {(shareableTeams?.teams ?? []).length === 0 ? (
                  <div className="px-2 py-1.5 text-[11px] text-muted-foreground">{t("newProject.noTeams", { defaultValue: "沒有可分享的團隊" })}</div>
                ) : (
                  (shareableTeams?.teams ?? []).map((tm) => {
                    const on = effectiveTeams.includes(tm);
                    return (
                      <button
                        key={tm}
                        className={cn("flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-accent/50", on && "bg-accent")}
                        onClick={() => {
                          const next = on ? effectiveTeams.filter((x) => x !== tm) : [...effectiveTeams, tm];
                          onScopeChange({ visibility: next.length > 0 ? "team" : "company", teams: next, team: next[0] ?? null });
                        }}
                      >
                        <input type="checkbox" checked={on} readOnly className="pointer-events-none" />
                        <span className="truncate">{tm}</span>
                      </button>
                    );
                  })
                )}
              </div>
            </PopoverContent>
          </Popover>
        )}
      </div>

      {/* Team tags */}
      {visibility === "team" && effectiveTeams.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {effectiveTeams.map((tm) => (
            <span key={tm} className="rounded-full border border-border bg-accent/40 px-2 py-0.5 text-[11px] text-muted-foreground">{tm}</span>
          ))}
        </div>
      )}

      {/* Members list */}
      <div>
        <div className="mb-2 flex items-center gap-2">
          <Users className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">
            {t("projectMembers.members", { defaultValue: "專案成員 Members" })}
          </span>
          <span className="ml-1 text-[12px] text-muted-foreground">({members?.length ?? 0})</span>
        </div>

        {/* Owner — always retains access on private projects. */}
        {ownerUserId && visibility !== "company" && (
          <div className="mb-1 flex items-center gap-2 rounded px-2 py-1">
            <span className="flex-1 truncate text-[13px]">{userById.get(ownerUserId)?.name ?? userById.get(ownerUserId)?.email ?? ownerUserId.slice(0, 8)}</span>
            <span className="rounded-full border border-border bg-accent/40 px-2 py-0.5 text-[11px] text-muted-foreground">{t("projectMembers.owner", { defaultValue: "負責人" })}</span>
          </div>
        )}

        {members?.length === 0 && (
          <p className="text-[13px] text-muted-foreground">
            {visibility === "company"
              ? t("projectMembers.everyoneAccess", { defaultValue: "全公司成員均可存取" })
              : visibility === "team"
                ? t("projectMembers.teamAccess", { defaultValue: "所屬團隊成員均可存取；可另外加入個別成員。" })
                : t("projectMembers.noMembers", { defaultValue: "尚無其他成員。私密專案僅負責人與受邀者可存取。" })}
          </p>
        )}

        {/* Members grouped by person: their user account + their agent(s). */}
        <div className="space-y-2">
          {memberGroups.groups.map((g) => (
            <div key={g.userId} className="overflow-hidden rounded border border-border/60">
              <div className="bg-muted/30 px-2 py-1 text-[12px] font-medium">{g.label}</div>
              <div className="divide-y divide-border/60">
                {g.userMember && renderMemberRow(g.userMember, t("projectMembers.userAccount", { defaultValue: "使用者帳號" }))}
                {g.agentMembers.map((am) => renderMemberRow(am, agentById.get(am.principalId)?.name ?? t("projectMembers.agent", { defaultValue: "代理人" })))}
              </div>
            </div>
          ))}
          {memberGroups.orphanAgents.length > 0 && (
            <div className="overflow-hidden rounded border border-border/60">
              <div className="bg-muted/30 px-2 py-1 text-[12px] font-medium text-muted-foreground">{t("projectMembers.otherAgents", { defaultValue: "其他代理人" })}</div>
              <div className="divide-y divide-border/60">
                {memberGroups.orphanAgents.map((am) => renderMemberRow(am, agentById.get(am.principalId)?.name ?? t("projectMembers.agent", { defaultValue: "代理人" })))}
              </div>
            </div>
          )}
        </div>

        {/* Add member — meaningful only when access is not company-wide. */}
        {canManage && visibility !== "company" && (
          <Popover open={addOpen} onOpenChange={setAddOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="mt-2 flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground"
              >
                <Plus className="h-3.5 w-3.5" />
                {t("projectMembers.addMember", { defaultValue: "新增成員" })}
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-72 p-2" align="start">
              <input
                autoFocus
                value={addSearch}
                onChange={(e) => setAddSearch(e.target.value)}
                placeholder={t("projectMembers.searchPlaceholder", { defaultValue: "搜尋成員或代理人…" })}
                className="mb-2 w-full rounded border border-input bg-transparent px-2 py-1 text-[13px] outline-none focus:border-ring"
              />
              <p className="mb-1 px-1 text-[11px] text-muted-foreground">
                {t("projectMembers.pickerHint", { defaultValue: "點名字＝加入本人＋代理人；或點單一標籤只加其中一個。" })}
              </p>
              <div className="max-h-64 overflow-y-auto overscroll-contain space-y-0.5" onWheel={(e) => { e.currentTarget.scrollTop += e.deltaY; }}>
                {peopleCandidates.map((e: CompanyUserDirectoryEntry) => {
                  const uid = e.principalId;
                  const label = e.user?.name ?? e.user?.email ?? uid.slice(0, 8);
                  const ags = e.agents ?? [];
                  const userAdded = existingIds.has(uid);
                  const addBoth = () => {
                    addOne("user", uid);
                    for (const a of ags) addOne("agent", a.id);
                    setAddOpen(false); setAddSearch("");
                  };
                  return (
                    <div key={uid} className="flex flex-wrap items-center gap-1.5 rounded px-2 py-1.5 hover:bg-accent/30">
                      <button type="button" onClick={addBoth} className="mr-1 flex-1 truncate text-left text-[13px] hover:underline">{label}</button>
                      <MemberChip added={userAdded} onClick={() => addOne("user", uid)}>{t("projectMembers.self", { defaultValue: "本人" })}</MemberChip>
                      {ags.map((a) => (
                        <MemberChip key={a.id} added={existingIds.has(a.id)} onClick={() => addOne("agent", a.id)}>
                          {ags.length > 1 ? a.name : t("projectMembers.agent", { defaultValue: "代理人" })}
                        </MemberChip>
                      ))}
                    </div>
                  );
                })}
                {orphanAgentCandidates.length > 0 && (
                  <div className="mt-1 px-1 text-[11px] uppercase tracking-wide text-muted-foreground">{t("projectMembers.otherAgents", { defaultValue: "其他代理人" })}</div>
                )}
                {orphanAgentCandidates.map((a) => (
                  <div key={a.id} className="flex items-center gap-1.5 rounded px-2 py-1.5 hover:bg-accent/30">
                    <span className="flex-1 truncate text-[13px]">{a.name}</span>
                    <MemberChip added={existingIds.has(a.id)} onClick={() => addOne("agent", a.id)}>{t("projectMembers.agent", { defaultValue: "代理人" })}</MemberChip>
                  </div>
                ))}
                {peopleCandidates.length === 0 && orphanAgentCandidates.length === 0 && (
                  <div className="px-2 py-2 text-[12px] text-muted-foreground">
                    {t("projectMembers.noResults", { defaultValue: "沒有找到可加入的成員" })}
                  </div>
                )}
              </div>
            </PopoverContent>
          </Popover>
        )}
      </div>
    </div>
  );
}

function MemberChip({ added, onClick, children }: { added: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      disabled={added}
      onClick={onClick}
      className={cn(
        "shrink-0 rounded-full border px-2 py-0.5 text-[11px] transition-colors",
        added ? "border-border bg-accent/40 text-muted-foreground" : "border-primary/40 text-primary hover:bg-primary/10",
      )}
    >
      {children} {added ? "✓" : "＋"}
    </button>
  );
}

function RolePicker({ value, onChange }: { value: ProjectMemberRole; onChange: (r: ProjectMemberRole) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1 rounded border border-input px-1.5 py-0.5 text-[12px] text-muted-foreground hover:border-ring hover:text-foreground"
        >
          {ROLE_LABELS[value]?.split(" ")[0]}
          <ChevronDown className="h-3 w-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-44 p-1" align="end">
        {(Object.keys(ROLE_LABELS) as ProjectMemberRole[]).map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => { onChange(r); setOpen(false); }}
            className={cn("flex w-full flex-col rounded px-2 py-1.5 text-left hover:bg-accent", r === value && "bg-accent/50")}
          >
            <span className="text-[13px]">{ROLE_LABELS[r]}</span>
            <span className="text-[11px] text-muted-foreground">{ROLE_DESC[r]}</span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
