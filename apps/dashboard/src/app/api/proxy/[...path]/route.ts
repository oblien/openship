/**
 * Same-host API proxy.
 *
 * Forwards every `/api/proxy/<path>` request from the dashboard to the
 * internal API process (loopback or a config-supplied URL). Enables
 * single-container self-hosted deploys where only the dashboard port is
 * publicly exposed — the API binds to loopback and is reachable only
 * via this proxy.
 *
 * Contract:
 *   - Method, headers, body, query-string forwarded verbatim
 *   - `Host` rewritten to the upstream's host (HTTP/1.1 requires it)
 *   - Hop-by-hop headers stripped per RFC 7230 §6.1
 *   - Response body STREAMED back (SSE / chunked text / large blobs work)
 *   - Bidirectional `X-Forwarded-*` so the upstream sees the original
 *     client (rate limiting, audit logs) instead of just loopback
 *
 * Activated by `NEXT_PUBLIC_API_PROXY=true`; the routing code in
 * apps/dashboard/src/lib/api/urls.ts already lives behind the same flag.
 *
 * Server-side env:
 *   INTERNAL_API_URL  → upstream base (default http://127.0.0.1:4000)
 *   The trailing /api segment on the proxied path lets you re-target the
 *   upstream's URL prefix by changing INTERNAL_API_URL without touching
 *   the client.
 */

import type { NextRequest } from "next/server";

// Hop-by-hop headers — MUST NOT be forwarded by a proxy.
// Per RFC 7230 §6.1 (HTTP/1.1) — Next.js's fetch automatically handles
// content-encoding / transfer-encoding on the OUTGOING request, so any
// of these surviving from the inbound request would corrupt the upstream.
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  // Length is computed by fetch from the actual body it's sending
  "content-length",
]);

// Strip these from the upstream RESPONSE before relaying — they're set
// by the runtime (fetch + edge) and forwarding stale values causes
// chunked-encoding corruption on the browser side.
const RESPONSE_HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-encoding",
  "content-length",
]);

function internalApiBase(): string {
  // INTERNAL_API_URL is the canonical knob (docker-compose, `openship up`).
  // Fall back to OPENSHIP_LOCAL_API_URL so the desktop app — which serves this
  // same proxy-baked bundle but runs the API on a DYNAMIC port and only sets
  // OPENSHIP_LOCAL_API_URL — targets its real API instead of the :4000 default.
  const url =
    process.env.INTERNAL_API_URL ?? process.env.OPENSHIP_LOCAL_API_URL ?? "http://127.0.0.1:4000";
  return url.replace(/\/+$/, "");
}

function buildUpstreamUrl(req: NextRequest, pathSegments: string[]): URL {
  const base = internalApiBase();
  // pathSegments comes from Next.js' [...path] — already URL-decoded.
  // Re-encode each segment so embedded slashes / unicode survive.
  const path = pathSegments.map(encodeURIComponent).join("/");
  const url = new URL(`${base}/${path}`);
  // Preserve original query string verbatim.
  url.search = new URL(req.url).search;
  return url;
}

function buildForwardedHeaders(req: NextRequest, upstream: URL): Headers {
  const out = new Headers();
  for (const [name, value] of req.headers) {
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
    out.set(name, value);
  }
  // Tell the upstream the original client info — for audit logs +
  // rate-limit middleware that uses c.var.clientIp (rate-limiter.ts
  // already accepts loopback peers, but a real X-Forwarded-For makes
  // the rate-limit key match the actual client).
  const xff = req.headers.get("x-forwarded-for");
  const clientIp = req.headers.get("x-real-ip") ?? (req as unknown as { ip?: string }).ip ?? "";
  if (clientIp && !xff) {
    out.set("x-forwarded-for", clientIp);
  }
  if (clientIp) {
    out.set("x-real-ip", clientIp);
  }
  // Original protocol + host so Better Auth's cookie-domain logic
  // sees the public-facing scheme/host (not loopback).
  const proto = req.headers.get("x-forwarded-proto") ?? new URL(req.url).protocol.replace(":", "");
  const host = req.headers.get("x-forwarded-host") ?? new URL(req.url).host;
  out.set("x-forwarded-proto", proto);
  out.set("x-forwarded-host", host);
  // Override Host so HTTP/1.1 routing on the upstream points at the
  // upstream's authority, not the original public host.
  out.set("host", upstream.host);
  return out;
}

/**
 * The actual proxy. Methods are passed through individually so Next.js
 * App Router picks them up — exporting one function shared by all
 * verbs would only work for GET (Next router quirk).
 */
