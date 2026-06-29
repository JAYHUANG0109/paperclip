import { useQuery } from "@tanstack/react-query";
import { ClipboardList } from "lucide-react";
import { notificationsApi, type AppNotification } from "../api/notifications";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Dashboard "tasks done" summary section. Reads the user's own daily/weekly
 * summary notifications (already localized server-side) and shows the latest of
 * each. Renders nothing until a summary exists, so it's inert by default.
 */
export function TaskSummaryCard({ companyId }: { companyId: string }) {
  const { data } = useQuery({
    queryKey: ["notifications", companyId],
    queryFn: () => notificationsApi.list(companyId),
    enabled: !!companyId,
    staleTime: 30_000,
  });
  const list = data?.notifications ?? [];
  const daily = list.find((n) => n.kind === "daily_summary");
  const weekly = list.find((n) => n.kind === "weekly_summary");
  if (!daily && !weekly) return null;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {daily && <SummaryBlock n={daily} />}
      {weekly && <SummaryBlock n={weekly} />}
    </div>
  );
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
