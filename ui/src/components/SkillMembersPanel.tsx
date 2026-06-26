import { useState, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "@/i18n";
import { companySkillsApi } from "../api/companySkills";
import { accessApi, type CompanyUserDirectoryEntry } from "../api/access";
import { queryKeys } from "../lib/queryKeys";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Users, X, Plus } from "lucide-react";

interface Props {
  skillId: string;
  companyId: string;
  /** Owner/admin (or skill editor) can manage the access list. */
  canManage: boolean;
}

// Access list for a PRIVATE skill: the creator always has access; this panel
// manages the additional users who may see it. Mirrors ProjectMembersPanel.
export function SkillMembersPanel({ skillId, companyId, canManage }: Props) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const key = ["skill-members", skillId];

  const { data: members } = useQuery({
    queryKey: key,
    queryFn: () => companySkillsApi.listMembers(companyId, skillId),
    enabled: !!skillId && !!companyId,
  });
  const { data: userDirectory } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(companyId),
    queryFn: () => accessApi.listUserDirectory(companyId),
    enabled: !!companyId && canManage,
  });

  const userById = useMemo(
    () => new Map((userDirectory?.users ?? []).map((e: CompanyUserDirectoryEntry) => [e.principalId, e.user])),
    [userDirectory],
  );
  const invalidate = () => queryClient.invalidateQueries({ queryKey: key });

  const add = useMutation({
    mutationFn: (principalId: string) => companySkillsApi.addMember(companyId, skillId, principalId),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (principalId: string) => companySkillsApi.removeMember(companyId, skillId, principalId),
    onSuccess: invalidate,
  });

  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const existing = new Set(members?.map((m) => m.principalId) ?? []);
  const candidates = (userDirectory?.users ?? []).filter(
    (e: CompanyUserDirectoryEntry) =>
      !existing.has(e.principalId) &&
      (e.user?.name ?? e.user?.email ?? "").toLowerCase().includes(search.toLowerCase()),
  );

  const label = (principalId: string) => {
    const u = userById.get(principalId);
    return u?.name ?? u?.email ?? principalId.slice(0, 8);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <Users className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t("skillMembers.title", { defaultValue: "People with access" })}
        </span>
        <span className="text-[11px] text-muted-foreground">({members?.length ?? 0})</span>
      </div>

      {members?.length === 0 && (
        <p className="text-[12px] text-muted-foreground">
          {t("skillMembers.empty", { defaultValue: "Only you can see this skill. Add people to share it." })}
        </p>
      )}

      <div className="space-y-1">
        {(members ?? []).map((m) => (
          <div key={m.id} className="flex items-center gap-2 rounded px-2 py-1 hover:bg-accent/30">
            <span className="flex-1 truncate text-[13px]">{label(m.principalId)}</span>
            {canManage && (
              <button
                type="button"
                onClick={() => remove.mutate(m.principalId)}
                className="text-muted-foreground hover:text-destructive"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        ))}
      </div>

      {canManage && (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button type="button" className="flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground">
              <Plus className="h-3.5 w-3.5" />
              {t("skillMembers.add", { defaultValue: "Add person" })}
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-64 p-2" align="start">
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("skillMembers.searchPlaceholder", { defaultValue: "Search people…" })}
              className="mb-2 w-full rounded border border-input bg-transparent px-2 py-1 text-[13px] outline-none focus:border-ring"
            />
            <div className="max-h-56 space-y-0.5 overflow-y-auto">
              {candidates.map((e: CompanyUserDirectoryEntry) => (
                <button
                  key={e.principalId}
                  type="button"
                  onClick={() => { add.mutate(e.principalId); setOpen(false); setSearch(""); }}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] hover:bg-accent"
                >
                  {e.user?.name ?? e.user?.email ?? e.principalId.slice(0, 8)}
                </button>
              ))}
              {candidates.length === 0 && (
                <div className="px-2 py-2 text-[12px] text-muted-foreground">
                  {t("skillMembers.noResults", { defaultValue: "No people found" })}
                </div>
              )}
            </div>
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}
