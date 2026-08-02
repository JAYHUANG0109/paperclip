import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { VIEW_AS_CHANGED_EVENT, getViewAs, setViewAs, type ViewAsSelection } from "@/lib/view-as";

/**
 * "View as" — load the app scoped to another user to check what that person
 * actually sees. Used to verify per-user agent visibility.
 *
 * The control only renders for accounts the SERVER says may use it: the list
 * endpoint 403s for everyone else, so an ordinary admin never sees this and
 * never gets a user directory out of it. Nothing here is a permission check.
 *
 * The banner is deliberately loud and always present while active. Forgetting
 * you are scoped to someone else is the main way a tool like this misleads —
 * you read a screen as your own and conclude the wrong thing.
 */

type ViewAsUser = { id: string; email: string | null; name: string | null };

function useViewAsSelection(): ViewAsSelection {
  const [selection, setSelection] = useState<ViewAsSelection>(() => getViewAs());
  useEffect(() => {
    const sync = () => setSelection(getViewAs());
    window.addEventListener(VIEW_AS_CHANGED_EVENT, sync);
    return () => window.removeEventListener(VIEW_AS_CHANGED_EVENT, sync);
  }, []);
  return selection;
}

/**
 * Name first — you know your colleagues by name, not by the address their
 * account happens to use. The email trails it only to disambiguate two people
 * with the same name, and stands alone when no name is set.
 */
const label = (user: ViewAsUser) => {
  const name = user.name?.trim();
  const email = user.email?.trim();
  if (name && email) return `${name} · ${email}`;
  return name || email || user.id;
};

/** What the banner says while active: the name alone, kept short. */
const shortLabel = (user: ViewAsUser) =>
  user.name?.trim() || user.email?.trim() || user.id;

/**
 * Switch identity with a full reload rather than by invalidating queries.
 *
 * Enumerating every place the previous identity could still be cached —
 * react-query keys, component state, module-level memos — and getting all of
 * them right is not a bet worth taking for a tool whose only job is showing
 * you the truth about what someone sees. A reload is certain.
 */
function switchTo(selection: Parameters<typeof setViewAs>[0]) {
  setViewAs(selection);
  window.location.reload();
}

/**
 * The permitted user list, or undefined for everyone else.
 *
 * A 403 here is the normal answer for almost everyone, so it must not retry or
 * surface as an error — it simply means "no control for you". Both the banner
 * and the sidebar picker share this one query key, so the request is made once.
 */
function useViewAsUsers() {
  const { data } = useQuery<ViewAsUser[]>({
    queryKey: ["view-as-users"],
    queryFn: () => api.get<ViewAsUser[]>("/instance/view-as-users"),
    retry: false,
    staleTime: 5 * 60 * 1000,
  });
  return data;
}

/**
 * The idle picker, in the sidebar where account-level controls belong.
 *
 * It used to live in the top banner, but an inert grey strip above the app
 * chrome reads as part of the browser and went unnoticed. The banner now
 * handles only the active state, where being impossible to miss is the point.
 */
export function ViewAsSwitcher() {
  const selection = useViewAsSelection();
  const users = useViewAsUsers();

  // Not permitted, or already viewing as someone — the banner owns that state.
  if (!users || users.length === 0 || selection) return null;

  return (
    <div className="mx-2 flex flex-col gap-1 rounded-lg border border-dashed border-border/70 px-2 py-2">
      <label htmlFor="view-as-sidebar-select" className="text-xs font-medium text-muted-foreground">
        View as user
      </label>
      <select
        id="view-as-sidebar-select"
        className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs"
        value=""
        onChange={(event) => {
          const user = users.find((candidate) => candidate.id === event.target.value);
          if (user) switchTo({ userId: user.id, label: shortLabel(user) });
        }}
      >
        <option value="">Select a user…</option>
        {[...users].sort((a, b) => label(a).localeCompare(label(b), undefined, { numeric: true })).map((user) => (
          <option key={user.id} value={user.id}>
            {label(user)}
          </option>
        ))}
      </select>
      <p className="text-[11px] leading-snug text-muted-foreground">
        See the platform as someone else, read-only. Only you can do this.
      </p>
    </div>
  );
}

export function ViewAsBanner() {
  const selection = useViewAsSelection();
  const users = useViewAsUsers();

  if (!users) return null;
  // Idle state now lives in the sidebar; the banner is for the active one.
  if (!selection) return null;

  return (
    <div
      data-testid="view-as-banner"
      className="flex flex-wrap items-center gap-2 border-b border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm"
    >
      <span className="font-medium">Viewing as {selection.label} — read-only</span>
      <span className="text-muted-foreground">
        Everything below is scoped to this person. Changes are refused while this is on.
      </span>
      <button
        type="button"
        className="ml-auto rounded-md border border-border px-2 py-1"
        onClick={() => switchTo(null)}
      >
        Stop viewing as
      </button>
    </div>
  );
}
