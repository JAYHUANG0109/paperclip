import { getPageVisibility, getVisibilityHeaderValue } from "@/lib/page-visibility";

const BASE = "/api";

// Hard ceiling on any single request. Without this, a fetch that the browser
// froze while the tab was backgrounded (then never resumed after refocus) hangs
// forever: react-query's on-focus refetch stays `isFetching`, pages stay stuck
// on their loading skeleton, and only a manual page reload clears it. A timeout
// makes the stalled request reject instead, so the query settles to an error
// state and the page recovers on the next focus/refetch on its own. (PAP: white
// screen after switching browser tabs and back.)
const REQUEST_TIMEOUT_MS = 20_000;

export class ApiError extends Error {
  status: number;
  body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export interface RequestOptions {
  /** Abort signal wired through to `fetch` and coalescing (per-caller). */
  signal?: AbortSignal;
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

/** Combine a caller-supplied signal (if any) with our per-request timeout. */
function withTimeoutSignal(signal: AbortSignal | null | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  if (!signal) return timeout;
  // AbortSignal.any is widely available; fall back to the caller's signal alone
  // (still timeout-guarded by the abort below) if the runtime lacks it.
  const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  return anyFn ? anyFn([signal, timeout]) : timeout;
}

/**
 * Non-authoritative observability hints (PAP-12556 / Phase 1). The server treats
 * these as scheduling/telemetry only and never as security signals.
 */
function applyObservabilityHeaders(headers: Headers) {
  if (headers.has("X-Paperclip-Tab-Visible")) return; // caller override wins
  const visibility = getPageVisibility();
  headers.set("X-Paperclip-Tab-Visible", getVisibilityHeaderValue(visibility));
  if (typeof window !== "undefined" && window.location) {
    headers.set("X-Paperclip-Route", window.location.pathname);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers ?? undefined);
  const body = init?.body;
  if (!(body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  applyObservabilityHeaders(headers);

  const res = await fetch(`${BASE}${path}`, {
    headers,
    credentials: "include",
    ...init,
    signal: withTimeoutSignal(init?.signal),
  });
  if (!res.ok) {
    const errorBody = await res.json().catch(() => null);
    throw new ApiError(
      (errorBody as { error?: string } | null)?.error ?? `Request failed: ${res.status}`,
      res.status,
      errorBody,
    );
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

// --- In-tab request coalescing for identical safe GETs -----------------------
//
// Multiple callers issuing the same GET while one is in flight share a single
// underlying fetch. Each caller keeps its own abort semantics: aborting one
// caller only cancels the shared fetch when *every* caller has aborted.
// Mutations are never coalesced.

interface InflightGet {
  promise: Promise<unknown>;
  controller: AbortController;
  refs: Set<symbol>;
}

const inflightGets = new Map<string, InflightGet>();

function coalescedGet<T>(path: string, options?: RequestOptions): Promise<T> {
  const signal = options?.signal;
  if (signal?.aborted) return Promise.reject(abortError());

  let entry = inflightGets.get(path);
  if (!entry) {
    const controller = new AbortController();
    const promise = request<T>(path, { method: "GET", signal: controller.signal });
    const created: InflightGet = { promise, controller, refs: new Set() };
    // Clear the shared entry once settled so later calls issue a fresh request.
    promise.then(
      () => {
        if (inflightGets.get(path) === created) inflightGets.delete(path);
      },
      () => {
        if (inflightGets.get(path) === created) inflightGets.delete(path);
      },
    );
    inflightGets.set(path, created);
    entry = created;
  }

  const activeEntry = entry;
  const ref = Symbol("caller");
  activeEntry.refs.add(ref);

  const releaseRef = () => {
    if (!activeEntry.refs.delete(ref)) return;
    // Last caller gone before the fetch settled → abort the shared request.
    if (activeEntry.refs.size === 0 && inflightGets.get(path) === activeEntry) {
      inflightGets.delete(path);
      activeEntry.controller.abort();
    }
  };

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal?.removeEventListener("abort", onAbort);
      releaseRef();
      reject(abortError());
    };
    if (signal) signal.addEventListener("abort", onAbort);

    activeEntry.promise.then(
      (value) => {
        signal?.removeEventListener("abort", onAbort);
        activeEntry.refs.delete(ref);
        resolve(value as T);
      },
      (err) => {
        signal?.removeEventListener("abort", onAbort);
        activeEntry.refs.delete(ref);
        reject(err);
      },
    );
  });
}

/** Test-only: number of in-flight coalesced GET keys. */
export function __inflightGetCount(): number {
  return inflightGets.size;
}

export const api = {
  get: <T>(path: string, options?: RequestOptions) => coalescedGet<T>(path, options),
  post: <T>(path: string, body: unknown, options?: RequestOptions) =>
    request<T>(path, { method: "POST", body: JSON.stringify(body), signal: options?.signal }),
  postForm: <T>(path: string, body: FormData, options?: RequestOptions) =>
    request<T>(path, { method: "POST", body, signal: options?.signal }),
  put: <T>(path: string, body: unknown, options?: RequestOptions) =>
    request<T>(path, { method: "PUT", body: JSON.stringify(body), signal: options?.signal }),
  patch: <T>(path: string, body: unknown, options?: RequestOptions) =>
    request<T>(path, { method: "PATCH", body: JSON.stringify(body), signal: options?.signal }),
  delete: <T>(path: string, options?: RequestOptions) =>
    request<T>(path, { method: "DELETE", signal: options?.signal }),
  deleteWithBody: <T>(path: string, body: unknown, options?: RequestOptions) =>
    request<T>(path, { method: "DELETE", body: JSON.stringify(body), signal: options?.signal }),
};
