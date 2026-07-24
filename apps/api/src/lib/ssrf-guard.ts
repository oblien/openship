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

export class SsrfError extends Error {
  readonly status = 400;
  readonly code = "SSRF_BLOCKED";
  constructor(message: string) {
    super(message);
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
  const h = host.toLowerCase();
  return (
    h === "localhost" ||
    h === "ip6-localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".internal") ||
    h.endsWith(".local")
  );
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\[|\]$/g, "");
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
  const host = normalizeHost(hostRaw);
  assertPublicHostLiteral(host);
  if (net.isIP(host)) return; // already validated as a public literal
  let addrs: { address: string }[];
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    throw new SsrfError(`Cannot resolve host: ${host}`);
  }
  if (addrs.length === 0) throw new SsrfError(`Host does not resolve: ${host}`);
  for (const a of addrs) {
    if (isPrivateIp(a.address)) {
      throw new SsrfError(`Host ${host} resolves to a private/loopback IP (${a.address})`);
    }
  }
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
