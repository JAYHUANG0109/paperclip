import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Lightbulb, Plus, Clock, X } from "lucide-react";
import { useTranslation } from "@/i18n";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { bountiesApi, type Bounty, type BountyStatus } from "../api/bounties";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

const COLUMNS: { status: BountyStatus; dot: string }[] = [
  { status: "open", dot: "bg-emerald-500" },
  { status: "claimed", dot: "bg-amber-500" },
  { status: "done", dot: "bg-sky-500" },
];

export function Bounties() {
  const { t } = useTranslation();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [estMinutes, setEstMinutes] = useState(0);

  useEffect(() => {
    setBreadcrumbs([{ label: t("bounties.title", { defaultValue: "Bounty Board" }) }]);
  }, [setBreadcrumbs, t]);

  const { data: bounties } = useQuery({
    queryKey: ["bounties", selectedCompanyId],
    queryFn: () => bountiesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["bounties", selectedCompanyId] });
  const create = useMutation({
    mutationFn: () => bountiesApi.create(selectedCompanyId!, { title, description, estimatedMinutes: estMinutes }),
    onSuccess: () => { invalidate(); setCreateOpen(false); setTitle(""); setDescription(""); setEstMinutes(0); },
  });
  const claim = useMutation({ mutationFn: (id: string) => bountiesApi.claim(selectedCompanyId!, id), onSuccess: invalidate });
  const complete = useMutation({ mutationFn: (id: string) => bountiesApi.complete(selectedCompanyId!, id), onSuccess: invalidate });
  const remove = useMutation({ mutationFn: (id: string) => bountiesApi.remove(selectedCompanyId!, id), onSuccess: invalidate });

  const byStatus = (status: BountyStatus) => (bounties ?? []).filter((b) => b.status === status);

  return (
    <div className="w-full max-w-6xl space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/40">
            <Lightbulb className="h-5 w-5 text-amber-500" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">{t("bounties.title", { defaultValue: "Bounty Board" })}</h1>
            <p className="max-w-2xl text-sm text-muted-foreground">{t("bounties.subtitle", { defaultValue: "Post work for trainers to claim." })}</p>
          </div>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="mr-1.5 h-4 w-4" />
          {t("bounties.post", { defaultValue: "Post a bounty" })}
        </Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {COLUMNS.map((col) => {
          const items = byStatus(col.status);
          return (
            <div key={col.status} className="space-y-3">
              <div className="flex items-center gap-2">
                <span className={`h-2.5 w-2.5 rounded-full ${col.dot}`} />
                <span className="text-sm font-semibold">{t(`bounties.${col.status}`, { defaultValue: col.status })}</span>
                <span className="text-xs text-muted-foreground">{items.length}</span>
              </div>
              <div className="space-y-3">
                {items.map((b) => (
                  <BountyCard
                    key={b.id}
                    bounty={b}
                    onClaim={() => claim.mutate(b.id)}
                    onComplete={() => complete.mutate(b.id)}
                    onRemove={() => remove.mutate(b.id)}
                  />
                ))}
                {items.length === 0 && (
                  <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
                    {t("bounties.empty", { defaultValue: "No bounties yet." })}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("bounties.post", { defaultValue: "Post a bounty" })}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("bounties.newTitle", { defaultValue: "What do you need automated?" })}
            />
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("bounties.newDescription", { defaultValue: "Describe the task and what 'done' looks like." })}
              className="min-h-24"
            />
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={0}
                value={estMinutes || ""}
                onChange={(e) => setEstMinutes(Math.max(0, Number(e.target.value) || 0))}
                placeholder="0"
                className="w-28"
              />
              <span className="text-xs text-muted-foreground">{t("bounties.estMinutes", { defaultValue: "Estimated minutes" })}</span>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" onClick={() => setCreateOpen(false)}>{t("bounties.cancel", { defaultValue: "Cancel" })}</Button>
              <Button onClick={() => create.mutate()} disabled={!title.trim() || create.isPending}>
                {t("bounties.create", { defaultValue: "Post" })}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function BountyCard({ bounty, onClaim, onComplete, onRemove }: {
  bounty: Bounty;
  onClaim: () => void;
  onComplete: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="group rounded-lg border border-border p-3.5 transition-colors hover:border-primary/40">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1 text-sm font-medium">{bounty.title}</div>
        {bounty.estimatedMinutes > 0 && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
            <Clock className="h-3 w-3" />~{bounty.estimatedMinutes}{t("bounties.minutesShort", { defaultValue: "m" })}
          </span>
        )}
      </div>
      {bounty.description && <p className="mt-1.5 line-clamp-3 text-xs text-muted-foreground">{bounty.description}</p>}
      <div className="mt-2.5 flex items-center gap-2 text-[11px] text-muted-foreground">
        {bounty.postedByName && <span>{t("bounties.postedBy", { defaultValue: "Posted by" })} {bounty.postedByName}</span>}
        {bounty.claimedByName && <span>· {t("bounties.claimedBy", { defaultValue: "Claimed by" })} {bounty.claimedByName}</span>}
      </div>
      <div className="mt-3 flex items-center gap-2">
        {bounty.status === "open" && (
          <Button size="sm" variant="outline" className="flex-1" onClick={onClaim}>{t("bounties.claim", { defaultValue: "Claim it" })}</Button>
        )}
        {bounty.status === "claimed" && (
          <Button size="sm" className="flex-1" onClick={onComplete}>{t("bounties.complete", { defaultValue: "Mark complete" })}</Button>
        )}
        <button type="button" onClick={onRemove} className="text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
