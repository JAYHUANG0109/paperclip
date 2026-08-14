import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Globe, Lock, Users } from "lucide-react";
import type { CompanySkillSharingScope } from "@paperclipai/shared";
import { companySkillsApi } from "../api/companySkills";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SkillMembersPanel } from "./SkillMembersPanel";

type EditableScope = Exclude<CompanySkillSharingScope, "public_link">;

interface Props {
  companyId: string;
  skillId: string;
  scope: CompanySkillSharingScope;
  sharingTeams: string[];
  /** Only the creator / an owner-admin may re-scope a skill. */
  canManage: boolean;
}

const SCOPE_LABEL: Record<EditableScope, string> = {
  company: "Company",
  team: "Team",
  private: "Private",
};

function ScopeIcon({ scope }: { scope: CompanySkillSharingScope }) {
  if (scope === "private") return <Lock className="h-3.5 w-3.5 text-muted-foreground" />;
  if (scope === "team") return <Users className="h-3.5 w-3.5 text-muted-foreground" />;
  return <Globe className="h-3.5 w-3.5 text-muted-foreground" />;
}

/**
 * Change a skill's sharing after it was created.
 *
 * Skills were the only shareable thing with no way to re-scope them once made —
 * folders, routines and projects all have one. Creation was the single moment
 * the decision could be made, so a mis-scoped skill had to be recreated.
 *
 * Mirrors ProjectMembersPanel: a scope picker, team chips when the scope is
 * team, and the existing per-user access list when it is private.
 */
export function SkillSharingPanel({ companyId, skillId, scope, sharingTeams, canManage }: Props) {
  const queryClient = useQueryClient();

  // All company teams — re-scoping a skill to a team may target any team, not
  // only the manager's own (see getShareableTeams on the server).
  const teamsQuery = useQuery({
    queryKey: queryKeys.companySkills.shareableTeams(companyId),
    queryFn: () => companySkillsApi.shareableTeams(companyId),
    enabled: canManage,
    staleTime: 60_000,
  });

  const setSharing = useMutation({
    mutationFn: (body: { sharingScope: EditableScope; sharingTeams: string[] }) =>
      companySkillsApi.update(companyId, skillId, body),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.detail(companyId, skillId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.list(companyId) }),
      ]);
    },
  });

  const teams = teamsQuery.data?.teams ?? [];
  const current = (scope === "public_link" ? "company" : scope) as EditableScope;

  function chooseScope(next: EditableScope) {
    // Teams only mean anything on a team-scoped skill; clearing them keeps a
    // stale list from silently re-applying if the scope is switched back.
    setSharing.mutate({ sharingScope: next, sharingTeams: next === "team" ? sharingTeams : [] });
  }

  function toggleTeam(team: string) {
    const next = sharingTeams.includes(team)
      ? sharingTeams.filter((t) => t !== team)
      : [...sharingTeams, team];
    setSharing.mutate({ sharingScope: "team", sharingTeams: next });
  }

  if (!canManage) {
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <ScopeIcon scope={scope} />
        {SCOPE_LABEL[current]}
        {current === "team" && sharingTeams.length > 0 ? ` · ${sharingTeams.join(", ")}` : ""}
      </span>
    );
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={setSharing.isPending}
          className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/50 disabled:opacity-50"
        >
          <ScopeIcon scope={scope} />
          <span className="normal-case tracking-normal">
            {SCOPE_LABEL[current]}
            {current === "team" && sharingTeams.length > 0 ? ` · ${sharingTeams.length}` : ""}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 space-y-3 p-3">
        <div className="space-y-1">
          <div className="text-xs font-medium">Who can see this skill</div>
          {(["company", "team", "private"] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => chooseScope(option)}
              className={cn(
                "flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-accent/50",
                current === option && "bg-accent",
              )}
            >
              <ScopeIcon scope={option} />
              {SCOPE_LABEL[option]}
            </button>
          ))}
        </div>

        {current === "team" && (
          <div className="space-y-1.5 border-t border-border pt-2">
            <div className="text-xs font-medium">Teams</div>
            {teams.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                You are not on a team yet, so only you can see this.
              </p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {teams.map((team) => (
                  <button
                    key={team}
                    type="button"
                    onClick={() => toggleTeam(team)}
                    className={cn(
                      "rounded-full border px-2 py-0.5 text-xs",
                      sharingTeams.includes(team)
                        ? "border-foreground bg-accent/50 text-foreground"
                        : "border-border text-muted-foreground",
                    )}
                  >
                    {team}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {current === "private" && (
          <div className="border-t border-border pt-2">
            <SkillMembersPanel skillId={skillId} companyId={companyId} canManage={canManage} />
          </div>
        )}

        {setSharing.isError && (
          <p className="text-xs text-destructive">
            {setSharing.error instanceof Error ? setSharing.error.message : "Could not update sharing."}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
