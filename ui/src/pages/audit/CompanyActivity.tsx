import { useCallback, useEffect } from "react";
import { History } from "lucide-react";
import { useSearchParams } from "@/lib/router";
import { Tabs } from "@/components/ui/tabs";
import { useTranslation } from "@/i18n";
import { useCompany } from "../../context/CompanyContext";
import { useBreadcrumbs } from "../../context/BreadcrumbContext";
import { EmptyState } from "../../components/EmptyState";
import { PageTabBar } from "../../components/PageTabBar";
import { Activity } from "../Activity";
import { AuditFeed } from "./AuditFeed";

export type CompanyActivityMode = "all" | "agents";

/**
 * The single company activity surface: one page, two tiers.
 *
 * This is the fork's answer to upstream's `8142e5415` (merge the audit page into
 * one rich Activity page). We adopt the consolidation — one nav destination, one
 * URL, `?mode=` so links stay shareable and `/audit` can deep-link straight to
 * the privileged tier — but not upstream's implementation, which deleted the
 * activity list outright and replaced it with an all-actors feed inside
 * `AuditFeed`.
 *
 * We keep both feeds because they are not the same view for us:
 *
 * - `all` renders the fork's own activity list, which carries the team filter
 *   and the entity-type filter and is fully localized. Its rows are scoped
 *   server-side, including the `PAPERCLIP_RESTRICT_AGENT_VISIBILITY` narrowing,
 *   so a member sees only the agents they may see.
 * - `agents` renders the fork's `AuditFeed`, which stays gated on
 *   `audit:view_agent_actions` and renders its own permission-denied state when
 *   the caller lacks it. Server-authoritative either way — the toggle is a view
 *   preference, never an access decision.
 *
 * Consequence worth stating: both tabs are always offered, and the agents tab
 * explains itself when it is not permitted rather than vanishing. Hiding it
 * would leak the caller's grant state into the nav, which is exactly the kind of
 * existence oracle this fork's authz model avoids elsewhere.
 */
export function CompanyActivity() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const mode: CompanyActivityMode = searchParams.get("mode") === "agents" ? "agents" : "all";

  useEffect(() => {
    setBreadcrumbs([{ label: t("activityPage.breadcrumb") }]);
  }, [setBreadcrumbs, t]);

  const handleModeChange = useCallback(
    (next: string) => {
      setSearchParams(
        (current) => {
          const params = new URLSearchParams(current);
          if (next === "agents") params.set("mode", "agents");
          else params.delete("mode");
          return params;
        },
        // A view toggle, not a navigation step — don't stack history entries the
        // back button then has to walk through.
        { replace: true },
      );
    },
    [setSearchParams],
  );

  if (!selectedCompanyId) {
    return <EmptyState icon={History} message={t("activityPage.selectCompany")} />;
  }

  return (
    <div className="space-y-4">
      <Tabs value={mode} onValueChange={handleModeChange}>
        <PageTabBar
          value={mode}
          onValueChange={handleModeChange}
          items={[
            { value: "all", label: t("activityPage.tabs.all", { defaultValue: "All activity" }) },
            { value: "agents", label: t("activityPage.tabs.agents", { defaultValue: "Agent audit" }) },
          ]}
        />
      </Tabs>

      {mode === "agents" ? (
        <AuditFeed companyId={selectedCompanyId} hideHeader />
      ) : (
        <Activity embedded />
      )}
    </div>
  );
}