async function proxy(req: NextRequest, pathSegments: string[]): Promise<Response> {
  if (process.env.NEXT_PUBLIC_API_PROXY !== "true") {
    // Defensive: the helpers shouldn't be routing here when the flag
    // is off, but a stray dev fetch shouldn't 200-with-loopback-data.
    return new Response(
      JSON.stringify({
        error: "API proxy is disabled. Set NEXT_PUBLIC_API_PROXY=true to enable single-host mode.",
      }),
      { status: 503, headers: { "content-type": "application/json" } },
    );
  }

  const upstream = buildUpstreamUrl(req, pathSegments);
  const headers = buildForwardedHeaders(req, upstream);

  // Docker Compose first-admin (#138): browser signup is rewritten here, so the
  // API's TCP peer is the dashboard container (bridge IP), not loopback. Inject
  // INTERNAL_TOKEN only for Better Auth sign-up so the API's empty-DB gate can
  // accept it — never for other routes (that would mint god-mode for the browser).
  const internalToken = process.env.INTERNAL_TOKEN?.trim();
  const isSignUp =
    req.method === "POST" &&
    pathSegments.length >= 3 &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "auth" &&
    pathSegments[2] === "sign-up";
  if (internalToken && isSignUp && !headers.has("x-internal-token")) {
    headers.set("x-internal-token", internalToken);
  }

  // Body: pass through directly. fetch accepts a ReadableStream and
  // won't double-buffer it.  duplex:'half' lets the body stream upstream
  // while we wait for the response (required by undici when body is a
  // stream — without it, fetch errors with "duplex: 'half' is required").
  const init: RequestInit & { duplex?: "half" } = {
    method: req.method,
    headers,
    // Some methods (GET/HEAD) MUST NOT have a body per spec — Next's
    // req.body is null for those anyway, so this is safe to assign.
    body: req.body,
    // Critical for SSE / chunked text — we don't want fetch to
    // auto-decompress or buffer, and we DO want HTTP/1.1.
    redirect: "manual",
    duplex: "half",
  };

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(upstream, init);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(
      JSON.stringify({
        error: `Upstream API unreachable at ${upstream.origin}: ${message}`,
      }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }

  // Mirror response headers, minus the hop-by-hop ones that the runtime
  // will recompute on the OUTGOING response anyway.
  const responseHeaders = new Headers();
  for (const [name, value] of upstreamRes.headers) {
    if (RESPONSE_HOP_BY_HOP.has(name.toLowerCase())) continue;
    // set-cookie is handled separately below: `.set()` overwrites, so a
    // multi-cookie auth response (Better Auth sends session_token +
    // session_data) would lose all but the last one and the browser would
    // never receive a session.
    if (name.toLowerCase() === "set-cookie") continue;
    responseHeaders.set(name, value);
  }

  // Preserve EVERY Set-Cookie header individually. getSetCookie() is the
  // only spec-correct way to read multiples off a fetch Response.
  for (const cookie of upstreamRes.headers.getSetCookie()) {
    responseHeaders.append("set-cookie", cookie);
  }

  // Stream the body straight through — for SSE (text/event-stream)
  // and large JSON / file responses alike. Next + fetch handle the
  // chunked-encoding plumbing on the outgoing side.
  return new Response(upstreamRes.body, {
    status: upstreamRes.status,
    statusText: upstreamRes.statusText,
    headers: responseHeaders,
  });
}

type RouteParams = { params: Promise<{ path: string[] }> };

export async function GET(req: NextRequest, { params }: RouteParams): Promise<Response> {
  return proxy(req, (await params).path);
}

export async function POST(req: NextRequest, { params }: RouteParams): Promise<Response> {
  return proxy(req, (await params).path);
}

export async function PATCH(req: NextRequest, { params }: RouteParams): Promise<Response> {
  return proxy(req, (await params).path);
}

export async function PUT(req: NextRequest, { params }: RouteParams): Promise<Response> {
  return proxy(req, (await params).path);
}

export async function DELETE(req: NextRequest, { params }: RouteParams): Promise<Response> {
  return proxy(req, (await params).path);
}

export async function OPTIONS(req: NextRequest, { params }: RouteParams): Promise<Response> {
  return proxy(req, (await params).path);
}

export async function HEAD(req: NextRequest, { params }: RouteParams): Promise<Response> {
  return proxy(req, (await params).path);
}

// Disable Next's static optimization for this route — every request
// must hit our handler.
export const dynamic = "force-dynamic";
// SSE / streaming bodies require Node runtime (Edge runtime would
// buffer in some configurations).
export const runtime = "nodejs";
