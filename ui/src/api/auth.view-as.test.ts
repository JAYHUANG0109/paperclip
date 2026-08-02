import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setViewAs } from "@/lib/view-as";

/**
 * `/api/auth/get-session` is better-auth's own route and never sees Paperclip's
 * view-as header, so it always answers with the real account. Components derive
 * "is this mine?" from that session, so it has to be re-pointed at the user
 * being viewed — otherwise the server scopes data to the target while the
 * client highlights the viewer's rows, which is neither person's view.
 */

const SESSION = {
  user: { id: "real-user", name: "Real Person", email: "real@seasonart.org", image: null },
  session: { id: "session-1", userId: "real-user" },
};

function mockSessionFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => SESSION,
    })),
  );
}

let authApi: typeof import("./auth").authApi;

beforeEach(async () => {
  vi.stubGlobal("sessionStorage", (() => {
    const store = new Map<string, string>();
    return {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    };
  })());
  mockSessionFetch();
  ({ authApi } = await import("./auth"));
});

afterEach(() => {
  setViewAs(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("getSession under view-as", () => {
  it("returns the real user when no one is being viewed", async () => {
    const session = await authApi.getSession();

    expect(session?.user?.id).toBe("real-user");
    expect(session?.session?.userId).toBe("real-user");
  });

  // The property the whole feature rests on: while viewing as someone, the app
  // must consider THEM the current user, or "mine" means the wrong person.
  it("re-points the session at the viewed user", async () => {
    setViewAs({ userId: "target-user", label: "黃睦傑" });

    const session = await authApi.getSession();

    expect(session?.user?.id).toBe("target-user");
    expect(session?.session?.userId).toBe("target-user");
    expect(session?.user?.name).toBe("黃睦傑");
  });

  it("goes back to the real user when view-as is cleared", async () => {
    setViewAs({ userId: "target-user", label: "黃睦傑" });
    expect((await authApi.getSession())?.user?.id).toBe("target-user");

    setViewAs(null);

    expect((await authApi.getSession())?.user?.id).toBe("real-user");
  });
});
