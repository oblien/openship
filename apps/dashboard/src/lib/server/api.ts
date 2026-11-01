import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import "server-only";
import { cookies, headers } from "next/headers";
import { getApiOrigin, getRequestOriginFromHeaders } from "@/lib/api/urls";

/**
 * Server-side API client for Next.js server components, layouts, and route handlers.
 *
 * Automatically forwards the browser's cookies to the Openship API
 * so session authentication works transparently.
 *
 * Usage:
 *   import { serverApi } from "@/lib/server/api";
 *   const projects = await serverApi.get<Project[]>("projects");
 *   const state   = await serverApi.get<BillingState>("billing/state");
 *
 * Path convention: bare resource paths, no leading `/api/`. The base
 * URL ends in `/api/` and the request builder resolves your path
 * relative to it. This matches the browser-side client at
 * `lib/api/client.ts` so the two clients are interchangeable from a
 * caller's perspective — only their fetch transport differs.
 */

const DEFAULT_TIMEOUT = 10_000;

/**
 * Parse a raw Set-Cookie header into the shape Next.js `cookies().set()`
 * accepts. Supports the attributes the API actually uses: Path, Domain,
 * Expires, Max-Age, HttpOnly, Secure, SameSite. Unknown attributes are
 * ignored. Returns null when the name/value cannot be parsed.
 */
type ParsedSetCookie = {
  name: string;
  value: string;
  options: {
    path?: string;
    domain?: string;
    expires?: Date;
    maxAge?: number;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: "lax" | "strict" | "none";
  };
};
function parseSetCookie(raw: string): ParsedSetCookie | null {
  const parts = raw.split(";").map((s) => s.trim());
  const first = parts.shift();
  if (!first) return null;
  const eq = first.indexOf("=");
  if (eq <= 0) return null;
  const name = first.slice(0, eq);
  // Next's cookie setter encodes values; decode the API's wire value exactly
  // once so refreshed session signatures are not percent-encoded twice.
  let value: string;
  try {
    value = decodeURIComponent(first.slice(eq + 1));
  } catch {
    return null;
  }
  const options: ParsedSetCookie["options"] = {};
  for (const attr of parts) {
    const lower = attr.toLowerCase();
    if (lower === "httponly") options.httpOnly = true;
    else if (lower === "secure") options.secure = true;
    else if (lower.startsWith("path=")) options.path = attr.slice(5);
    else if (lower.startsWith("domain=")) options.domain = attr.slice(7);
    else if (lower.startsWith("max-age=")) {
      const n = Number(attr.slice(8));
      if (!Number.isNaN(n)) options.maxAge = n;
    } else if (lower.startsWith("expires=")) {
      const d = new Date(attr.slice(8));
      if (!Number.isNaN(d.getTime())) options.expires = d;
    } else if (lower.startsWith("samesite=")) {
      const v = attr.slice(9).toLowerCase();
      if (v === "lax" || v === "strict" || v === "none") options.sameSite = v;
    }
  }
  return { name, value, options };
}

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

