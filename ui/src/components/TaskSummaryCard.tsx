import { useQuery } from "@tanstack/react-query";
import { ClipboardList } from "lucide-react";
import { notificationsApi, type AppNotification } from "../api/notifications";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Dashboard "tasks done" summary section. Reads the user's own WEEKLY summary
 * notification (already localized server-side) and shows the latest one. The
 * daily summary was removed to save tokens. Renders nothing until a weekly
 * summary exists, so it's inert by default.
 */
export function TaskSummaryCard({ companyId }: { companyId: string }) {
  const { data } = useQuery({
    queryKey: ["notifications", companyId],
    queryFn: () => notificationsApi.list(companyId),
    enabled: !!companyId,
    staleTime: 30_000,
  });
  const list = data?.notifications ?? [];
  const weekly = list.find((n) => n.kind === "weekly_summary");
  if (!weekly) return null;
  // Full-width, like the 我的行程 (My Schedule) block — the daily summary that
  // used to sit beside it was removed, so the weekly recap spans the page.
  return <SummaryBlock n={weekly} />;
}

function SummaryBlock({ n }: { n: AppNotification }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2 px-5 pt-5 pb-2">
        <ClipboardList className="h-4 w-4 text-muted-foreground" />
        <CardTitle className="text-base">{n.title}</CardTitle>
      </CardHeader>
      <CardContent className="px-5 pb-5 pt-1">
        {n.body && <p className="whitespace-pre-line text-sm text-muted-foreground">{n.body}</p>}
      </CardContent>
    </Card>
  );
}
