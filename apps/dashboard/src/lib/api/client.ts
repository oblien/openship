import { getRestApiBaseUrl } from "./urls";

/**
 * Standard API client for the Openship dashboard.
 *
 * Use this for all non-auth API calls (projects, deployments, domains, etc.).
 * Auth calls should go through `auth-client.ts` (Better Auth SDK).
 *
 * Features:
 *   - Automatic base URL resolution from the shared runtime targets
 *   - 15s request timeout (configurable per-call)
 *   - Credentials included by default (cookies forwarded cross-origin)
 *   - Typed JSON responses via generics
 *   - Consistent error shape (`ApiError`)
 */

const BASE_URL = getRestApiBaseUrl();
const DEFAULT_TIMEOUT = 15_000;

/* Ensure the base always ends with a slash for correct URL resolution */
const RESOLVED_BASE = BASE_URL.endsWith("/") ? BASE_URL : BASE_URL + "/";

/** Public accessor for building full URLs (e.g. SSE endpoints). */
export function getApiBaseUrl(): string {
  return RESOLVED_BASE;
}

/* ------------------------------------------------------------------ */
/*  Global network-error hook                                         */
/* ------------------------------------------------------------------ */

/**
 * Optional callback invoked whenever a request fails at the network level
 * (server unreachable, connection refused, or request timeout).
 * Wire this up once from a React component that has access to the toast context.
 *
 * Example:
 *   setNetworkErrorHandler((msg) => showToast(msg, "error", "Connection Error"));
 */
let _networkErrorHandler: ((message: string) => void) | null = null;

export function setNetworkErrorHandler(fn: ((message: string) => void) | null) {
  _networkErrorHandler = fn;
}

/* ------------------------------------------------------------------ */
/*  Error                                                             */
/* ------------------------------------------------------------------ */

export class ApiError extends Error {
  constructor(
    public status: number,
    public statusText: string,
    public body: unknown,
  ) {
    super(`API ${status}: ${statusText}`);
    this.name = "ApiError";
  }
}

/**
 * Returns `true` when the error was caused by a request abort / timeout.
 */
export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

/**
 * Returns `true` when the error was caused by a network-level failure
 * (server unreachable, ECONNREFUSED, etc.).
 */
export function isNetworkError(err: unknown): boolean {
  return err instanceof TypeError;
}

/**
 * Extract the most useful server-side message from an API error.
 */
export function getApiErrorMessage(
  err: unknown,
  fallback = "Request failed",
): string {
  if (err instanceof ApiError) {
    const body = err.body as Record<string, unknown> | undefined;
    if (body && typeof body.message === "string") return body.message;
    if (body && typeof body.error === "string") return body.error;
    return err.message || fallback;
  }
  if (err instanceof Error) return err.message;
  return fallback;
}

/* ------------------------------------------------------------------ */
/*  Request helper                                                    */
/* ------------------------------------------------------------------ */

export type RequestOptions = Omit<RequestInit, "body"> & {
  /** Request body - objects are JSON-serialised automatically. */
  body?: unknown;
  /** Per-request timeout in ms (default 15 000). */
  timeout?: number;
  /** URL search params appended to the path. */
  params?: Record<string, string | number | boolean | undefined>;
};

/* ------------------------------------------------------------------ */
/*  In-flight request dedupe                                          */
/* ------------------------------------------------------------------ */
//
// React 18 StrictMode double-fires every effect in dev, so a component
// that calls `api.get(...)` in useEffect fires the request twice. The
// same thing happens when N sibling components each mount and call
// the same endpoint independently (e.g. /settings page has 3 cards
// that each fetch settingsApi.get()).
//
// This dedupe layer collapses ANY concurrent GET requests with the
// same URL+params into a single network call: the second caller gets
// the same Promise the first is already awaiting. The entry is dropped
// the moment the request settles (success or failure), so this never
// caches results — it only collapses races.
//
// POST/PUT/PATCH/DELETE are NEVER deduped — they're side-effectful.
//
// The key uses method + URL with sorted params so `{a:1, b:2}` and
// `{b:2, a:1}` collapse correctly.

const inflightRequests = new Map<string, Promise<unknown>>();

function buildInflightKey(method: string, url: URL): string {
  // Stable sort of search params so order-permuted callers still collide.
  const sorted = Array.from(url.searchParams.entries()).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const search = sorted.map(([k, v]) => `${k}=${v}`).join("&");
  return `${method} ${url.pathname}?${search}`;
}

/**
 * Low-level fetch wrapper - prefer the convenience methods below.
 */
