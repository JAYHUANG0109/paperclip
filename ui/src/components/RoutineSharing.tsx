import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Globe, Lock, Plus, Users, X } from "lucide-react";
import type { RoutineVisibility } from "@paperclipai/shared";
import { routinesApi } from "../api/routines";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTranslation } from "@/i18n";

/**
 * Sharing controls for one routine: the explicit scope plus per-person grants.
 *
 * Worth knowing while reading this: the scope only governs sharing between PEOPLE.
 * Anyone who manages an agent the routine is assigned to keeps seeing it regardless
 * (the agent-visibility floor on the server), so "Private" never hides a report's
 * automation from their manager. The copy below says so, because a control that looks
 * stricter than it is would be worse than no control.
 */

const SCOPES: { value: RoutineVisibility; labelKey: string; descKey: string; icon: typeof Lock }[] = [
  { value: "private", labelKey: "routineDetail.sharing.scopePrivate", descKey: "routineDetail.sharing.scopePrivateDesc", icon: Lock },
  { value: "team", labelKey: "routineDetail.sharing.scopeTeam", descKey: "routineDetail.sharing.scopeTeamDesc", icon: Users },
  { value: "company", labelKey: "routineDetail.sharing.scopeCompany", descKey: "routineDetail.sharing.scopeCompanyDesc", icon: Globe },
];

export function RoutineVisibilityBadge({ visibility }: { visibility?: RoutineVisibility | null }) {
  const { t } = useTranslation();
  const scope = SCOPES.find((s) => s.value === (visibility ?? "private")) ?? SCOPES[0];
  const Icon = scope.icon;
  return (
    <Badge variant="outline" className="gap-1 text-xs font-normal">
      <Icon className="size-3" />
      {t(scope.labelKey)}
    </Badge>
  );
}

