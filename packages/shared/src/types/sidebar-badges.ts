export interface SidebarBadges {
  inbox: number;
  approvals: number;
  failedRuns: number;
  joinRequests: number;
  /** Unread in-app notifications (e.g. Asana digest refreshed). Optional/additive. */
  notifications?: number;
}
