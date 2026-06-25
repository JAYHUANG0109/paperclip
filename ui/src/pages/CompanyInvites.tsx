import { useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, ExternalLink, MailPlus } from "lucide-react";
import { accessApi } from "@/api/access";
import { projectsApi } from "@/api/projects";
import { ApiError } from "@/api/client";
import { Button } from "@/components/ui/button";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useToast } from "@/context/ToastContext";
import { Link } from "@/lib/router";
import { t, useTranslation } from "@/i18n";
import { queryKeys } from "@/lib/queryKeys";

function buildInviteRoleOptions() {
  return [
    {
      value: "viewer",
      label: t("companyInvites.role.viewer.label"),
      description: t("companyInvites.role.viewer.description"),
      gets: t("companyInvites.role.viewer.gets"),
    },
    {
      value: "operator",
      label: t("companyInvites.role.operator.label"),
      description: t("companyInvites.role.operator.description"),
      gets: t("companyInvites.role.operator.gets"),
    },
    {
      value: "admin",
      label: t("companyInvites.role.admin.label"),
      description: t("companyInvites.role.admin.description"),
      gets: t("companyInvites.role.admin.gets"),
    },
    {
      value: "owner",
      label: t("companyInvites.role.owner.label"),
      description: t("companyInvites.role.owner.description"),
      gets: t("companyInvites.role.owner.gets"),
    },
  ] as const;
}

const INVITE_HISTORY_PAGE_SIZE = 5;

function isInviteHistoryRow(value: unknown): value is Awaited<ReturnType<typeof accessApi.listInvites>>["invites"][number] {
  if (!value || typeof value !== "object") return false;
  return "id" in value && "state" in value && "createdAt" in value;
}