export class ServerApiError extends Error {
  constructor(
    public status: number,
    public statusText: string,
    public body: unknown,
    public requestId?: string,
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

/**
 * Server-side API base URL — ALWAYS ends in `/api/` so callers pass
 * bare paths (`"billing/state"`, `"projects/home"`) without worrying
 * about prefix consistency. Matches the browser-side client's
 * `getRestApiBaseUrl()` convention exactly so both clients accept the
 * same call shape.
 *
 * When proxy mode is on (NEXT_PUBLIC_API_PROXY=true), the SSR layer
 * could route via `/api/proxy/*` on its own origin — but that's a
 * pointless self-fetch hop. Short-circuit to INTERNAL_API_URL when it
 * exists; the server has direct access. Falls through to the normal
 * getApiOrigin() (runtime-config table) otherwise.
 *
 * Returns a string guaranteed to end with `/api/` (trailing slash).
 */
function getServerApiBaseUrl(requestHeaders: Headers): string {
  let origin: string;
  // Desktop: the API runs on a dynamic port Electron injects here. Wins over
  // the header→table fallback (which can't know a dynamic port).
  const localOverride = process.env.OPENSHIP_LOCAL_API_URL?.replace(/\/+$/, "");
  const internal = process.env.INTERNAL_API_URL?.replace(/\/+$/, "");
  if (localOverride) {
    origin = localOverride;
  } else if (internal) {
    // SSR-only override; the public origin used by the browser may not resolve from here (e.g. Docker service DNS).
    origin = internal;
  } else {
    origin = getApiOrigin(getRequestOriginFromHeaders(requestHeaders));
  }
  // Trailing slash matters: `new URL("billing/state", ".../api/")`
  // resolves correctly; `new URL("billing/state", ".../api")` (no slash)
  // would strip `/api` because URL spec treats `/api` as a file, not a
  // directory.
  return origin.endsWith("/api/") ? origin : `${origin}/api/`;
}

async function request<T = unknown>(
  method: string,
  path: string,
  opts: ServerRequestOptions = {},
): Promise<T> {
  const { body, timeout = DEFAULT_TIMEOUT, params, headers: extraHeaders, cache, revalidate } = opts;
  const requestHeaders = await headers();
  const baseUrl = getServerApiBaseUrl(requestHeaders);

  /* --- Build URL --------------------------------------------------
   * Strip the caller's leading slash so the path resolves RELATIVE to
   * the `/api/` base (URL spec: an absolute path in the first arg
   * replaces the base's path, dropping our /api prefix). Mirrors the
   * browser client at lib/api/client.ts.
   */
  const cleanPath = path.startsWith("/") ? path.slice(1) : path;
  const url = new URL(cleanPath, baseUrl);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }

  /* --- Forward cookies -------------------------------------------- */
  const cookieStore = await cookies();
  const cookieHeader = cookieStore
    .getAll()
    // Next has decoded these values. Serialize them back onto the wire,
    // including Latin-1, delimiters and percent signs, without changing meaning.
    .map((c) => `${c.name}=${encodeURIComponent(c.value)}`)
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

    // Forward Set-Cookie headers from the API back to the browser.
    //
    // The dashboard server proxies requests to the API on the user's
    // behalf - the API runs at a different origin (localhost:4000 in
    // dev, also separately mounted in prod). When the API sets a
    // session cookie via Set-Cookie, that header lands on THIS server,
    // not on the browser. Without forwarding it, the browser never
    // gets the cookie and any flow that depends on a cookie being
    // minted server-side (the zero-auth /get-session bootstrap, for
    // example) silently fails - every page render mints a fresh
    // session that the browser then forgets, producing an infinite
    // redirect loop between the dashboard middleware (cookie check)
    // and (auth)/layout (session check).
    //
    // Preserve cookie values and supported attributes, converting the wire
    // value to the decoded form Next expects. The API is trusted (we control both
    // sides), so we don't filter by name. Errors during the cookies()
    // call (which can happen if invoked outside a request context like
    // a generateStaticParams build) are swallowed - those code paths
    // don't need session cookies anyway.
    try {
      const setCookies =
        typeof (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie === "function"
          ? (res.headers as Headers & { getSetCookie: () => string[] }).getSetCookie()
          : [];
      if (setCookies.length > 0) {
        const cookieStore = await cookies();
        for (const raw of setCookies) {
          const parsed = parseSetCookie(raw);
          if (parsed) cookieStore.set(parsed.name, parsed.value, parsed.options);
        }
      }
    } catch (diagnosticFailure) {
      observeCaughtError(diagnosticFailure, "dashboard/lib/server/api");
      /* outside request context - no response to attach cookies to */
    }

    if (!res.ok) {
      const text = await res.text().catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "dashboard/lib/server/api"); return ""; });
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* keep as string */
      }
      throw new ServerApiError(res.status, res.statusText, parsed, res.headers.get("X-Request-ID") ?? undefined);
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
