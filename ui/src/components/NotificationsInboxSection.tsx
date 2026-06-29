import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Bell } from "lucide-react";
import { Link } from "@/lib/router";
import { useTranslation } from "@/i18n";
import { notificationsApi, type AppNotification } from "../api/notifications";
import { queryKeys } from "../lib/queryKeys";
import { timeAgo } from "../lib/timeAgo";
import { cn } from "../lib/utils";

/**
 * Self-contained inbox notifications block. Renders NOTHING when there are no
 * notifications, so dropping it into the Inbox page is inert until something
 * actually fires. Marking read invalidates the sidebar badge so the count clears.
 */
export function NotificationsInboxSection({ companyId }: { companyId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["notifications", companyId],
    queryFn: () => notificationsApi.list(companyId),
    enabled: !!companyId,
    staleTime: 30_000,
  });
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["notifications", companyId] });
    qc.invalidateQueries({ queryKey: queryKeys.sidebarBadges(companyId) });
  };
  const markRead = useMutation({ mutationFn: (id: string) => notificationsApi.markRead(companyId, id), onSuccess: invalidate });
  const markAll = useMutation({ mutationFn: () => notificationsApi.markAllRead(companyId), onSuccess: invalidate });

  const items = data?.notifications ?? [];
  if (items.length === 0) return null;
  const unread = data?.unread ?? 0;

  return (
    <div className="rounded-lg border border-border">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Bell className="h-4 w-4 text-muted-foreground" />
          {t("notifications.title", { defaultValue: "Notifications" })}
          {unread > 0 && (
            <span className="rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground">{unread}</span>
          )}
        </h3>
        {unread > 0 && (
          <button type="button" onClick={() => markAll.mutate()} className="text-xs text-muted-foreground hover:text-foreground">
            {t("notifications.markAllRead", { defaultValue: "Mark all read" })}
          </button>
        )}
      </div>
      <ul className="divide-y divide-border">
        {items.slice(0, 12).map((n) => (
          <NotificationRow key={n.id} n={n} onRead={() => markRead.mutate(n.id)} />
        ))}
      </ul>
    </div>
  );
}

function NotificationRow({ n, onRead }: { n: AppNotification; onRead: () => void }) {
  const unread = !n.readAt;
  const inner = (
    <div className={cn("flex items-start gap-3 px-4 py-2.5", unread && "bg-accent/30")}>
      {unread ? (
        <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" />
      ) : (
        <span className="mt-1.5 h-2 w-2 shrink-0" />
      )}
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{n.title}</div>
        {n.body && <div className="text-xs text-muted-foreground">{n.body}</div>}
        <div className="text-[11px] text-muted-foreground">{timeAgo(n.createdAt)}</div>
      </div>
    </div>
  );
  if (n.link) {
    return (
      <li>
        <Link to={n.link} onClick={() => unread && onRead()} className="block no-underline text-inherit hover:bg-accent/40">
          {inner}
        </Link>
      </li>
    );
  }
  return (
    <li>
      {unread ? (
        <button type="button" onClick={onRead} className="block w-full text-left hover:bg-accent/40">
          {inner}
        </button>
      ) : (
        inner
      )}
    </li>
  );
}
