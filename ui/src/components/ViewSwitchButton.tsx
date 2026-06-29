import type { ComponentType } from "react";
import { Link } from "@/lib/router";
import { cn } from "../lib/utils";

/**
 * The single style for switching between the Agents (browse) view and the
 * Virtual Office view. Used on BOTH pages so the control looks identical and
 * lives in the same place (the right side of the controls row under the page
 * header) — users always find it where they expect.
 */
export function ViewSwitchButton({
  to,
  label,
  icon: Icon,
  className,
}: {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  className?: string;
}) {
  return (
    <Link
      to={to}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
        className,
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </Link>
  );
}
