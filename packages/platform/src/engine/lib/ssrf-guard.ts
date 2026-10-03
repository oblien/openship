/**
 * SSRF guard for user-supplied outbound targets (webhook URLs, backup-destination
 * endpoints/hosts, container registry hosts, …). Blocks loopback / private /
 * link-local / metadata / CGNAT / ULA destinations, and — for hostnames —
 * resolves DNS and rejects if ANY resolved address is private (defeats DNS
 * rebinding). Centralized so every outbound sink shares one policy instead of
 * ad-hoc per-call regexes (SaaS audit: 3 separate SSRF sinks had none).
 *
 * Two entry points:
 *   - `assertPublicUrlLiteral` / `assertPublicHostLiteral` — sync, literal-only
 *     (no DNS). Use at create/update validation time to reject obvious abuse.
 *   - `assertPublicUrl` / `assertPublicHost` — async, resolves DNS and pins the
 *     policy to every resolved IP. Use at fetch/connect time (the real defense
 *     against a hostname that later resolves to a private IP).
 */

import { lookup } from "node:dns/promises";
import net from "node:net";
import ipaddr from "ipaddr.js";
import { AppError } from "@repo/core";

export class SsrfError extends AppError {
  readonly status = 400;
  constructor(message: string) {
    super(message, 400, "SSRF_BLOCKED");
    this.name = "SsrfError";
  }
}

/**
 * Classify an IP literal (v4/v6, incl. v4-mapped / NAT64) as non-public. Uses
 * ipaddr.js's audited range classifier instead of hand-rolled range checks:
 * anything that isn't a globally-routable unicast address is refused. v4-mapped
 * IPv6 (`::ffff:…`, dotted OR hex) is unwrapped to its embedded v4 and classified
 * there, so `::ffff:7f00:1` (127.0.0.1) / `::ffff:a9fe:a9fe` (metadata) are caught.
 */
export function isPrivateIp(ipRaw: string): boolean {
  const ip = ipRaw.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!ipaddr.isValid(ip)) return false; // not an IP literal
  const addr = ipaddr.parse(ip);
  if (addr.kind() === "ipv6") {
    const v6 = addr as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) return v6.toIPv4Address().range() !== "unicast";
    // Only a global unicast v6 is allowed — rejects loopback / linkLocal /
    // uniqueLocal / multicast / reserved / unspecified AND the v4-embedding
    // transition ranges (NAT64 rfc6052, rfc6145, 6to4, teredo).
    return v6.range() !== "unicast";
  }
  return (addr as ipaddr.IPv4).range() !== "unicast";
}

/** A hostname literal (not an IP) that must never be reached. */
export function isBlockedHostname(host: string): boolean {
  const h = normalizeHost(host);
  return (
    h === "localhost" ||
    h === "ip6-localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".internal") ||
    h.endsWith(".local")
  );
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
}

/** Sync literal-only host guard (no DNS). Throws SsrfError if blocked. */
export function assertPublicHostLiteral(hostRaw: string): void {
  const host = normalizeHost(hostRaw);
  if (!host) throw new SsrfError("Empty host");
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new SsrfError(`Refusing request to a private/loopback IP: ${host}`);
    return;
  }
  if (isBlockedHostname(host)) throw new SsrfError(`Refusing request to an internal host: ${host}`);
}

/** Sync literal-only URL guard. `allowHttp` permits plaintext http (default https-only). */
export function assertPublicUrlLiteral(raw: string, opts: { allowHttp?: boolean } = {}): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfError(`Malformed URL: ${raw}`);
  }
  if (url.protocol !== "https:" && !(opts.allowHttp && url.protocol === "http:")) {
    throw new SsrfError(`Only ${opts.allowHttp ? "http(s)" : "https"} URLs are allowed: ${raw}`);
  }
  assertPublicHostLiteral(url.hostname);
}

/** Async host guard: literal check + DNS-resolve and reject if ANY resolved
 *  address is private (DNS-rebinding defense). Use at connect/fetch time. */
export async function assertPublicHost(hostRaw: string): Promise<void> {
  await resolvePinnedHost(hostRaw);
}

/** Resolve + validate a host, returning a pinned IP to connect to. */
export async function resolvePinnedHost(
  hostRaw: string,
  allowPrivate = false,
  signal: AbortSignal = AbortSignal.timeout(10_000),
): Promise<{ ip: string; family: number }> {
  const host = normalizeHost(hostRaw);
  if (!host) throw new SsrfError("Empty host");
  signal.throwIfAborted();
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
    // dns.lookup cannot be cancelled. Stop awaiting it at the deadline, and
    // never start an HTTP request if the resolver eventually completes late.
    addrs = await new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const aborted = () => reject(signal.reason);
      signal.addEventListener("abort", aborted, { once: true });
      lookup(host, { all: true })
        .then(resolve, reject)
        .finally(() => {
          signal.removeEventListener("abort", aborted);
        });
    });
  } catch {
    signal.throwIfAborted();
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

/** Async URL guard: protocol + literal + DNS-pin. Use at fetch time. */
export async function assertPublicUrl(raw: string, opts: { allowHttp?: boolean } = {}): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfError(`Malformed URL: ${raw}`);
  }
  if (url.protocol !== "https:" && !(opts.allowHttp && url.protocol === "http:")) {
    throw new SsrfError(`Only ${opts.allowHttp ? "http(s)" : "https"} URLs are allowed: ${raw}`);
  }
  await assertPublicHost(url.hostname);
}
