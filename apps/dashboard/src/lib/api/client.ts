/**
 * Standard API client for the Openship dashboard.
 *
 * Use this for all non-auth API calls (projects, deployments, domains, etc.).
 * Auth calls should go through `auth-client.ts` (Better Auth SDK).
 *
 * Features:
 *   - Automatic base URL resolution (`NEXT_PUBLIC_API_URL`)
 *   - 15s request timeout (configurable per-call)
 *   - Credentials included by default (cookies forwarded cross-origin)
 *   - Typed JSON responses via generics
 *   - Consistent error shape (`ApiError`)
 */

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api";
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

/* ------------------------------------------------------------------ */
/*  Request helper                                                    */
/* ------------------------------------------------------------------ */

export type RequestOptions = Omit<RequestInit, "body"> & {
  /** Request body — objects are JSON-serialised automatically. */
  body?: unknown;
  /** Per-request timeout in ms (default 15 000). */
  timeout?: number;
  /** URL search params appended to the path. */
  params?: Record<string, string | number | boolean | undefined>;
};

/**
 * Low-level fetch wrapper — prefer the convenience methods below.
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

  /* --- Timeout ---------------------------------------------------- */
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  /* --- Headers ---------------------------------------------------- */
  const headers = new Headers(init.headers);

  if (body && typeof body === "object" && !(body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
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
