import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal, Pin, Pencil, FolderPlus, Trash2, X } from "lucide-react";
import { useTranslation } from "@/i18n";
import { issuesApi } from "../api/issues";
import { projectsApi } from "../api/projects";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type TaskRowMenuIssue = {
  id: string;
  title: string;
  pinned?: boolean;
  projectId?: string | null;
};

/** Row-level ⋯ menu for a task: pin, rename, add-to-project (scope-grouped), remove.
 *  Reveals on row hover. `onChanged` should invalidate the caller's task list. */
export function TaskRowMenu({ companyId, issue, onChanged }: { companyId: string; issue: TaskRowMenuIssue; onChanged?: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(issue.title);

  const invalidate = () => {
    onChanged?.();
    queryClient.invalidateQueries({ queryKey: queryKeys.projects.list(companyId) });
  };

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(companyId),
    queryFn: () => projectsApi.list(companyId),
  });

  const update = useMutation({
    mutationFn: (data: Record<string, unknown>) => issuesApi.update(issue.id, data),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: () => issuesApi.remove(issue.id),
    onSuccess: invalidate,
  });

  const scoped = {
    company: (projects ?? []).filter((p) => !p.archivedAt && (p.visibility ?? "company") === "company"),
    team: (projects ?? []).filter((p) => !p.archivedAt && p.visibility === "team"),
    personal: (projects ?? []).filter((p) => !p.archivedAt && p.visibility === "private"),
  };
  const scopeGroups = [
    [t("projects.scopeCompany", { defaultValue: "公司專案" }), scoped.company],
    [t("projects.scopeTeam", { defaultValue: "團隊專案" }), scoped.team],
    [t("projects.scopePersonal", { defaultValue: "個人專案" }), scoped.personal],
  ] as const;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={t("taskMenu.actions", { defaultValue: "任務選項" })}
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
            className={cn(
              "flex h-6 w-6 items-center justify-center rounded text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground",
              "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100",
              issue.pinned && "opacity-100",
            )}
          >
            {issue.pinned ? <Pin className="h-3.5 w-3.5 fill-current text-primary" /> : <MoreHorizontal className="h-4 w-4" />}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48" onClick={(e) => e.stopPropagation()}>
          <DropdownMenuItem onSelect={() => update.mutate({ pinned: !issue.pinned })}>
            <Pin className="mr-2 h-3.5 w-3.5" />
            {issue.pinned ? t("taskMenu.unpin", { defaultValue: "取消釘選" }) : t("taskMenu.pin", { defaultValue: "釘選" })}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => { setNameDraft(issue.title); setRenaming(true); }}>
            <Pencil className="mr-2 h-3.5 w-3.5" />
            {t("taskMenu.rename", { defaultValue: "重新命名" })}
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <FolderPlus className="mr-2 h-3.5 w-3.5" />
              {t("taskMenu.addToProject", { defaultValue: "加入專案" })}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-72 w-56 overflow-y-auto">
              {issue.projectId ? (
                <>
                  <DropdownMenuItem onSelect={() => update.mutate({ projectId: null })}>
                    <X className="mr-2 h-3.5 w-3.5" />
                    {t("taskMenu.removeFromProject", { defaultValue: "移出專案" })}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              ) : null}
              {scopeGroups.every(([, list]) => list.length === 0) ? (
                <div className="px-2 py-1.5 text-xs text-muted-foreground">{t("taskMenu.noProjects", { defaultValue: "沒有可用的專案" })}</div>
              ) : (
                scopeGroups.map(([label, list]) =>
                  list.length === 0 ? null : (
                    <div key={label}>
                      <div className="px-2 py-1 text-[11px] font-medium text-muted-foreground">{label}</div>
                      {list.map((p) => (
                        <DropdownMenuItem key={p.id} disabled={p.id === issue.projectId} onSelect={() => update.mutate({ projectId: p.id })}>
                          <span className="truncate">{p.name}</span>
                        </DropdownMenuItem>
                      ))}
                    </div>
                  ),
                )
              )}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onSelect={() => {
              if (window.confirm(t("taskMenu.removeConfirm", { defaultValue: "確定要移除這個任務？此動作無法復原。" }))) remove.mutate();
            }}
          >
            <Trash2 className="mr-2 h-3.5 w-3.5" />
            {t("taskMenu.remove", { defaultValue: "移除任務" })}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={renaming} onOpenChange={setRenaming}>
        <DialogContent className="sm:max-w-md" onClick={(e) => e.stopPropagation()}>
          <DialogHeader>
            <DialogTitle>{t("taskMenu.rename", { defaultValue: "重新命名" })}</DialogTitle>
          </DialogHeader>
          <Input
            value={nameDraft}
            autoFocus
            onChange={(e) => setNameDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && nameDraft.trim()) { update.mutate({ title: nameDraft.trim() }); setRenaming(false); } }}
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRenaming(false)}>{t("common.cancel", { defaultValue: "取消" })}</Button>
            <Button disabled={!nameDraft.trim() || update.isPending} onClick={() => { update.mutate({ title: nameDraft.trim() }); setRenaming(false); }}>
              {t("common.save", { defaultValue: "儲存" })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
