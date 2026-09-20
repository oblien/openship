/**
 * Shared DNS resolution helper for verification + preflight flows.
 *
 * Two consumers, identical requirements:
 *   - apps/api/src/modules/domains/domain.service.ts — domain
 *     ownership verification (A / CNAME / TXT).
 *   - apps/api/src/modules/deployments/preflight.ts — pre-deploy
 *     DNS sanity check (A / AAAA / CNAME).
 *
 * Resolution strategy:
 *   1. Google DNS-over-HTTPS (`https://dns.google/resolve`) first.
 *      Cache- and topology-friendly: bypasses the host's resolver and
 *      gives a globally consistent answer in regions where the local
 *      ISP resolver is slow or wrong. Bounded by AbortSignal.timeout.
 *   2. node:dns local resolver as fallback. Wrapped in
 *      Promise.race(timeout) so a black-holed resolver can't stall a
 *      preflight modal.
 *
 * Returns `[]` on any failure. Callers decide whether empty results
 * mean "no records exist" or "DNS unreachable" — typically both
 * outcomes warrant the same user-facing "DNS isn't ready" message.
 */

import dns from "node:dns/promises";

const GOOGLE_DNS = "https://dns.google/resolve";
const DEFAULT_TIMEOUT_MS = 5_000;

const RRTYPE: Record<DnsRecordType, number> = {
  A: 1,
  AAAA: 28,
  CNAME: 5,
  TXT: 16,
};

export type DnsRecordType = "A" | "AAAA" | "CNAME" | "TXT";

interface GoogleDnsAnswer {
  name: string;
  type: number;
  data: string;
}

export interface ResolveOptions {
  /** Per-source timeout. Google DoH gets this via AbortSignal; the
   *  node:dns fallback gets it via Promise.race. */
  timeoutMs?: number;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race<T>([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`dns_timeout:${label}`)), ms),
    ),
  ]);
}

async function resolveViaLocal(name: string, type: DnsRecordType): Promise<string[]> {
  switch (type) {
    case "A":
      return dns.resolve4(name);
    case "AAAA":
      return dns.resolve6(name);
    case "CNAME":
      return dns.resolveCname(name);
    case "TXT": {
      const rows = await dns.resolveTxt(name);
      return rows.flat();
    }
  }
}

/**
 * Resolve a DNS record. Prefers Google DoH, falls back to node:dns,
 * returns `[]` on any error or timeout. Both sources are bounded by
 * `timeoutMs` (default 5s).
 */
export async function resolveRecords(
  name: string,
  type: DnsRecordType,
  opts: ResolveOptions = {},
): Promise<string[]> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // 1) Google DoH
  try {
    const url = `${GOOGLE_DNS}?name=${encodeURIComponent(name)}&type=${RRTYPE[type]}`;
    const res = await fetch(url, {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) {
      const json = (await res.json()) as { Answer?: GoogleDnsAnswer[] };
      return (json.Answer ?? []).map((a) => a.data.replace(/^"|"$/g, ""));
    }
  } catch {
    // DoH unreachable / blocked — fall through to node:dns.
  }

  // 2) node:dns fallback with bounded timeout
  try {
    return await withTimeout(resolveViaLocal(name, type), timeoutMs, type);
  } catch {
    return [];
  }
}

/**
 * Resolve a hostname to one or more IP addresses (follows CNAMEs via
 * the OS resolver). Used by preflight to compare a custom domain
 * against the configured server's IP.
 */
export async function lookupAddresses(
  hostname: string,
  opts: ResolveOptions = {},
): Promise<string[]> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    const result = await withTimeout(
      dns.lookup(hostname, { all: true }),
      timeoutMs,
      "lookup",
    );
    return result.map((entry) => entry.address);
  } catch {
    return [];
  }
}
