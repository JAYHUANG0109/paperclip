// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  VIEW_AS_CHANGED_EVENT,
  VIEW_AS_HEADER,
  applyViewAsHeader,
  clearViewAs,
  getViewAs,
  getViewAsUserId,
  setViewAs,
} from "./view-as";

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("view-as selection", () => {
  it("round-trips a selection", () => {
    setViewAs({ userId: "user-member", label: "member@seasonart.org" });

    expect(getViewAs()).toEqual({ userId: "user-member", label: "member@seasonart.org" });
    expect(getViewAsUserId()).toBe("user-member");
  });

  it("is empty by default", () => {
    expect(getViewAs()).toBeNull();
    expect(getViewAsUserId()).toBeNull();
  });

  it("clears", () => {
    setViewAs({ userId: "user-member", label: "member@seasonart.org" });
    clearViewAs();

    expect(getViewAs()).toBeNull();
  });

  it("falls back to the id when no label was stored", () => {
    sessionStorage.setItem("paperclip.viewAsUserId", "user-member");

    expect(getViewAs()).toEqual({ userId: "user-member", label: "user-member" });
  });

  it("notifies listeners on change", () => {
    const seen = vi.fn();
    window.addEventListener(VIEW_AS_CHANGED_EVENT, seen);
    setViewAs({ userId: "user-member", label: "member@seasonart.org" });
    clearViewAs();
    window.removeEventListener(VIEW_AS_CHANGED_EVENT, seen);

    expect(seen).toHaveBeenCalledTimes(2);
  });

  it("survives storage being unavailable", () => {
    // Stub the GLOBAL the module actually reads: node ships its own
    // sessionStorage global that shadows jsdom's window.sessionStorage, so
    // spying on the window object never intercepts anything here.
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    });

    expect(() => setViewAs({ userId: "user-member", label: "x" })).not.toThrow();
    expect(getViewAs()).toBeNull();
  });
});

describe("applyViewAsHeader", () => {
  it("adds nothing when no user is selected", () => {
    const headers = new Headers();
    applyViewAsHeader(headers);

    expect(headers.has(VIEW_AS_HEADER)).toBe(false);
  });

  it("adds the header when a user is selected", () => {
    setViewAs({ userId: "user-member", label: "member@seasonart.org" });
    const headers = new Headers();
    applyViewAsHeader(headers);

    expect(headers.get(VIEW_AS_HEADER)).toBe("user-member");
  });

  // Sending it only on reads would let a click on a destructive control act as
  // the real user against a screen showing someone else's data. Sending it
  // always turns that into the server's read-only refusal instead.
  it("is applied regardless of method, so writes are refused rather than silently run as the viewer", () => {
    setViewAs({ userId: "user-member", label: "member@seasonart.org" });
    const headers = new Headers({ "Content-Type": "application/json" });
    applyViewAsHeader(headers);

    expect(headers.get(VIEW_AS_HEADER)).toBe("user-member");
  });
});
