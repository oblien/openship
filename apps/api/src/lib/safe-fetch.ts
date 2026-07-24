/**
 * SSRF-safe HTTP client for user-influenced outbound targets (notification
 * webhooks, container-registry lookups). It closes the DNS-rebinding TOCTOU that
 * a validate-then-fetch pattern leaves open: it resolves the host ONCE, validates
 * every resolved address, then CONNECTS TO THE VALIDATED IP (never re-resolves),
 * preserving the TLS servername + Host header so certs still verify and virtual
 * hosts still route. Redirects are followed only after re-validating each hop.
 *
 * Portable across Node and Bun (uses node:http/https — Bun's `fetch` can't pin
 * DNS and undici dispatchers are Node-only). Use this instead of `fetch` for any
 * target whose host is influenced by user/remote input.
 */

import http from "node:http";
import https from "node:https";
import { lookup } from "node:dns/promises";
import net from "node:net";
import { SsrfError, isPrivateIp, isBlockedHostname } from "./ssrf-guard";

export interface SafeFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  /** Permit plaintext http (default: https only). */
  allowHttp?: boolean;
  /** Permit private/loopback/internal targets — self-hosted opt-in only.
   *  Default false (reject). The IP is still pinned either way. */
  allowPrivate?: boolean;
  /** Max redirects to follow (each hop re-validated). Default 0 (a 3xx is
   *  returned as-is; callers that treat non-2xx as failure thus reject it). */
  maxRedirects?: number;
  /** Cap the buffered response body. Default 5 MiB. */
  maxBodyBytes?: number;
}

export interface SafeFetchResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  text(): Promise<string>;
  json(): Promise<unknown>;
  /** Raw response bytes (NOT UTF-8 decoded) — for binary downloads. Bounded by
   *  `maxBodyBytes`, so raise that cap for large artifacts. */
  bytes(): Promise<Buffer>;
}

/** Resolve + validate a host, returning a pinned IP to connect to. */
async function resolvePinnedIp(host: string, allowPrivate: boolean): Promise<{ ip: string; family: number }> {
  const literal = net.isIP(host);
  if (literal) {
    if (!allowPrivate && isPrivateIp(host)) {
      throw new SsrfError(`Refusing request to a private/loopback IP: ${host}`);
    }
    return { ip: host, family: literal };
  }
  if (!allowPrivate && isBlockedHostname(host)) {
    throw new SsrfError(`Refusing request to an internal host: ${host}`);
  }
  let addrs: { address: string; family: number }[];
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    throw new SsrfError(`Cannot resolve host: ${host}`);
  }
  if (addrs.length === 0) throw new SsrfError(`Host does not resolve: ${host}`);
  if (!allowPrivate) {
    for (const a of addrs) {
      if (isPrivateIp(a.address)) {
        throw new SsrfError(`Host ${host} resolves to a private/loopback IP (${a.address})`);
      }
    }
  }
  // Prefer IPv4, else the first resolved address.
  const chosen = addrs.find((a) => a.family === 4) ?? addrs[0];
  return { ip: chosen.address, family: chosen.family };
}

/** Headers that must never cross a redirect to a DIFFERENT host (credential
 *  leak) — matches fetch's cross-origin stripping. */
function stripCredentialHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    const lower = k.toLowerCase();
    if (lower === "authorization" || lower === "cookie" || lower === "proxy-authorization") continue;
    out[k] = v;
  }
  return out;
}

export async function safeFetch(rawUrl: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResponse> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfError(`Malformed URL: ${rawUrl}`);
  }
  const isHttps = url.protocol === "https:";
  if (!isHttps && !(opts.allowHttp && url.protocol === "http:")) {
    throw new SsrfError(`Only ${opts.allowHttp ? "http(s)" : "https"} URLs are allowed: ${rawUrl}`);
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");
  const allowPrivate = opts.allowPrivate ?? false;
  const { ip, family } = await resolvePinnedIp(host, allowPrivate);

  const mod = isHttps ? https : http;
  const port = url.port ? Number(url.port) : isHttps ? 443 : 80;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const maxBodyBytes = opts.maxBodyBytes ?? 5_000_000;

  const reqHeaders: Record<string, string> = { ...opts.headers, Host: url.host };
  // Set Content-Length explicitly — otherwise node falls back to chunked
  // transfer-encoding for the body, which some strict webhook receivers reject.
  if (opts.body !== undefined) reqHeaders["Content-Length"] = String(Buffer.byteLength(opts.body));

  const res = await new Promise<SafeFetchResponse>((resolve, reject) => {
    let deadline: ReturnType<typeof setTimeout>;
    const req = mod.request(
      {
        host: ip, // connect to the VALIDATED ip — never re-resolve `host`
        family,
        port,
        method: opts.method ?? "GET",
        path: `${url.pathname}${url.search}`,
        // Preserve the real hostname for virtual-host routing + cert validation.
        headers: reqHeaders,
        ...(isHttps ? { servername: host, rejectUnauthorized: true } : {}),
      },
      (r) => {
        const status = r.statusCode ?? 0;
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(r.headers)) {
          headers[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : (v ?? "");
        }
        const chunks: Buffer[] = [];
        let total = 0;
        let truncated = false;
        r.on("data", (c: Buffer) => {
          total += c.length;
          if (total <= maxBodyBytes) chunks.push(c);
          else if (!truncated) {
            truncated = true;
            req.destroy(new Error("safeFetch: response body exceeds cap"));
          }
        });
        r.on("end", () => {
          clearTimeout(deadline);
          const body = Buffer.concat(chunks);
          resolve({
            status,
            ok: status >= 200 && status < 300,
            headers,
            text: async () => body.toString("utf8"),
            json: async () => JSON.parse(body.toString("utf8")),
            bytes: async () => body,
          });
        });
        r.on("error", (e) => {
          clearTimeout(deadline);
          reject(e);
        });
      },
    );
    // Hard TOTAL-request deadline — the socket idle-timeout alone can't bound a
    // slow drip (a server sending 1 byte every <timeout keeps it alive forever).
    deadline = setTimeout(() => req.destroy(new SsrfError(`Request to ${host} timed out`)), timeoutMs);
    req.on("error", (e) => {
      clearTimeout(deadline);
      reject(e);
    });
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });

  // Redirects: follow only after re-validating the next hop (never blindly
  // chase a 3xx into the internal network). A 3xx with no budget is returned
  // as-is so a caller treating non-2xx as failure rejects it.
  if (res.status >= 300 && res.status < 400 && (opts.maxRedirects ?? 0) > 0) {
    const location = res.headers["location"];
    if (location) {
      const nextUrl = new URL(location, url);
      // Never carry credentials to a DIFFERENT host on redirect.
      const nextHeaders =
        nextUrl.host === url.host ? opts.headers : stripCredentialHeaders(opts.headers);
      return safeFetch(nextUrl.toString(), {
        ...opts,
        headers: nextHeaders,
        maxRedirects: (opts.maxRedirects ?? 0) - 1,
      });
    }
  }
  return res;
}
