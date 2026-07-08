import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SecretStatus, UserSecretDefinition } from "@paperclipai/shared";
import { AlertCircle, Pencil, Plus, Trash2, UserRound, Users } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "../../components/EmptyState";
import { secretsApi } from "../../api/secrets";
import { ApiError } from "../../api/client";
import { queryKeys } from "../../lib/queryKeys";
import { cn } from "../../lib/utils";
import { useToastActions } from "../../context/ToastContext";
import { t } from "@/i18n";
import {
  coverageSummaryLabel,
  myValueTone,
  secretStatusTone,
  UserSecretChip,
} from "./user-secret-presentation";
import type { UserSecretCoverageMemberStatus } from "@paperclipai/shared";

function keyFromName(name: string): string {
  return name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
}

interface DefinitionForm {
  name: string;
  key: string;
  description: string;
  usageGuidance: string;
  status: SecretStatus;
}

const emptyForm: DefinitionForm = {
  name: "",
  key: "",
  description: "",
  usageGuidance: "",
  status: "active",
};

/**
 * Secrets → User secret definitions tab (admin). Defines the shared credentials
 * that each member fills in with their own value. Coverage is shown as counts
 * only — never values — per the UX terminology decisions.
 */
export function UserSecretDefinitionsTab({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<UserSecretDefinition | null>(null);
  const [form, setForm] = useState<DefinitionForm>(emptyForm);
  const [keyDirty, setKeyDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<UserSecretDefinition | null>(null);

  const definitionsQuery = useQuery({
    queryKey: queryKeys.secrets.userDefinitions(companyId),
    queryFn: () => secretsApi.listUserSecretDefinitions(companyId),
  });
  const definitions = definitionsQuery.data ?? [];

  function openCreate() {
    setEditing(null);
    setForm(emptyForm);
    setKeyDirty(false);
    setError(null);
    setDialogOpen(true);
  }

  function openEdit(definition: UserSecretDefinition) {
    setEditing(definition);
    setForm({
      name: definition.name,
      key: definition.key,
      description: definition.description ?? "",
      usageGuidance: definition.usageGuidance ?? "",
      status: definition.status,
    });
    setKeyDirty(true);
    setError(null);
    setDialogOpen(true);
  }

  const save = useMutation({
    mutationFn: async () => {
      const sharedPayload = {
        name: form.name.trim(),
        description: form.description.trim() || null,
        usageGuidance: form.usageGuidance.trim() || null,
      };
      if (editing) {
        return secretsApi.updateUserSecretDefinition(companyId, editing.id, {
          ...sharedPayload,
          status: form.status,
        });
      }
      return secretsApi.createUserSecretDefinition(companyId, {
        ...sharedPayload,
        key: form.key.trim(),
        status: form.status === "deleted" ? "active" : form.status,
      });
    },
    onSuccess: (definition) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.userDefinitions(companyId) });
      pushToast({
        title: editing
          ? t("secrets.userSecrets.definitionUpdated")
          : t("secrets.userSecrets.definitionCreated"),
        body: definition.name,
        tone: "success",
      });
      setDialogOpen(false);
    },
    onError: (err) =>
      setError(
        err instanceof ApiError || err instanceof Error
          ? err.message
          : t("secrets.userSecrets.failedToSave"),
      ),
  });

  const remove = useMutation({
    mutationFn: (definition: UserSecretDefinition) =>
      secretsApi.removeUserSecretDefinition(companyId, definition.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.userDefinitions(companyId) });
      pushToast({ title: t("secrets.userSecrets.definitionRemoved"), tone: "info" });
      setDeleteTarget(null);
    },
    onError: (err) =>
      pushToast({
        title: t("secrets.userSecrets.couldNotRemoveDefinition"),
        body: err instanceof Error ? err.message : undefined,
        tone: "error",
      }),
  });

  const canSave = form.name.trim().length > 0 && form.key.trim().length > 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
      <div className="flex items-start gap-2 rounded-md border border-violet-500/30 bg-violet-500/5 px-4 py-3 text-xs text-violet-800 dark:text-violet-200">
        <UserRound className="h-4 w-4 mt-0.5 shrink-0" />
        <p>{t("secrets.userSecrets.definitionsBanner")}</p>
      </div>

      <div className="flex items-center justify-end">
        <Button size="sm" onClick={openCreate}>
          <Plus className="mr-1 h-3.5 w-3.5" /> {t("secrets.userSecrets.newUserSecret")}
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {definitionsQuery.isError ? (
          <div className="flex items-center gap-2 py-4 text-sm text-destructive">
            <AlertCircle className="h-4 w-4" /> {t("secrets.userSecrets.failedToLoadDefinitions")}{" "}
            {(definitionsQuery.error as Error).message}
            <Button variant="ghost" size="sm" onClick={() => definitionsQuery.refetch()}>
              {t("secrets.userSecrets.retry")}
            </Button>
          </div>
        ) : definitions.length === 0 && !definitionsQuery.isPending ? (
          <EmptyState
            icon={UserRound}
            message={t("secrets.userSecrets.definitionsEmpty")}
            action={t("secrets.userSecrets.newUserSecret")}
            onAction={openCreate}
          />
        ) : (
          <ul className="space-y-2">
            {definitions.map((definition) => (
              <li
                key={definition.id}
                className="flex items-start gap-3 rounded-md border border-border p-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-foreground">{definition.name}</span>
                    <code className="rounded bg-muted px-1.5 py-0.5 text-(length:--text-micro) text-muted-foreground">
                      {definition.key}
                    </code>
                    <UserSecretChip />
                    <Badge
                      variant="outline"
                      className={cn("text-(length:--text-micro)", secretStatusTone(definition.status))}
                    >
                      {definition.status}
                    </Badge>
                  </div>
                  {definition.description ? (
                    <p className="mt-1 text-xs text-muted-foreground">{definition.description}</p>
                  ) : null}
                  <CoverageBadge companyId={companyId} definitionId={definition.id} />
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button size="sm" variant="ghost" onClick={() => openEdit(definition)}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => setDeleteTarget(definition)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Create / edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {editing
                ? t("secrets.userSecrets.editUserSecret")
                : t("secrets.userSecrets.newUserSecret")}
              <UserSecretChip />
            </DialogTitle>
            <DialogDescription>
              {t("secrets.userSecrets.dialogDescription")}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-foreground">{t("secrets.userSecrets.nameLabel")}</label>
              <Input
                value={form.name}
                onChange={(event) => {
                  const name = event.target.value;
                  setForm((current) => ({
                    ...current,
                    name,
                    key: keyDirty ? current.key : keyFromName(name),
                  }));
                }}
                placeholder={t("secrets.userSecrets.namePlaceholder")}
                autoFocus
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-foreground">{t("secrets.userSecrets.keyLabel")}</label>
              <Input
                value={form.key}
                onChange={(event) => {
                  setKeyDirty(true);
                  setForm((current) => ({ ...current, key: event.target.value }));
                }}
                placeholder={t("secrets.userSecrets.keyPlaceholder")}
                className="font-mono text-sm"
                disabled={Boolean(editing)}
              />
              <p className="text-(length:--text-micro) text-muted-foreground">
                {t("secrets.userSecrets.keyHint")} {editing ? t("secrets.userSecrets.keyHintCannotChange") : ""}
              </p>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-foreground">{t("secrets.userSecrets.descriptionLabel")}</label>
              <Input
                value={form.description}
                onChange={(event) =>
                  setForm((current) => ({ ...current, description: event.target.value }))
                }
                placeholder={t("secrets.userSecrets.descriptionPlaceholder")}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-foreground">
                {t("secrets.userSecrets.usageGuidanceLabel")} <span className="text-muted-foreground">{t("secrets.userSecrets.usageGuidanceOptional")}</span>
              </label>
              <Textarea
                value={form.usageGuidance}
                onChange={(event) =>
                  setForm((current) => ({ ...current, usageGuidance: event.target.value }))
                }
                placeholder={t("secrets.userSecrets.usageGuidancePlaceholder")}
                className="min-h-(--sz-70px) text-sm"
              />
            </div>
            {editing ? (
              <div className="space-y-1">
                <label className="text-xs font-medium text-foreground">{t("secrets.userSecrets.statusLabel")}</label>
                <Select
                  value={form.status}
                  onValueChange={(status) =>
                    setForm((current) => ({ ...current, status: status as SecretStatus }))
                  }
                >
                  <SelectTrigger className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">{t("secrets.userSecrets.statusActive")}</SelectItem>
                    <SelectItem value="disabled">{t("secrets.userSecrets.statusDisabled")}</SelectItem>
                    <SelectItem value="archived">{t("secrets.userSecrets.statusArchived")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogOpen(false)} disabled={save.isPending}>
              {t("secrets.userSecrets.cancel")}
            </Button>
            <Button onClick={() => save.mutate()} disabled={!canSave || save.isPending}>
              {save.isPending
                ? t("secrets.userSecrets.saving")
                : editing
                  ? t("secrets.userSecrets.saveChanges")
                  : t("secrets.userSecrets.create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <Dialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("secrets.userSecrets.removeUserSecret")}</DialogTitle>
            <DialogDescription>
              {t("secrets.userSecrets.removeDialogPrefix")}{" "}
              <span className="font-mono">{deleteTarget?.key}</span>{" "}
              {t("secrets.userSecrets.removeDialogSuffix")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)} disabled={remove.isPending}>
              {t("secrets.userSecrets.cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteTarget && remove.mutate(deleteTarget)}
              disabled={remove.isPending}
            >
              {remove.isPending ? t("secrets.userSecrets.removing") : t("secrets.userSecrets.remove")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CoverageBadge({
  companyId,
  definitionId,
}: {
  companyId: string;
  definitionId: string;
}) {
  const coverageQuery = useQuery({
    queryKey: queryKeys.secrets.userDefinitionCoverage(companyId, definitionId),
    queryFn: () => secretsApi.userSecretDefinitionCoverage(companyId, definitionId),
    staleTime: 30_000,
  });
  const summary = coverageQuery.data;
  const missing = summary ? summary.missingCount : 0;
  const members = summary?.members ?? [];
  return (
    <div className="mt-1">
      <p className="inline-flex items-center gap-1 text-(length:--text-micro) text-muted-foreground">
        <Users className="h-3 w-3" />
        {t("secrets.userSecrets.coverage")} {coverageSummaryLabel(summary)}
        {summary && missing > 0 ? (
          <span className="text-amber-600 dark:text-amber-400">· {t("secrets.userSecrets.notSet", { count: missing })}</span>
        ) : null}
      </p>
      {members.length > 0 ? (
        <div className="mt-2 rounded-md border border-border/60 bg-muted/30 p-2">
          <p className="mb-1.5 text-(length:--text-micro) font-medium text-muted-foreground">
            {t("secrets.userSecrets.coverageMembersTitle")}
          </p>
          <ul className="space-y-1">
            {members.map((member) => (
              <li key={member.userId} className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate text-(length:--text-micro) text-foreground">
                  {member.name}
                  <span className="ml-1 text-muted-foreground">{member.email}</span>
                </span>
                <Badge
                  variant="outline"
                  className={cn("shrink-0 text-(length:--text-micro)", myValueTone(member.status))}
                >
                  {coverageMemberStatusLabel(member.status)}
                </Badge>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function coverageMemberStatusLabel(status: UserSecretCoverageMemberStatus): string {
  switch (status) {
    case "set":
      return t("secrets.userSecrets.coverageMemberSet");
    case "inactive":
      return t("secrets.userSecrets.coverageMemberInactive");
    case "not_set":
      return t("secrets.userSecrets.coverageMemberNotSet");
  }
}