async function request<T = unknown>(
  path: string,
  { body, timeout = DEFAULT_TIMEOUT, params, ...init }: RequestOptions = {},
): Promise<T> {
  /* --- Build URL -------------------------------------------------- */
  const cleanPath = path.startsWith("/") ? path.slice(1) : path;
  const url = new URL(cleanPath, RESOLVED_BASE);

  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }

  /* --- In-flight dedupe (GET only) -------------------------------- */
  // POST/PUT/PATCH/DELETE are side-effectful — never collapse them.
  // Only deduping GETs avoids surprising consumers that issue back-to-
  // back mutations.
  const method = (init.method ?? "GET").toUpperCase();
  if (method === "GET") {
    const key = buildInflightKey(method, url);
    const existing = inflightRequests.get(key);
    if (existing) return existing as Promise<T>;
    // We register the promise BEFORE awaiting it so racing callers in
    // the same tick see it. The wrapping promise drops the entry on
    // settle so the cache is never stale.
    const promise = doFetch<T>(url, body, timeout, init);
    inflightRequests.set(key, promise);
    promise.finally(() => {
      if (inflightRequests.get(key) === promise) {
        inflightRequests.delete(key);
      }
    });
    return promise;
  }

  return doFetch<T>(url, body, timeout, init);
}

/* ------------------------------------------------------------------ */
/*  Active organization header                                         */
/* ------------------------------------------------------------------ */
//
// The API derives the org scope for list/create endpoints from:
//   1. X-Organization-Id header (authoritative)
//   2. Session cookie's default-org fallback
//
// The dashboard JS owns the current "view org" and sends it explicitly.
// This eliminates the cross-tab races where one tab's auto-switch would
// change another tab's list endpoint answer.
//
// Reads from a global slot set by the AccountSwitcher (or equivalent UI
// state hook). When unset, the request goes without the header and the
// API falls back to the session cookie — same as before.

let _currentOrgId: string | null = null;

/** Set the org id that subsequent API requests should declare. */
export function setActiveOrganizationId(orgId: string | null) {
  _currentOrgId = orgId;
  if (typeof window !== "undefined") {
    if (orgId) {
      window.localStorage.setItem("openship.activeOrgId", orgId);
    } else {
      window.localStorage.removeItem("openship.activeOrgId");
    }
  }
}

/** Read the current org id slot (used in tests / debugging). */
export function getActiveOrganizationId(): string | null {
  return _currentOrgId;
}

// Restore from localStorage on module load so a page refresh keeps the
// previously-active org in context until the auth hook sets a fresh one.
if (typeof window !== "undefined") {
  const stored = window.localStorage.getItem("openship.activeOrgId");
  if (stored) _currentOrgId = stored;
}

async function doFetch<T>(
  url: URL,
  body: unknown,
  timeout: number,
  init: Omit<RequestOptions, "body" | "timeout" | "params">,
): Promise<T> {
  /* --- Timeout ---------------------------------------------------- */
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  /* --- Headers ---------------------------------------------------- */
  const headers = new Headers(init.headers);

  if (body && typeof body === "object" && !(body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }

  // Always send X-Organization-Id when we know what org the user is
  // viewing. The API uses this for list/create scope; detail endpoints
  // ignore it (they derive org from the resource).
  if (_currentOrgId && !headers.has("X-Organization-Id")) {
    headers.set("X-Organization-Id", _currentOrgId);
  }

  /* --- Fetch ------------------------------------------------------ */
  try {
    const res = await fetch(url, {
      ...init,
      headers,
      credentials: "include",
      signal: controller.signal,
      body:
        body instanceof FormData
          ? body
          : body !== undefined
            ? JSON.stringify(body)
            : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* keep as string */
      }
      throw new ApiError(res.status, res.statusText, parsed);
    }

    /* 204 No Content */
    if (res.status === 204) return undefined as T;

    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return (await res.json()) as T;
    }

    return (await res.text()) as T;
  } catch (err) {
    // Network-level failures: server unreachable (TypeError) or request timeout (AbortError)
    if (err instanceof TypeError) {
      _networkErrorHandler?.("Cannot reach the server. Make sure the API is running.");
    } else if (err instanceof DOMException && err.name === "AbortError") {
      _networkErrorHandler?.("Request timed out. The server took too long to respond.");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/*  Convenience methods                                               */
/* ------------------------------------------------------------------ */

export const api = {
  get: <T = unknown>(path: string, opts?: RequestOptions) =>
    request<T>(path, { ...opts, method: "GET" }),

  post: <T = unknown>(path: string, body?: unknown, opts?: RequestOptions) =>
    request<T>(path, { ...opts, method: "POST", body }),

  put: <T = unknown>(path: string, body?: unknown, opts?: RequestOptions) =>
    request<T>(path, { ...opts, method: "PUT", body }),

  patch: <T = unknown>(path: string, body?: unknown, opts?: RequestOptions) =>
    request<T>(path, { ...opts, method: "PATCH", body }),

  delete: <T = unknown>(path: string, opts?: RequestOptions) =>
    request<T>(path, { ...opts, method: "DELETE" }),
} as const;
