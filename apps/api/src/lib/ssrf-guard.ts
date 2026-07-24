/**
 * SSRF guard for server-initiated HTTP requests to user-supplied URLs.
 *
 * Currently used by the outbound webhook notification channel: an operator (or,
 * on the multi-tenant SaaS, any org member) supplies a URL and the API POSTs to
 * it. Without a guard that URL can point at cloud metadata (169.254.169.254),
 * loopback, or the internal network — a classic SSRF.
 *
 * A literal-hostname denylist alone is not enough:
 *   - A hostname the attacker controls can resolve to a private/metadata IP
 *     (DNS rebinding), so we must inspect the RESOLVED addresses, not the name.
 *   - Numeric IP encodings (decimal `2130706433`, hex `0x7f000001`, octal) slip
 *     past dotted-quad regexes; getaddrinfo normalises them, so resolving and
 *     checking the result covers them too.
 *
 * So the authoritative check (`assertPublicHttpsUrl`) resolves the host and
 * rejects if the literal host OR any resolved address falls in a non-public
 * range. A cheaper synchronous literal check (`isBlockedHostLiteral`) is exposed
 * for input validation, where DNS-time-of-check is pointless (rebinding) and we
 * only want fast feedback on obviously-local input.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfBlockedError";
  }
}

/**
 * IPv4 in a loopback, private, link-local, CGNAT, or "this network" block.
 * A string that isn't a clean dotted quad is refused (caller only passes
 * values `isIP()` already classified as IPv4, so this is defence in depth).
 */
function isPrivateIpv4(ip: string): boolean {
  const octets = ip.split(".");
  if (octets.length !== 4) return true;
  const nums = octets.map((o) => Number(o));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = nums;
  if (a === 0) return true; //                       0.0.0.0/8  "this network"
  if (a === 10) return true; //                      10.0.0.0/8  RFC1918
  if (a === 127) return true; //                     127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; //        169.254.0.0/16 link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 RFC1918
  if (a === 192 && b === 168) return true; //        192.168.0.0/16 RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  return false;
}

/** IPv6 loopback, unspecified, link-local, ULA, or IPv4-mapped private. */
function isPrivateIpv6(ip: string): boolean {
  const v = ip.toLowerCase();
  if (v === "::1" || v === "::") return true; //     loopback / unspecified
  if (/^fe[89ab]/.test(v)) return true; //           fe80::/10 link-local
  if (/^f[cd][0-9a-f]{2}/.test(v)) return true; //   fc00::/7  unique local (ULA)
  const mapped = v.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/); // ::ffff:a.b.c.d
  if (mapped) return isPrivateIpv4(mapped[1]);
  return false;
}

/** True for any IP literal that must not be reachable from a server fetch. */
export function isPrivateIp(ip: string): boolean {
  const host = ip.replace(/^\[|\]$/g, "");
  const family = isIP(host);
  if (family === 4) return isPrivateIpv4(host);
  if (family === 6) return isPrivateIpv6(host);
  return false;
}

/** DNS names that always denote a local/internal target, never a public one. */
function isBlockedHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return (
    h === "localhost" ||
    h === "ip6-localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".local") || //     mDNS / Bonjour
    h.endsWith(".internal") //     GCP/AWS internal zones incl. metadata.google.internal
  );
}

/**
 * Synchronous literal check (no DNS): true when the host is an obviously-local
 * DNS name or a private IP literal. For input validation / fast UX feedback —
 * NOT a substitute for `assertPublicHttpsUrl`, which also resolves DNS.
 */
export function isBlockedHostLiteral(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "");
  if (!h) return true;
  if (isBlockedHostname(h)) return true;
  if (isIP(h) && isPrivateIp(h)) return true;
  return false;
}

/**
 * Assert a user-supplied URL is safe for the server to fetch:
 *   - HTTPS only
 *   - hostname is not a known-local DNS name
 *   - neither the literal host nor ANY DNS-resolved address is loopback,
 *     private, link-local, ULA, CGNAT, or cloud-metadata
 *
 * Throws `SsrfBlockedError` otherwise. Async because it resolves DNS — this is
 * what defeats rebinding and numeric-encoding tricks a name-only check misses.
 */
export async function assertPublicHttpsUrl(rawUrl: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError("URL is malformed");
  }
  if (parsed.protocol !== "https:") {
    throw new SsrfBlockedError("URL must use HTTPS");
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw new SsrfBlockedError("URL has no host");
  if (isBlockedHostname(host)) {
    throw new SsrfBlockedError(`URL targets a local host: ${host}`);
  }

  // IP literal (any notation isIP recognises) → check it directly, no DNS.
  if (isIP(host)) {
    if (isPrivateIp(host)) {
      throw new SsrfBlockedError(`URL targets a private host: ${host}`);
    }
    return;
  }

  // DNS name → resolve and reject if ANY address is non-public. Covers
  // rebinding and numeric-host encodings that getaddrinfo normalises.
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new SsrfBlockedError(`URL host does not resolve: ${host}`);
  }
  if (addresses.length === 0) {
    throw new SsrfBlockedError(`URL host does not resolve: ${host}`);
  }
  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      throw new SsrfBlockedError(`URL host resolves to a private address: ${host} → ${address}`);
    }
  }
}
