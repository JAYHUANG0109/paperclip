import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { issuesApi } from "../api/issues";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useTranslation } from "@/i18n";
import { queryKeys } from "../lib/queryKeys";
import { IssueCalendar } from "../components/IssueCalendar";
import { EmptyState } from "../components/EmptyState";
import { CalendarDays } from "lucide-react";
import type { Issue } from "@paperclipai/shared";

const CALENDAR_ISSUE_LIMIT = 1000;

/**
 * Top-level personal calendar. The issues list is already scoped server-side
 * (operators see their own + their joined agents' work; admins see all), so this
 * naturally shows "my + my agents' deadlines" without extra client filtering.
 */
export function MyCalendar() {
  const { t } = useTranslation();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: t("nav.calendar", { defaultValue: "Calendar" }) }]);
  }, [setBreadcrumbs, t]);

  const { data: issues, isLoading } = useQuery({
    queryKey: [...queryKeys.issues.list(selectedCompanyId ?? "__none__"), "calendar"],
    queryFn: () => issuesApi.list(selectedCompanyId!, { limit: CALENDAR_ISSUE_LIMIT }),
    enabled: !!selectedCompanyId,
  });

  const dated = useMemo(
    () => (issues ?? []).filter((i: Issue) => Boolean(i.dueDate)),
    [issues],
  );

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 p-4 sm:p-6">
      <div className="flex items-center gap-2">
        <CalendarDays className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">{t("calendar.myCalendar", { defaultValue: "My Calendar / 我的行事曆" })}</h1>
      </div>
      <p className="text-sm text-muted-foreground">
        {t("calendar.myCalendarHint", {
          defaultValue: "Deadlines of issues assigned to you and your agents.",
        })}
      </p>

      {!isLoading && dated.length === 0 ? (
        <EmptyState
          icon={CalendarDays}
          message={t("calendar.empty.message", {
            defaultValue: "No issues have a due date yet. Set a due date on an issue to see it here.",
          })}
        />
      ) : (
        <IssueCalendar issues={dated} />
      )}
    </div>
  );
}