export function RoutineSharing({
  routineId,
  visibility,
  sharingTeams,
  canManage,
  directory = [],
}: {
  routineId: string;
  visibility?: RoutineVisibility | null;
  sharingTeams?: string[] | null;
  canManage: boolean;
  /** Company people, so sharing is "pick a colleague" rather than "paste a user id". */
  directory?: Array<{ principalId: string; user: { id: string; email: string | null; name: string | null } | null }>;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const current: RoutineVisibility = visibility ?? "private";
  const [teamDraft, setTeamDraft] = useState("");
  const [memberDraft, setMemberDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const members = useQuery({
    queryKey: ["routine-access-members", routineId],
    queryFn: () => routinesApi.listAccessMembers(routineId),
    enabled: canManage,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["routine", routineId] });
    void queryClient.invalidateQueries({ queryKey: ["routine-access-members", routineId] });
  };

  const setVisibility = useMutation({
    mutationFn: (body: { visibility: RoutineVisibility; sharingTeams?: string[] }) =>
      routinesApi.setVisibility(routineId, body),
    onSuccess: () => { setError(null); invalidate(); },
    onError: (err: unknown) => setError(err instanceof Error ? err.message : t("routineDetail.sharing.updateFailed")),
  });

  const addMember = useMutation({
    mutationFn: (principalId: string) => routinesApi.addAccessMember(routineId, principalId),
    onSuccess: () => { setMemberDraft(""); setError(null); invalidate(); },
    onError: (err: unknown) => setError(err instanceof Error ? err.message : t("routineDetail.sharing.shareFailed")),
  });

  const removeMember = useMutation({
    mutationFn: (principalId: string) => routinesApi.removeAccessMember(routineId, principalId),
    onSuccess: () => invalidate(),
  });

  const teams = sharingTeams ?? [];

  /** Show a name/email rather than an opaque id, falling back to the id itself. */
  function labelFor(principalId: string): string {
    const hit = directory.find((d) => d.principalId === principalId || d.user?.id === principalId);
    return hit?.user?.name || hit?.user?.email || principalId;
  }

  /** People not already shared with. */
  const alreadyShared = new Set((members.data ?? []).map((m) => m.principalId));
  const shareable = directory
    .map((d) => ({ id: d.user?.id ?? d.principalId, label: d.user?.name || d.user?.email || d.principalId }))
    .filter((entry) => !alreadyShared.has(entry.id))
    .sort((a, b) => a.label.localeCompare(b.label));

  function chooseScope(next: RoutineVisibility) {
    if (!canManage || next === current) return;
    // Team scope needs at least one team, so keep whatever is already set and let the
    // user add one below rather than rejecting the click.
    if (next === "team" && teams.length === 0) {
      setError(t("routineDetail.sharing.needTeamFirst"));
      return;
    }
    setVisibility.mutate({ visibility: next });
  }

  function addTeam() {
    const name = teamDraft.trim();
    if (!name || !canManage) return;
    const next = Array.from(new Set([...teams, name]));
    setVisibility.mutate({ visibility: "team", sharingTeams: next });
    setTeamDraft("");
  }

  function removeTeam(name: string) {
    const next = teams.filter((t) => t !== name);
    setVisibility.mutate({
      // Dropping the last team would leave an unsatisfiable team scope, so fall back
      // to private rather than letting the server reject it.
      visibility: next.length === 0 && current === "team" ? "private" : current,
      sharingTeams: next,
    });
  }

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-sm font-medium text-foreground">{t("routineDetail.sharing.title")}</h2>
        <p className="text-xs text-muted-foreground">
          {t("routineDetail.sharing.subtitle")}
        </p>
      </div>

      <div className="grid gap-2 sm:grid-cols-3">
        {SCOPES.map((scope) => {
          const Icon = scope.icon;
          const selected = current === scope.value;
          return (
            <button
              key={scope.value}
              type="button"
              disabled={!canManage || setVisibility.isPending}
              onClick={() => chooseScope(scope.value)}
              aria-pressed={selected}
              className={cn(
                "rounded-md border px-3 py-2 text-left text-sm transition-colors",
                "disabled:opacity-50 disabled:pointer-events-none",
                selected ? "border-foreground bg-accent/50" : "border-border hover:bg-accent/50",
              )}
            >
              <span className="flex items-center gap-1.5 font-medium">
                <Icon className="size-3.5" />
                {t(scope.labelKey)}
              </span>
              <span className="mt-1 block text-xs text-muted-foreground">{t(scope.descKey)}</span>
            </button>
          );
        })}
      </div>

      {(current === "team" || teams.length > 0) && (
        <div className="space-y-2">
          <span className="text-xs text-muted-foreground">{t("routineDetail.sharing.teams")}</span>
          <div className="flex flex-wrap items-center gap-1.5">
            {teams.length === 0 && <span className="text-xs text-muted-foreground">{t("routineDetail.sharing.noTeams")}</span>}
            {teams.map((team) => (
              <Badge key={team} variant="secondary" className="gap-1 font-normal">
                {team}
                {canManage && (
                  <button type="button" onClick={() => removeTeam(team)} aria-label={`Remove ${team}`}>
                    <X className="size-3" />
                  </button>
                )}
              </Badge>
            ))}
          </div>
          {canManage && (
            <div className="flex items-center gap-2">
              <Input
                value={teamDraft}
                onChange={(e) => setTeamDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTeam(); } }}
                placeholder={t("routineDetail.sharing.teamPlaceholder")}
                className="h-8 text-sm"
              />
              <Button type="button" size="sm" variant="outline" onClick={addTeam} disabled={!teamDraft.trim()}>
                <Plus className="size-3.5" /> {t("routineDetail.sharing.addTeam")}
              </Button>
            </div>
          )}
        </div>
      )}

      {canManage && (
        <div className="space-y-2">
          <span className="text-xs text-muted-foreground">{t("routineDetail.sharing.sharedWith")}</span>
          <div className="space-y-1">
            {(members.data ?? []).length === 0 && (
              <span className="text-xs text-muted-foreground">{t("routineDetail.sharing.nobodyYet")}</span>
            )}
            {(members.data ?? []).map((m) => (
              <div key={m.id} className="flex items-center justify-between py-1">
                <span className="text-xs text-muted-foreground">{labelFor(m.principalId)}</span>
                <button
                  type="button"
                  onClick={() => removeMember.mutate(m.principalId)}
                  aria-label={`Revoke ${m.principalId}`}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2">
            {shareable.length > 0 ? (
              <select
                value={memberDraft}
                onChange={(e) => setMemberDraft(e.target.value)}
                className={cn(
                  "h-8 flex-1 rounded-md border border-input bg-transparent px-2 text-sm",
                  "focus-visible:ring-ring focus-visible:ring-[3px] focus-visible:outline-none",
                )}
              >
                <option value="">{t("routineDetail.sharing.choosePerson")}</option>
                {shareable.map((entry) => (
                  <option key={entry.id} value={entry.id}>{entry.label}</option>
                ))}
              </select>
            ) : (
              <Input
                value={memberDraft}
                onChange={(e) => setMemberDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); if (memberDraft.trim()) addMember.mutate(memberDraft.trim()); }
                }}
                placeholder={t("routineDetail.sharing.sharePlaceholder")}
                className="h-8 text-sm"
              />
            )}
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => memberDraft.trim() && addMember.mutate(memberDraft.trim())}
              disabled={!memberDraft.trim() || addMember.isPending}
            >
              <Plus className="size-3.5" /> {t("routineDetail.sharing.share")}
            </Button>
          </div>
        </div>
      )}

      {error && <p className="text-xs text-destructive">{error}</p>}
      {!canManage && (
        <p className="text-xs text-muted-foreground">{t("routineDetail.sharing.needEditAccess")}</p>
      )}
    </div>
  );
}
