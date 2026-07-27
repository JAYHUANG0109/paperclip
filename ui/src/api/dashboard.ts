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
  /** Comment count baked into the digest so collapsed rows show it without a per-task fetch. */
  commentCount?: number;
  /** Asana item type: default_task | milestone | approval. */
  resourceSubtype?: string | null;
  /** Approval-only: pending | approved | rejected | changes_requested. */
  approvalStatus?: string | null;
}

export type AsanaApprovalStatus = "pending" | "approved" | "rejected" | "changes_requested";

export interface AsanaDigest {
  generatedAt: string | null;
  daily: AsanaDigestTask[];
  weekly: AsanaDigestTask[];
  empty?: boolean;
  sample?: boolean;
}

export interface AsanaTaskComment {
  id: string;
  author: string | null;
  text: string;
  createdAt: string | null;
}

export interface AsanaSubtaskRef {
  gid: string;
  name: string;
  completed: boolean;
  permalinkUrl: string | null;
}
export interface AsanaTaskDetail {
  notes: string | null;
  permalinkUrl: string | null;
  subtasks: AsanaSubtaskRef[];
}

export type FounderDecision = "approved" | "changes_requested" | "rejected";

export interface FounderComment {
  id: string;
  author: string | null;
  authorType: "founder" | "agent" | "asana";
  text: string;
  createdAt: string;
  pending?: boolean;
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
  decision: FounderDecision | null;
  decisionNote: string | null;
  comments: FounderComment[];
  subtasks?: { name: string; completed: boolean }[];
  closed: boolean;
  resourceSubtype?: string | null;
  approvalStatus?: string | null;
  /** Live-rebuilt item that the agent hasn't summarized yet (just added in Asana). */
  isNew?: boolean;
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
  /** Raw lists refreshed live from Asana (server-side); summaries are the agent's last build. */
  live?: boolean;
}

export type ConsoleKey = "founder" | "principal" | "principalZhengXitun";
export interface DailyConsole {
  key: ConsoleKey;
  title: string;
  digest: FounderDigest;
  /** True when viewing someone else's (shared) console read-only — hide actions. */
  readOnly: boolean;
}
export interface FounderConsolesResponse {
  consoles: DailyConsole[];
}

export interface OnboardingStepView {
  key: string;
  title: string;
  desc: string;
  done: boolean;
  current: boolean;
}

export interface OnboardingView {
  available: boolean;
  stage?: number;
  total?: number;
  status?: "in_progress" | "done";
  steps?: OnboardingStepView[];
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
  createCalendarEvent: (
    companyId: string,
    event: {
      summary: string;
      start: string;
      end?: string;
      description?: string;
      location?: string;
      timeZone?: string;
      attendees?: string[];
      calendarId?: string;
    },
  ) =>
    api.post<{ created: true; id: string; htmlLink: string | null }>(
      `/companies/${companyId}/google-calendar/me/events`,
      event,
    ),
  googleCalendarList: (companyId: string) =>
    api.get<{
      connected: boolean;
      reason?: string;
      defaultCalendarId?: string;
      calendars: Array<{ id: string; name: string | null; primary: boolean; accessRole: string | null; canWrite: boolean; color: string | null }>;
    }>(`/companies/${companyId}/google-calendar/me/calendars`),
  calendarAliases: (companyId: string) =>
    api.get<CalendarAliasesResponse>(`/companies/${companyId}/google-calendar/aliases`),
  saveCalendarAliases: (companyId: string, aliases: string[]) =>
    api.put<CalendarAliasesResponse>(`/companies/${companyId}/google-calendar/aliases`, { aliases }),
  // The logged-in user's 5-step onboarding (their own agent), for the dashboard checklist.
  onboarding: (companyId: string) =>
    api.get<OnboardingView>(`/companies/${companyId}/onboarding/me`),
  // User-facing Asana connect (關卡 1): store the caller's own Personal Access Token.
  connectAsana: (companyId: string, token: string) =>
    api.post<{ ok: boolean; error?: string }>(`/companies/${companyId}/connections/asana/me`, { token }),
  asanaDigest: (companyId: string) => api.get<AsanaDigest>(`/companies/${companyId}/asana-digest/me`),
  completeAsanaTask: (companyId: string, gid: string, completed: boolean) =>
    api.post<{ ok: boolean; confirmed: boolean; digest: AsanaDigest | null }>(
      `/companies/${companyId}/asana-digest/tasks/${encodeURIComponent(gid)}/complete`,
      { completed },
    ),
  approveAsanaTask: (companyId: string, gid: string, status: AsanaApprovalStatus) =>
    api.post<{ ok: boolean; confirmed: boolean; digest: AsanaDigest | null }>(
      `/companies/${companyId}/asana-digest/tasks/${encodeURIComponent(gid)}/approval`,
      { status },
    ),
  asanaTaskDetail: (companyId: string, gid: string) =>
    api.get<AsanaTaskDetail>(
      `/companies/${companyId}/asana-digest/tasks/${encodeURIComponent(gid)}/detail`,
    ),
  commentAsanaTask: (companyId: string, gid: string, text: string) =>
    api.post<{ ok: boolean; comments: AsanaTaskComment[]; count: number }>(
      `/companies/${companyId}/asana-digest/tasks/${encodeURIComponent(gid)}/comment`,
      { text },
    ),
  asanaTaskComments: (companyId: string, gid: string) =>
    api.get<{ comments: AsanaTaskComment[]; count: number }>(
      `/companies/${companyId}/asana-digest/tasks/${encodeURIComponent(gid)}/comments`,
    ),
  refreshAsanaDigest: (companyId: string) =>
    api.post<{ ok: boolean; digest: AsanaDigest | null }>(
      `/companies/${companyId}/asana-digest/refresh`,
      {},
    ),
  // Every daily console the caller has (創辦人 / 園長). Most users have one.
  founderConsoles: (companyId: string) =>
    api.get<FounderConsolesResponse>(`/companies/${companyId}/founder-digest/me`),
  // Manual "更新": wake the caller's own agent to re-sync from Asana now.
  refreshFounderDigest: (companyId: string, console?: ConsoleKey) =>
    api.post<{ ok: boolean }>(`/companies/${companyId}/founder-digest/refresh`, console ? { console } : {}),
  // Submit the founder's verdict on a draft 批閱 (+ optional comment). `decision:
  // null` reverts it to undecided.
  decideFounderItem: (companyId: string, gid: string, decision: FounderDecision | null, note?: string) =>
    api.post<{ ok: boolean; digest: FounderDigest | null }>(
      `/companies/${companyId}/founder-digest/items/${encodeURIComponent(gid)}/decision`,
      { decision, note },
    ),
  // 結案 (or reopen) a meeting/reminder item.
  closeFounderItem: (companyId: string, gid: string, closed: boolean) =>
    api.post<{ ok: boolean; digest: FounderDigest | null }>(
      `/companies/${companyId}/founder-digest/items/${encodeURIComponent(gid)}/close`,
      { closed },
    ),
  // Post a free-form comment to an item's thread (decision-independent). Routed
  // through the caller's own agent, which posts it as an Asana comment.
  commentFounderItem: (companyId: string, gid: string, text: string) =>
    api.post<{ ok: boolean; digest: FounderDigest | null }>(
      `/companies/${companyId}/founder-digest/items/${encodeURIComponent(gid)}/comment`,
      { text },
    ),
};
