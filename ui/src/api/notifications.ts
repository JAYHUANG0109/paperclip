import { api } from "./client";

export interface AppNotification {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

export const notificationsApi = {
  list: (companyId: string) =>
    api.get<{ notifications: AppNotification[]; unread: number }>(`/companies/${companyId}/notifications`),
  markRead: (companyId: string, id: string) =>
    api.post<{ ok: boolean }>(`/companies/${companyId}/notifications/${encodeURIComponent(id)}/read`, {}),
  markAllRead: (companyId: string) =>
    api.post<{ ok: boolean }>(`/companies/${companyId}/notifications/read-all`, {}),
};
