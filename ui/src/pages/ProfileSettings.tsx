import { useEffect, useId, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Camera, Check, Copy, KeyRound, LoaderCircle, Save, Trash2, UserRoundPen } from "lucide-react";
import type { AuthSession, CurrentUserProfile, UpdateCurrentUserProfile } from "@paperclipai/shared";
import { useTranslation } from "@/i18n";
import { authApi } from "@/api/auth";
import { boardKeysApi, type BoardApiKeyWithToken } from "@/api/board-keys";
import { assetsApi } from "@/api/assets";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { InboxAgentPolicyControl } from "@/components/InboxAgentPolicyControl";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { copyTextToClipboard } from "@/lib/clipboard";

function deriveInitials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0]?.[0] ?? ""}${parts[parts.length - 1]?.[0] ?? ""}`.toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

export function ProfileSettings() {
  const { t } = useTranslation();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { selectedCompanyId, selectedCompany } = useCompany();
  const queryClient = useQueryClient();
  const avatarInputId = useId();
  const avatarInputRef = useRef<HTMLInputElement | null>(null);
  const [name, setName] = useState("");
  const [image, setImage] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const sessionQuery = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: t("settings.profile.breadcrumbInstance") },
      { label: t("settings.profile.breadcrumbProfile") },
    ]);
  }, [setBreadcrumbs, t]);

  useEffect(() => {
    const session = sessionQuery.data;
    if (!session) return;
    setName(session.user.name ?? "");
    setImage(session.user.image ?? "");
  }, [sessionQuery.data]);

  function syncSessionProfile(profile: CurrentUserProfile) {
    queryClient.setQueryData<AuthSession | null>(queryKeys.auth.session, (current) => {
      if (!current) return current;
      return {
        ...current,
        user: {
          ...current.user,
          ...profile,
        },
      };
    });
  }

  async function persistProfile(input: UpdateCurrentUserProfile) {
    const profile = await authApi.updateProfile(input);
    syncSessionProfile(profile);
    return profile;
  }

  function resolveProfileName() {
    return name.trim() || sessionQuery.data?.user.name || "Board";
  }

  const updateMutation = useMutation({
    mutationFn: (input: UpdateCurrentUserProfile) => persistProfile(input),
    onSuccess: (profile) => {
      setActionError(null);
      setName(profile.name ?? "");
      setImage(profile.image ?? "");
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : t("settings.profile.failedToUpdate"));
    },
  });

  const uploadAvatarMutation = useMutation({
    mutationFn: async (file: File) => {
      if (!selectedCompanyId) {
        throw new Error(t("settings.profile.selectCompanyToUpload"));
      }

      const asset = await assetsApi.uploadImage(
        selectedCompanyId,
        file,
        `profiles/${sessionQuery.data?.user.id ?? "board-user"}`,
      );
      return persistProfile({ name: resolveProfileName(), image: asset.contentPath });
    },
    onSuccess: (profile) => {
      setActionError(null);
      setName(profile.name ?? "");
      setImage(profile.image ?? "");
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : t("settings.profile.failedToUpload"));
    },
  });

  const removeAvatarMutation = useMutation({
    mutationFn: () => persistProfile({ name: resolveProfileName(), image: null }),
    onSuccess: (profile) => {
      setActionError(null);
      setName(profile.name ?? "");
      setImage(profile.image ?? "");
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : t("settings.profile.failedToRemove"));
    },
  });

  if (sessionQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">{t("settings.profile.loading")}</div>;
  }

  if (sessionQuery.error || !sessionQuery.data) {
    return (
      <div className="text-sm text-destructive">
        {sessionQuery.error instanceof Error ? sessionQuery.error.message : t("settings.profile.failedToLoad")}
      </div>
    );
  }

  const currentName = name.trim() || sessionQuery.data.user.name || t("settings.profile.defaultName");
  const currentImage = image.trim() || null;
  const initials = deriveInitials(currentName);
  const isSavingProfile = updateMutation.isPending || uploadAvatarMutation.isPending || removeAvatarMutation.isPending;
  const uploadHint = selectedCompany
    ? t("settings.profile.uploadHintStored", { name: selectedCompany.name })
    : t("settings.profile.uploadHintSelect");

  return (
    <div className="max-w-4xl space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <UserRoundPen className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">{t("settings.profile.title")}</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          {t("settings.profile.subtitle")}
        </p>
      </div>

      {actionError ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {actionError}
        </div>
      ) : null}

      <section className="space-y-8">
        <Card className="block relative overflow-hidden rounded-(--rad-28) border-border/70">
          <div className="absolute inset-x-0 top-0 h-32 bg-(image:--gradient-extract-26)" />
          <div className="absolute inset-0 bg-(image:--gradient-extract-7)" />
          <div className="relative p-6 pt-10">
            <div className="flex flex-wrap items-end gap-5 rounded-(--rad-24) border border-border/70 bg-background/92 p-5 shadow-(--shadow-extract-18) backdrop-blur-sm">
              <div className="space-y-3">
                <label
                  htmlFor={avatarInputId}
                  className="group relative block cursor-pointer rounded-full focus-within:outline-none focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-background"
                >
                  <input
                    ref={avatarInputRef}
                    id={avatarInputId}
                    type="file"
                    accept="image/*"
                    className="sr-only"
                    disabled={!selectedCompanyId || isSavingProfile}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (!file) return;
                      uploadAvatarMutation.mutate(file);
                      event.target.value = "";
                    }}
                  />
                  <span className="absolute inset-0 z-10 rounded-full bg-black/0 transition-colors group-hover:bg-black/14 group-focus-within:bg-black/14" />
                  <span className="absolute bottom-1 right-1 z-20 flex size-9 items-center justify-center rounded-full border border-background bg-primary text-primary-foreground shadow-sm">
                    {uploadAvatarMutation.isPending ? <LoaderCircle className="size-4 animate-spin" /> : <Camera className="size-4" />}
                  </span>
                  <Avatar size="lg" className="data-[size=lg]:size-24 ring-4 ring-background shadow-xl">
                    {currentImage ? <AvatarImage src={currentImage} alt={currentName} /> : null}
                    <AvatarFallback>{initials}</AvatarFallback>
                  </Avatar>
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => avatarInputRef.current?.click()}
                    disabled={!selectedCompanyId || isSavingProfile}
                  >
                    {uploadAvatarMutation.isPending ? <LoaderCircle className="size-4 animate-spin" /> : <Camera className="size-4" />}
                    {currentImage ? t("settings.profile.changePhoto") : t("settings.profile.uploadPhoto")}
                  </Button>
                  {currentImage ? (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => removeAvatarMutation.mutate()}
                      disabled={isSavingProfile}
                    >
                      {removeAvatarMutation.isPending ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                      {t("settings.profile.remove")}
                    </Button>
                  ) : null}
                </div>
              </div>

              <div className="min-w-0 flex-1 space-y-2 pb-1">
                <div>
                  <h2 className="truncate text-2xl font-semibold text-foreground">{currentName}</h2>
                  <p className="truncate text-sm text-muted-foreground">{sessionQuery.data.user.email ?? t("settings.profile.noEmail")}</p>
                </div>
                <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
                  {t("settings.profile.clickAvatar")} {uploadHint}
                </p>
              </div>
            </div>
          </div>
        </Card>

        <form
          className="grid gap-6 md:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            updateMutation.mutate({ name: resolveProfileName(), image: image.trim() || null });
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="profile-name">{t("settings.profile.displayNameLabel")}</Label>
            <Input
              id="profile-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={120}
              placeholder={t("settings.profile.displayNamePlaceholder")}
            />
            <p className="text-xs text-muted-foreground">
              {t("settings.profile.displayNameHint")}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="profile-email">{t("settings.profile.emailLabel")}</Label>
            <Input
              id="profile-email"
              value={sessionQuery.data.user.email ?? ""}
              readOnly
              disabled
            />
            <p className="text-xs text-muted-foreground">
              {t("settings.profile.emailHint")}
            </p>
          </div>

          <div className="md:col-span-2 flex justify-end">
            <Button type="submit" disabled={isSavingProfile || !name.trim()}>
              {updateMutation.isPending ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
              {updateMutation.isPending ? t("settings.profile.saving") : t("settings.profile.saveProfile")}
            </Button>
          </div>
        </form>

        <Card className="rounded-(--rad-28) border-border/70 p-6">
          <InboxAgentPolicyControl companyId={selectedCompanyId} />
        </Card>

        <Card className="rounded-(--rad-28) border-border/70 p-6">
          <PersonalApiKeys />
        </Card>
      </section>
    </div>
  );
}

/**
 * Personal (user/board) API keys. A key here authenticates API calls AS the
 * signed-in user — her permissions, her audit trail — so her own tools (e.g.
 * Claude) can drive the platform on her behalf, including editing an agent's
 * harness that a narrow agent key cannot. The token shows once; holders act as
 * her, so revoke is the control.
 */
function PersonalApiKeys() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [justCreated, setJustCreated] = useState<BoardApiKeyWithToken | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const keysQuery = useQuery({
    queryKey: ["board-api-keys"],
    queryFn: () => boardKeysApi.list(),
    retry: false,
  });

  const createMutation = useMutation({
    mutationFn: () => boardKeysApi.create({ name: name.trim() || "personal" }),
    onSuccess: (key) => {
      setError(null);
      setJustCreated(key);
      setCopied(false);
      setName("");
      queryClient.invalidateQueries({ queryKey: ["board-api-keys"] });
    },
    onError: (e) => setError(e instanceof Error ? e.message : t("settings.apiKeys.createFailed", { defaultValue: "無法建立金鑰，請稍後再試。" })),
  });

  const revokeMutation = useMutation({
    mutationFn: (keyId: string) => boardKeysApi.revoke(keyId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["board-api-keys"] }),
    onError: (e) => setError(e instanceof Error ? e.message : t("settings.apiKeys.revokeFailed", { defaultValue: "無法撤銷金鑰。" })),
  });

  async function copyToken() {
    if (!justCreated) return;
    try {
      await copyTextToClipboard(justCreated.token);
      setCopied(true);
    } catch { /* clipboard may be blocked; the token stays visible to copy manually */ }
  }

  const keys = keysQuery.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <KeyRound className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">{t("settings.apiKeys.title", { defaultValue: "API 金鑰（個人）" })}</h2>
      </div>
      <p className="text-xs text-muted-foreground">
        {t("settings.apiKeys.subtitle", {
          defaultValue: "以你的身分呼叫 Paperclip API — 擁有你在介面上的全部權限（包含編輯代理人的技能與指示）。持有金鑰者即以你的身分操作，請妥善保管；不需要時請撤銷。",
        })}
      </p>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">{error}</div>
      ) : null}

      {justCreated ? (
        <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
          <p className="text-xs font-medium text-amber-600 dark:text-amber-400">
            {t("settings.apiKeys.copyNow", { defaultValue: "已建立金鑰 — 請立即複製，將不會再次顯示。" })}
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate rounded bg-background px-2 py-1.5 font-mono text-xs">{justCreated.token}</code>
            <Button type="button" size="sm" variant="secondary" className="h-8 shrink-0 gap-1" onClick={copyToken}>
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              {copied ? t("settings.apiKeys.copied", { defaultValue: "已複製" }) : t("settings.apiKeys.copy", { defaultValue: "複製" })}
            </Button>
          </div>
          <button type="button" className="text-[11px] text-muted-foreground hover:underline" onClick={() => setJustCreated(null)}>
            {t("settings.apiKeys.dismiss", { defaultValue: "關閉" })}
          </button>
        </div>
      ) : null}

      <div className="flex gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={120}
          placeholder={t("settings.apiKeys.namePlaceholder", { defaultValue: "金鑰名稱（例如：我的 Claude）" })}
          className="h-9"
          onKeyDown={(e) => { if (e.key === "Enter" && !createMutation.isPending) createMutation.mutate(); }}
        />
        <Button type="button" className="h-9 shrink-0 gap-1" disabled={createMutation.isPending} onClick={() => createMutation.mutate()}>
          {createMutation.isPending ? <LoaderCircle className="size-4 animate-spin" /> : <KeyRound className="size-4" />}
          {t("settings.apiKeys.create", { defaultValue: "建立" })}
        </Button>
      </div>

      {keys.length > 0 ? (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {keys.map((k) => (
            <li key={k.id} className="flex items-center gap-2 px-3 py-2">
              <KeyRound className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-sm">{k.name}</span>
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {k.lastUsedAt
                  ? t("settings.apiKeys.lastUsed", { defaultValue: "最近使用 {{date}}", date: new Date(k.lastUsedAt).toLocaleDateString() })
                  : t("settings.apiKeys.neverUsed", { defaultValue: "尚未使用" })}
              </span>
              {/* Keys created from 2026-09-05 on never expire, so this renders
                  only for the older TTL keys (and any created with an explicit
                  expiry). Before this, an expiry was invisible here — and an
                  aged-out key dropped out of the list entirely — so the first
                  sign of trouble was a bare 401. */}
              {k.expiresAt ? (
                <span
                  className={`shrink-0 text-[11px] ${
                    new Date(k.expiresAt).getTime() <= Date.now() ? "text-destructive" : "text-amber-600 dark:text-amber-400"
                  }`}
                >
                  {new Date(k.expiresAt).getTime() <= Date.now()
                    ? t("settings.apiKeys.expired", { defaultValue: "已過期" })
                    : t("settings.apiKeys.expiresOn", {
                        defaultValue: "{{date}} 到期",
                        date: new Date(k.expiresAt).toLocaleDateString(),
                      })}
                </span>
              ) : null}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 shrink-0 gap-1 text-xs text-destructive hover:text-destructive"
                disabled={revokeMutation.isPending}
                onClick={() => revokeMutation.mutate(k.id)}
              >
                <Trash2 className="size-3.5" />
                {t("settings.apiKeys.revoke", { defaultValue: "撤銷" })}
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">{t("settings.apiKeys.none", { defaultValue: "尚無個人金鑰。" })}</p>
      )}
    </div>
  );
}
