import "server-only";
import { cookies, headers } from "next/headers";
import { getApiOriginFromHeaders } from "@/lib/api/urls";

/**
 * Server-side API client for Next.js server components, layouts, and route handlers.
 *
 * Automatically forwards the browser's cookies to the Openship API
 * so session authentication works transparently.
 *
 * Usage:
 *   import { serverApi } from "@/lib/server/api";
 *   const projects = await serverApi.get<Project[]>("/projects");
 */

const DEFAULT_TIMEOUT = 10_000;

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

export class ServerApiError extends Error {
  constructor(
    public status: number,
    public statusText: string,
    public body: unknown,
  ) {
    super(`API ${status}: ${statusText}`);
    this.name = "ServerApiError";
  }
}

type ServerRequestOptions = {
  body?: unknown;
  timeout?: number;
  params?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  /** Next.js fetch cache strategy */
  cache?: RequestCache;
  /** Next.js revalidation interval in seconds */
  revalidate?: number;
};

/* ------------------------------------------------------------------ */
/*  Core request                                                      */
/* ------------------------------------------------------------------ */

async function request<T = unknown>(
  method: string,
  path: string,
  opts: ServerRequestOptions = {},
): Promise<T> {
  const { body, timeout = DEFAULT_TIMEOUT, params, headers: extraHeaders, cache, revalidate } = opts;
  const requestHeaders = await headers();
  const baseUrl = getApiOriginFromHeaders(requestHeaders);

  /* --- Build URL -------------------------------------------------- */
  const url = new URL(path.startsWith("/") ? path : `/${path}`, baseUrl);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }

  /* --- Forward cookies -------------------------------------------- */
  const cookieStore = await cookies();
  const cookieHeader = cookieStore
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");

  /* --- Headers ---------------------------------------------------- */
  const outboundHeaders: Record<string, string> = {
    ...extraHeaders,
    cookie: cookieHeader,
  };

  if (body && typeof body === "object" && !(body instanceof FormData)) {
    outboundHeaders["content-type"] = "application/json";
  }

  /* --- Timeout ---------------------------------------------------- */
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  /* --- Fetch ------------------------------------------------------ */
  try {
    const res = await fetch(url, {
      method,
      headers: outboundHeaders,
      signal: controller.signal,
      body:
        body instanceof FormData
          ? body
          : body !== undefined
            ? JSON.stringify(body)
            : undefined,
      ...(cache !== undefined ? { cache } : {}),
      ...(revalidate !== undefined ? { next: { revalidate } } : {}),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* keep as string */
      }
      throw new ServerApiError(res.status, res.statusText, parsed);
    }

    if (res.status === 204) return undefined as T;

    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) return (await res.json()) as T;
    return (await res.text()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/*  Convenience methods                                               */
/* ------------------------------------------------------------------ */

export const serverApi = {
  get: <T = unknown>(path: string, opts?: ServerRequestOptions) =>
    request<T>("GET", path, opts),

  post: <T = unknown>(path: string, body?: unknown, opts?: ServerRequestOptions) =>
    request<T>("POST", path, { ...opts, body }),

  put: <T = unknown>(path: string, body?: unknown, opts?: ServerRequestOptions) =>
    request<T>("PUT", path, { ...opts, body }),

  patch: <T = unknown>(path: string, body?: unknown, opts?: ServerRequestOptions) =>
    request<T>("PATCH", path, { ...opts, body }),

  delete: <T = unknown>(path: string, opts?: ServerRequestOptions) =>
    request<T>("DELETE", path, opts),
} as const;
