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

export function ViewAsBanner() {
  const selection = useViewAsSelection();

  // A 403 here is the normal answer for almost everyone, so it must not retry
  // or surface as an error — it simply means "no control for you".
  const { data: users } = useQuery<ViewAsUser[]>({
    queryKey: ["view-as-users"],
    queryFn: () => api.get<ViewAsUser[]>("/instance/view-as-users"),
    retry: false,
    staleTime: 5 * 60 * 1000,
  });

  if (!users) return null;

  const label = (user: ViewAsUser) => user.email ?? user.name ?? user.id;

  /**
   * Switch identity with a full reload rather than by invalidating queries.
   *
   * Enumerating every place the previous identity could still be cached —
   * react-query keys, component state, module-level memos — and getting all of
   * them right is not a bet worth taking for a tool whose only job is showing
   * you the truth about what someone sees. A reload is certain.
   */
  const switchTo = (selection: Parameters<typeof setViewAs>[0]) => {
    setViewAs(selection);
    window.location.reload();
  };

  return (
    <div
      data-testid="view-as-banner"
      className={
        selection
          ? "flex flex-wrap items-center gap-2 border-b border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm"
          : "flex flex-wrap items-center gap-2 border-b border-border/60 px-4 py-2 text-sm"
      }
    >
      {selection ? (
        <>
          <span className="font-medium">
            Viewing as {selection.label} — read-only
          </span>
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
        </>
      ) : (
        <>
          <label htmlFor="view-as-select" className="text-muted-foreground">
            View as
          </label>
          <select
            id="view-as-select"
            className="rounded-md border border-border bg-background px-2 py-1"
            value=""
            onChange={(event) => {
              const user = users.find((candidate) => candidate.id === event.target.value);
              if (user) switchTo({ userId: user.id, label: label(user) });
            }}
          >
            <option value="">Select a user…</option>
            {users.map((user) => (
              <option key={user.id} value={user.id}>
                {label(user)}
              </option>
            ))}
          </select>
        </>
      )}
    </div>
  );
}