export function CompanyInvites() {
  const { t } = useTranslation();
  const inviteRoleOptions = buildInviteRoleOptions();
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [humanRole, setHumanRole] = useState<"owner" | "admin" | "operator" | "viewer">("operator");
  const [guestProjectIds, setGuestProjectIds] = useState<string[]>([]);
  const [latestInviteUrl, setLatestInviteUrl] = useState<string | null>(null);
  const [latestInviteCopied, setLatestInviteCopied] = useState(false);
  const latestInviteInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!latestInviteCopied) return;
    const timeout = window.setTimeout(() => {
      setLatestInviteCopied(false);
    }, 1600);
    return () => window.clearTimeout(timeout);
  }, [latestInviteCopied]);

  function selectLatestInviteUrl() {
    latestInviteInputRef.current?.focus();
    latestInviteInputRef.current?.select();
  }

  async function copyText(text: string, unavailableBody: string, afterFallback?: () => void) {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // Fall through to the unavailable message below.
    }

    const canUseLegacyCopy =
      typeof document !== "undefined" &&
      typeof document.execCommand === "function" &&
      (typeof document.queryCommandSupported !== "function" || document.queryCommandSupported("copy"));
    if (canUseLegacyCopy) {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "true");
      textarea.style.position = "fixed";
      textarea.style.top = "0";
      textarea.style.left = "-9999px";
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      textarea.setSelectionRange(0, textarea.value.length);

      try {
        const copied = document.execCommand("copy");
        document.body.removeChild(textarea);
        afterFallback?.();
        if (copied) return true;
      } catch {
        document.body.removeChild(textarea);
      }
    }

    afterFallback?.();
    pushToast({
      title: t("companyInvites.clipboardUnavailable"),
      body: unavailableBody,
      tone: "warn",
    });
    return false;
  }

  async function copyInviteUrl(url: string) {
    return copyText(url, t("companyInvites.copyManualSelected"), selectLatestInviteUrl);
  }

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? t("common.company"), href: "/dashboard" },
      { label: t("companyInvites.breadcrumbSettings"), href: "/company/settings" },
      { label: t("companyInvites.breadcrumbInvites") },
    ]);
  }, [selectedCompany?.name, setBreadcrumbs, t]);

  const inviteHistoryQueryKey = queryKeys.access.invites(selectedCompanyId ?? "", "all", INVITE_HISTORY_PAGE_SIZE);
  const invitesQuery = useInfiniteQuery({
    queryKey: inviteHistoryQueryKey,
    queryFn: ({ pageParam }) =>
      accessApi.listInvites(selectedCompanyId!, {
        limit: INVITE_HISTORY_PAGE_SIZE,
        offset: pageParam,
      }),
    enabled: !!selectedCompanyId,
    initialPageParam: 0,
    getNextPageParam: (lastPage) => lastPage.nextOffset ?? undefined,
  });
  const inviteHistory = useMemo(
    () =>
      invitesQuery.data?.pages.flatMap((page) =>
        Array.isArray(page?.invites) ? page.invites.filter(isInviteHistoryRow) : [],
      ) ?? [],
    [invitesQuery.data?.pages],
  );

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const createInviteMutation = useMutation({
    mutationFn: () =>
      accessApi.createCompanyInvite(selectedCompanyId!, {
        allowedJoinTypes: "human",
        humanRole,
        agentMessage: null,
        defaultsPayload: humanRole === "viewer" && guestProjectIds.length > 0 ? { guestProjectIds } : null,
      }),
    onSuccess: async (invite) => {
      setLatestInviteUrl(invite.inviteUrl);
      setLatestInviteCopied(false);
      if (humanRole !== "viewer") setGuestProjectIds([]);
      const copied = await copyText(invite.inviteUrl, t("companyInvites.copyManualBelow"));

      await queryClient.invalidateQueries({ queryKey: inviteHistoryQueryKey });
      pushToast({
        title: t("companyInvites.inviteCreated"),
        body: copied ? t("companyInvites.inviteReadyCopied") : t("companyInvites.inviteReady"),
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: t("companyInvites.failedCreate"),
        body: error instanceof Error ? error.message : t("common.unknownError"),
        tone: "error",
      });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (inviteId: string) => accessApi.revokeInvite(inviteId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: inviteHistoryQueryKey });
      pushToast({ title: t("companyInvites.inviteRevoked"), tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: t("companyInvites.failedRevoke"),
        body: error instanceof Error ? error.message : t("common.unknownError"),
        tone: "error",
      });
    },
  });

  if (!selectedCompanyId) {
    return <div className="text-sm text-muted-foreground">{t("companyInvites.selectCompany")}</div>;
  }

  if (invitesQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">{t("companyInvites.loading")}</div>;
  }

  if (invitesQuery.error) {
    const message =
      invitesQuery.error instanceof ApiError && invitesQuery.error.status === 403
        ? t("companyInvites.noPermission")
        : invitesQuery.error instanceof Error
          ? invitesQuery.error.message
          : t("companyInvites.failedLoad");
    return <div className="text-sm text-destructive">{message}</div>;
  }

  return (
    <div className="max-w-5xl space-y-8">
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <MailPlus className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">{t("companyInvites.heading")}</h1>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">
          {t("companyInvites.intro")}
        </p>
      </div>

      <section className="space-y-4 rounded-xl border border-border p-5">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">{t("companyInvites.invitePerson")}</h2>
          <p className="text-sm text-muted-foreground">
            {t("companyInvites.invitePersonDesc")}
          </p>
        </div>

        <fieldset className="space-y-3">
          <legend className="text-sm font-medium">{t("companyInvites.chooseRole")}</legend>
          <div className="rounded-xl border border-border">
            {inviteRoleOptions.map((option, index) => {
              const checked = humanRole === option.value;
              return (
                <label
                  key={option.value}
                  className={`flex cursor-pointer gap-3 px-4 py-4 ${index > 0 ? "border-t border-border" : ""}`}
                >
                  <input
                    type="radio"
                    name="invite-role"
                    value={option.value}
                    checked={checked}
                    onChange={() => setHumanRole(option.value)}
                    className="mt-1 h-4 w-4 border-border text-foreground"
                  />
                  <span className="min-w-0 space-y-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{option.label}</span>
                      {option.value === "operator" ? (
                        <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
                          {t("companyInvites.default")}
                        </span>
                      ) : null}
                    </span>
                    <span className="block max-w-2xl text-sm text-muted-foreground">{option.description}</span>
                    <span className="block text-sm text-foreground">{option.gets}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>


        {/* Phase 7: guest project picker — shown when viewer role selected */}
        {humanRole === "viewer" && (
          <div className="rounded-lg border border-border px-4 py-3 space-y-2">
            <div className="text-sm font-medium text-foreground">
              {t("companyInvites.guestProjects", { defaultValue: "訪客專案存取 Guest project access" })}
            </div>
            <p className="text-[12px] text-muted-foreground">
              {t("companyInvites.guestProjectsDesc", { defaultValue: "選擇此訪客加入後可存取的私密專案（選填）。" })}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {(projects ?? []).map((proj) => {
                const selected = guestProjectIds.includes(proj.id);
                return (
                  <button
                    key={proj.id}
                    type="button"
                    onClick={() => setGuestProjectIds((ids) =>
                      selected ? ids.filter((id) => id !== proj.id) : [...ids, proj.id]
                    )}
                    className={[
                      "rounded-full border px-2.5 py-0.5 text-[12px] transition-colors",
                      selected
                        ? "border-primary/40 bg-primary/10 text-foreground"
                        : "border-border text-muted-foreground hover:border-ring hover:text-foreground",
                    ].join(" ")}
                  >
                    {proj.name}
                  </button>
                );
              })}
              {!projects?.length && (
                <span className="text-[12px] text-muted-foreground">
                  {t("companyInvites.noProjects", { defaultValue: "尚無專案" })}
                </span>
              )}
            </div>
          </div>
        )}

        <div className="rounded-lg border border-border px-4 py-3 text-sm text-muted-foreground">
          {t("companyInvites.singleUseNotice")}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => createInviteMutation.mutate()} disabled={createInviteMutation.isPending}>
            {createInviteMutation.isPending ? t("companyInvites.creating") : t("companyInvites.createInvite")}
          </Button>
          <span className="text-sm text-muted-foreground">{t("companyInvites.auditTrailNote")}</span>
        </div>

        {latestInviteUrl ? (
          <div className="space-y-3 rounded-lg border border-border px-4 py-4">
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-medium">{t("companyInvites.latestInviteLink")}</div>
                {latestInviteCopied ? (
                  <div className="inline-flex items-center gap-1 text-xs font-medium text-foreground">
                    <Check className="h-3.5 w-3.5" />
                    {t("common.copied")}
                  </div>
                ) : null}
              </div>
              <div className="text-sm text-muted-foreground">
                {t("companyInvites.urlDomainNote")}
              </div>
            </div>
            <label className="block space-y-1">
              <span className="sr-only">{t("companyInvites.latestInviteUrl")}</span>
              <input
                ref={latestInviteInputRef}
                readOnly
                value={latestInviteUrl}
                onFocus={(event) => event.currentTarget.select()}
                onClick={(event) => event.currentTarget.select()}
                className="w-full rounded-md border border-border bg-muted/60 px-3 py-2 text-sm text-foreground outline-none transition-colors selection:bg-primary selection:text-primary-foreground focus:border-ring"
                aria-label={t("companyInvites.latestInviteUrl")}
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={async () => {
                  const copied = await copyInviteUrl(latestInviteUrl);
                  setLatestInviteCopied(copied);
                }}
              >
                <Copy className="h-4 w-4" />
                {t("companyInvites.copyLink")}
              </Button>
              <Button size="sm" variant="outline" asChild>
                <a href={latestInviteUrl} target="_blank" rel="noreferrer">
                  <ExternalLink className="h-4 w-4" />
                  {t("companyInvites.openInvite")}
                </a>
              </Button>
            </div>
          </div>
        ) : null}
      </section>

      <section className="rounded-xl border border-border">
        <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
          <div className="space-y-1">
            <h2 className="text-sm font-semibold">{t("companyInvites.inviteHistory")}</h2>
            <p className="text-sm text-muted-foreground">
              {t("companyInvites.inviteHistoryDesc")}
            </p>
          </div>
          <Link to="/inbox/requests" className="text-sm underline underline-offset-4">
            {t("companyInvites.openJoinQueue")}
          </Link>
        </div>

        {inviteHistory.length === 0 ? (
          <div className="border-t border-border px-5 py-8 text-sm text-muted-foreground">
            {t("companyInvites.noInvites")}
          </div>
        ) : (
          <div className="border-t border-border">
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="px-5 py-3 font-medium text-muted-foreground">{t("companyInvites.colState")}</th>
                    <th className="px-5 py-3 font-medium text-muted-foreground">{t("companyInvites.colFor")}</th>
                    <th className="px-5 py-3 font-medium text-muted-foreground">{t("companyInvites.colInvitedBy")}</th>
                    <th className="px-5 py-3 font-medium text-muted-foreground">{t("companyInvites.colCreated")}</th>
                    <th className="px-5 py-3 font-medium text-muted-foreground">{t("companyInvites.colJoinRequest")}</th>
                    <th className="px-5 py-3 text-right font-medium text-muted-foreground">{t("companyInvites.colAction")}</th>
                  </tr>
                </thead>
                <tbody>
                  {inviteHistory.map((invite) => (
                    <tr key={invite.id} className="border-b border-border last:border-b-0">
                      <td className="px-5 py-3 align-top">
                        <span className="inline-flex rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
                          {formatInviteState(invite.state)}
                        </span>
                      </td>
                      <td className="px-5 py-3 align-top">{formatInviteAudience(invite)}</td>
                      <td className="px-5 py-3 align-top">
                        <div>{invite.invitedByUser?.name || invite.invitedByUser?.email || t("companyInvites.unknownInviter")}</div>
                        {invite.invitedByUser?.email && invite.invitedByUser.name ? (
                          <div className="text-xs text-muted-foreground">{invite.invitedByUser.email}</div>
                        ) : null}
                      </td>
                      <td className="px-5 py-3 align-top text-muted-foreground">
                        {new Date(invite.createdAt).toLocaleString()}
                      </td>
                      <td className="px-5 py-3 align-top">
                        {invite.relatedJoinRequestId ? (
                          <Link to="/inbox/requests" className="underline underline-offset-4">
                            {t("companyInvites.reviewRequest")}
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-right align-top">
                        {invite.state === "active" ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => revokeMutation.mutate(invite.id)}
                            disabled={revokeMutation.isPending}
                          >
                            {t("companyInvites.revoke")}
                          </Button>
                        ) : (
                          <span className="text-xs text-muted-foreground">{t("companyInvites.inactive")}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {invitesQuery.hasNextPage ? (
              <div className="flex justify-center border-t border-border px-5 py-4">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => invitesQuery.fetchNextPage()}
                  disabled={invitesQuery.isFetchingNextPage}
                >
                  {invitesQuery.isFetchingNextPage ? t("companyInvites.loadingMore") : t("companyInvites.viewMore")}
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </section>
    </div>
  );
}

function formatInviteState(state: "active" | "accepted" | "expired" | "revoked") {
  return t(`companyInvites.state.${state}`);
}

function formatInviteAudience(invite: Awaited<ReturnType<typeof accessApi.listInvites>>["invites"][number]) {
  if (invite.allowedJoinTypes === "agent") return t("companyInvites.audience.agent");
  if (invite.allowedJoinTypes === "both") return invite.humanRole ? t("companyInvites.audience.humanOrAgentRole", { role: invite.humanRole }) : t("companyInvites.audience.humanOrAgent");
  return invite.humanRole ?? t("companyInvites.audience.human");
}
