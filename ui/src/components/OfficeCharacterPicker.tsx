import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, RefreshCw } from "lucide-react";
import type { Agent } from "@paperclipai/shared";
import { useTranslation } from "@/i18n";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { agentsApi } from "../api/agents";
import { queryKeys } from "../lib/queryKeys";
import { resolveGender } from "../lib/office-avatars";
import {
  CATALOG,
  CATALOG_MANIFEST_URL,
  bustCache,
  resolveAgentCharacterId,
  type CatalogManifest,
  type CatalogCharacter,
} from "../lib/office-sprite-catalog";
import { cn } from "../lib/utils";

// The 造型 picker: choose which catalog character an agent shows on the Virtual
// Office floor. Renders the real directional sprite (south.png) once generated,
// falling back to the entry's emoji so the picker is useful before any art lands.
export function OfficeCharacterPicker({ agent, companyId, open, onClose }: {
  agent: Agent | null;
  companyId: string;
  open: boolean;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const zh = (i18n.language || "").toLowerCase().startsWith("zh");

  const [manifest, setManifest] = useState<CatalogManifest>({});
  useEffect(() => {
    if (!open) return;
    let alive = true;
    fetch(bustCache(CATALOG_MANIFEST_URL))
      .then((r) => (r.ok ? r.json() : {}))
      .then((m) => { if (alive) setManifest(m ?? {}); })
      .catch(() => {});
    return () => { alive = false; };
  }, [open]);

  const currentId = agent ? resolveAgentCharacterId(agent, resolveGender(agent)) : "male";

  const save = useMutation({
    mutationFn: (characterId: string) => agentsApi.setOfficeCharacter(agent!.id, characterId, companyId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) });
      onClose();
    },
  });

  const groups = useMemo(() => ({
    people: CATALOG.filter((c) => c.group === "people"),
    animals: CATALOG.filter((c) => c.group === "animals"),
  }), []);

  if (!agent) return null;

  const label = (c: CatalogCharacter) => (zh ? c.zh : c.en);

  const Tile = ({ c }: { c: CatalogCharacter }) => {
    const south = manifest[c.id]?.south;
    const selected = c.id === currentId;
    return (
      <button
        type="button"
        disabled={save.isPending}
        onClick={() => save.mutate(c.id)}
        title={label(c)}
        className={cn(
          "group relative flex flex-col items-center gap-1 rounded-lg border p-2 transition",
          "hover:border-primary hover:bg-accent disabled:opacity-50",
          selected ? "border-primary ring-2 ring-primary/40 bg-accent" : "border-border",
        )}
      >
        <div className="flex h-16 w-16 items-center justify-center overflow-hidden">
          {south ? (
            <img
              src={south}
              alt={label(c)}
              draggable={false}
              className="h-full w-full select-none object-contain"
              style={{ imageRendering: "pixelated" }}
            />
          ) : (
            <span className="text-4xl leading-none">{c.emoji}</span>
          )}
        </div>
        <span className="max-w-[80px] truncate text-[11px] text-muted-foreground">{label(c)}</span>
        {selected && (
          <span className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <Check className="h-3 w-3" />
          </span>
        )}
      </button>
    );
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t("office.pickCharacter", { defaultValue: "Choose a character" })}
            {save.isPending && <RefreshCw className="ml-2 inline h-4 w-4 animate-spin" />}
          </DialogTitle>
        </DialogHeader>
        <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
          <div>
            <div className="mb-2 text-xs font-semibold text-muted-foreground">
              {t("office.people", { defaultValue: "People" })}
            </div>
            <div className="grid grid-cols-4 gap-2 sm:grid-cols-5">
              {groups.people.map((c) => <Tile key={c.id} c={c} />)}
            </div>
          </div>
          <div>
            <div className="mb-2 text-xs font-semibold text-muted-foreground">
              {t("office.animals", { defaultValue: "Animals" })}
            </div>
            <div className="grid grid-cols-4 gap-2 sm:grid-cols-5">
              {groups.animals.map((c) => <Tile key={c.id} c={c} />)}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
