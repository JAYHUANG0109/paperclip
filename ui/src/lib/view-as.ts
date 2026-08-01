/**
 * Client state for "view as" — loading the app scoped to another user to check
 * what that person actually sees.
 *
 * The server decides everything (see server/src/services/view-as-policy.ts);
 * this only remembers which user is selected and puts it on the wire. Nothing
 * here is a permission check — the header is a request, not a claim.
 *
 * Stored in sessionStorage, deliberately:
 *   - it survives a reload, so a page refresh does not silently drop you back
 *     into your own view while the banner is gone;
 *   - it is per-tab, so viewing as someone in one tab cannot surprise you in
 *     another where you are doing real work.
 */

const STORAGE_KEY = "paperclip.viewAsUserId";
const LABEL_KEY = "paperclip.viewAsUserLabel";
/** Same header the server reads. Keep in sync with VIEW_AS_HEADER. */
export const VIEW_AS_HEADER = "x-paperclip-view-as-user";
export const VIEW_AS_CHANGED_EVENT = "paperclip:view-as-changed";

export type ViewAsSelection = { userId: string; label: string } | null;

function readStorage(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null; // Storage can be unavailable (private mode, embedded frames).
  }
}

export function getViewAs(): ViewAsSelection {
  const userId = readStorage(STORAGE_KEY);
  if (!userId) return null;
  return { userId, label: readStorage(LABEL_KEY) ?? userId };
}

export function getViewAsUserId(): string | null {
  return getViewAs()?.userId ?? null;
}

export function setViewAs(selection: ViewAsSelection): void {
  try {
    if (selection) {
      sessionStorage.setItem(STORAGE_KEY, selection.userId);
      sessionStorage.setItem(LABEL_KEY, selection.label);
    } else {
      sessionStorage.removeItem(STORAGE_KEY);
      sessionStorage.removeItem(LABEL_KEY);
    }
  } catch {
    /* storage may be unavailable; the event below still updates this tab */
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(VIEW_AS_CHANGED_EVENT));
  }
}

export function clearViewAs(): void {
  setViewAs(null);
}

/**
 * Attach the header to EVERY request, including writes.
 *
 * Sending it only on reads would be worse than it sounds: a mutation would then
 * run as the real user while the screen shows someone else's data, so a click
 * on a destructive control would act on what you are looking at without the
 * scoping you believe is in force. Sending it always means the server's
 * read-only rail turns that click into a clear 403 instead.
 */
export function applyViewAsHeader(headers: Headers): void {
  const userId = getViewAsUserId();
  if (userId) headers.set(VIEW_AS_HEADER, userId);
}
