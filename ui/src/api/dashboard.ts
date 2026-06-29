import type { DashboardSummary } from "@paperclipai/shared";
import { api } from "./client";

export interface AsanaDigestTask {
  gid: string;
  name: string;
  dueOn: string | null;
  priority: string | null;
  projectName: string | null;
  permalinkUrl: string | null;
  completed: boolean;
  notes?: string | null;
}

export interface AsanaDigest {
  generatedAt: string | null;
  daily: AsanaDigestTask[];
  weekly: AsanaDigestTask[];
  empty?: boolean;
  sample?: boolean;
}

export interface FounderItem {
  gid: string;
  name: string;
  notes: string | null;
  permalinkUrl: string | null;
  summary: string | null;
  review: string | null;
  prep: string | null;
  triage: "now" | "evening" | null;
  approved: boolean;
}
export interface FounderDigest {
  generatedAt: string | null;
  lastRunLabel: string | null;
  categories: {
    urgent: FounderItem[];
    meetings: FounderItem[];
    nonUrgent: FounderItem[];
    reminders: FounderItem[];
  };
  empty?: boolean;
}

export interface GoogleCalendarEventDto {
  id: string;
  calendarId: string;
  calendarName: string | null;
  calendarColor: string | null;
  title: string;
  start: string;
  end: string | null;
  dateKey: string;
  allDay: boolean;
  htmlLink: string | null;
  isInvitedAttendee: boolean;
}

export interface GoogleCalendarResponse {
  connected: boolean;
  reason?: "auth_required" | "not_configured";
  events: GoogleCalendarEventDto[];
}

export interface CalendarAliasesResponse {
  aliases: string[];
  derived: string[];
  usingDefaults: boolean;
}

function calendarQuery(opts?: { timeMin?: string; timeMax?: string; mine?: boolean }): string {
  const params = new URLSearchParams();
  if (opts?.timeMin) params.set("timeMin", opts.timeMin);
  if (opts?.timeMax) params.set("timeMax", opts.timeMax);
  if (opts?.mine) params.set("mine", "1");
  const q = params.toString();
  return q ? `?${q}` : "";
}

export const dashboardApi = {
  summary: (companyId: string) => api.get<DashboardSummary>(`/companies/${companyId}/dashboard`),
  googleCalendar: (companyId: string, opts?: { timeMin?: string; timeMax?: string; mine?: boolean }) =>
    api.get<GoogleCalendarResponse>(`/companies/${companyId}/google-calendar/me${calendarQuery(opts)}`),
  calendarAliases: (companyId: string) =>
    api.get<CalendarAliasesResponse>(`/companies/${companyId}/google-calendar/aliases`),
  saveCalendarAliases: (companyId: string, aliases: string[]) =>
    api.put<CalendarAliasesResponse>(`/companies/${companyId}/google-calendar/aliases`, { aliases }),
  asanaDigest: (companyId: string) => api.get<AsanaDigest>(`/companies/${companyId}/asana-digest/me`),
  completeAsanaTask: (companyId: string, gid: string, completed: boolean) =>
    api.post<{ ok: boolean; digest: AsanaDigest | null }>(
      `/companies/${companyId}/asana-digest/tasks/${encodeURIComponent(gid)}/complete`,
      { completed },
    ),
  founderDigest: (companyId: string) => api.get<FounderDigest>(`/companies/${companyId}/founder-digest/me`),
  approveFounderItem: (companyId: string, gid: string, approved: boolean) =>
    api.post<{ ok: boolean; digest: FounderDigest | null }>(
      `/companies/${companyId}/founder-digest/items/${encodeURIComponent(gid)}/approve`,
      { approved },
    ),
};
