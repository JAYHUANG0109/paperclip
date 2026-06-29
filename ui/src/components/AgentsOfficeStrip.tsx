import { useState } from "react";
import { Link } from "@/lib/router";
import { Building2, ChevronDown, Zap } from "lucide-react";
import { useTranslation } from "@/i18n";
import { OfficeAvatar } from "./OfficeAvatar";
import { agentUrl, cn } from "../lib/utils";
import type { Agent } from "@paperclipai/shared";

/**
 * Compact "Virtual Office" hero shown at the top of the Agents page. Reuses the
 * office avatars but in a space-light strip: collapsed = a single horizontal
 * scrolling row; expanded = a wrapped grid of everyone. A link jumps to the full
 * animated office (/office). Data is passed in from the Agents page (already
 * loaded under the shared cache keys) so this adds no extra fetches.
 */
export function AgentsOfficeStrip({
  agents,
  workingIds,
}: {
  agents: Agent[];
  workingIds: Set<string>;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  if (agents.length === 0) return null;
  const workingCount = agents.reduce((n, a) => n + (workingIds.has(a.id) ? 1 : 0), 0);

  return (
    <div className="rounded-xl border border-border bg-[repeating-linear-gradient(45deg,hsl(var(--muted)/0.18)_0_12px,transparent_12px_24px)]">
      <div className="flex items-center justify-between gap-2 px-4 py-2.5">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Building2 className="h-4 w-4 text-muted-foreground" />
          <span>{t("office.title", { defaultValue: "Virtual Office" })}</span>
          <span className="text-xs font-normal text-muted-foreground">
            · {agents.length} {t("office.colleagues", { defaultValue: "colleagues" })}
            {workingCount > 0 ? (
              <span className="text-emerald-500"> · {workingCount} {t("office.working", { defaultValue: "Working" })}</span>
            ) : null}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-expanded={expanded}
          >
            <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", expanded && "rotate-180")} />
            {expanded ? t("common.collapse", { defaultValue: "Collapse" }) : t("common.expand", { defaultValue: "Expand" })}
          </button>
        </div>
      </div>

      <div
        className={cn(
          "px-3 pb-3",
          expanded
            ? "flex flex-wrap gap-x-2 gap-y-3"
            : "flex gap-2 overflow-x-auto [scrollbar-width:thin]",
        )}
      >
        {agents.map((agent) => {
          const working = workingIds.has(agent.id);
          return (
            <Link
              key={agent.id}
              to={agentUrl(agent)}
              title={agent.name}
              className="group flex w-[68px] shrink-0 flex-col items-center gap-1 rounded-lg p-1.5 text-center transition-colors hover:bg-accent/50"
            >
              <div className="relative h-10 w-10">
                <div
                  className={cn(
                    "absolute inset-0 rounded-full border bg-background",
                    working ? "border-emerald-400/70" : "border-border",
                  )}
                />
                <div className="absolute inset-x-0 -top-1.5 flex justify-center">
                  <OfficeAvatar agent={agent} size={44} animated={false} />
                </div>
                {working && (
                  <span className="absolute -right-0.5 -top-0.5 z-10 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-emerald-500 text-white">
                    <Zap className="h-2 w-2" />
                  </span>
                )}
              </div>
              <span className="w-full truncate text-[10px] leading-tight text-foreground/80">
                {agent.name}
              </span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
