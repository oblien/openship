/**
 * Cloudflare DNS provider.
 *
 * Talks to the v4 REST API with a scoped API token (Zone:Read + DNS:Edit). No
 * account ID needed: zone discovery is a name lookup, and every record call is
 * zone-scoped.
 */

import type {
  DnsProvider,
  DnsProviderCredentials,
  DnsRecord,
  DnsRecordInput,
  DnsRecordType,
  DnsZone,
} from "../types";
import {
  DnsApiError,
  DnsRecordConflictError,
  OPENSHIP_RECORD_COMMENT,
  isOpenshipManaged,
} from "../types";

const CF_API_BASE = "https://api.cloudflare.com/client/v4";

/** Cloudflare's max page size for DNS record lists. */
const PER_PAGE = 100;

/**
 * Hard stop on the pagination loop. A zone with more than 5 000 records at one
 * name does not exist; this exists so a provider that keeps reporting
 * `total_pages` can't spin us forever.
 */
const MAX_PAGES = 50;

/**
 * How many domain suffixes we'll probe when looking for the zone.
 *
 * The walk is most-specific-first so a Cloudflare subdomain zone wins over its
 * parent. The cap bounds outbound calls per lookup — real hostnames are 2-5
 * labels, so it never truncates a genuine candidate, and it stops a long
 * caller-supplied name from turning one request into hundreds.
 */
const MAX_ZONE_CANDIDATES = 8;

interface CfResponse<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  messages: string[];
  result: T;
  result_info?: { page: number; per_page: number; count: number; total_count: number; total_pages: number };
}

interface CfTokenVerifyResult {
  id: string;
  status: string;
}

interface CfZoneItem {
  id: string;
  name: string;
  status: string;
}

interface CfDnsRecordItem {
  id: string;
  zone_id: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
  proxied: boolean;
  priority?: number;
  comment?: string | null;
}

/** api.cloudflare.com should never hang. This runs inline on `POST /domains`:
 *  zone discovery walks up to MAX_ZONE_CANDIDATES suffixes per credential and
 *  then lists+writes once per record, so an unbounded call holds the operator's
 *  request open long past the point their client gave up on it. */
const CF_FETCH_TIMEOUT_MS = 15_000;

/** Call the Cloudflare REST API, returning the whole envelope. */
async function cfRequest<T>(
  apiToken: string,
  path: string,
  options: RequestInit = {},
): Promise<CfResponse<T>> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiToken}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    ...(options.headers as Record<string, string> | undefined),
  };

  // The deadline covers reading the body, not just the handshake: a response that
  // never finishes streaming stalls the caller exactly like one that never arrives.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CF_FETCH_TIMEOUT_MS);

  let res: Response;
  let text: string;
  try {
    res = await fetch(`${CF_API_BASE}${path}`, {
      ...options,
      headers,
      signal: controller.signal,
    });
    text = await res.text();
  } catch (err) {
    // DNS failure, TLS error, connection reset, or our own timeout —
    // indistinguishable from a 5xx to the caller, and just as transient. 503 keeps
    // `isTransient` true so the caller reports "couldn't check" rather than "not
    // managed here".
    throw new DnsApiError("cloudflare", 503, err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }

  let body: CfResponse<T>;
  try {
    body = JSON.parse(text) as CfResponse<T>;
  } catch {
    throw new DnsApiError(
      "cloudflare",
      res.status,
      `non-JSON response: ${text.slice(0, 150)}`,
    );
  }

  if (!res.ok || !body.success) {
    const detail = body.errors?.map((e) => e.message).filter(Boolean).join(", ");
    throw new DnsApiError("cloudflare", res.status, detail || `HTTP ${res.status}`);
  }

  return body;
}

/** Call the API and return just the result payload. */
async function cfFetch<T>(
  apiToken: string,
  path: string,
  options: RequestInit = {},
): Promise<T> {
  return (await cfRequest<T>(apiToken, path, options)).result;
}

/** Trailing dots and case are not part of a name's identity. */
function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\.+$/, "");
}

function toRecord(r: CfDnsRecordItem): DnsRecord {
  return {
    id: r.id,
    zoneId: r.zone_id,
    type: r.type as DnsRecordType,
    name: r.name,
    content: r.content,
    ttl: r.ttl,
    proxied: r.proxied ?? false,
    ...(typeof r.priority === "number" ? { priority: r.priority } : {}),
    ...(r.comment ? { comment: r.comment } : {}),
  };
}

/**
 * Suffixes to probe for `hostname`, most specific first, bounded.
 *
 * "a.b.example.com" → ["a.b.example.com", "b.example.com", "example.com"].
 * Single-label inputs yield nothing: there is no zone to find for "localhost".
 */
function zoneCandidates(hostname: string): string[] {
  const parts = normalizeName(hostname).split(".").filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i <= parts.length - 2; i++) {
    out.push(parts.slice(i).join("."));
  }
  // Keep the LAST N — the apex end. A deep name's zone is near the apex, so
  // truncating from the specific end is what preserves the real candidate.
  return out.slice(-MAX_ZONE_CANDIDATES);
}

export const cloudflareDnsProvider: DnsProvider = {
  name: "cloudflare",

  descriptor: {
    name: "cloudflare",
    displayName: "Cloudflare",
    description:
      "Openship writes your domain's DNS records for you, so a new custom domain verifies and gets its certificate without you leaving the page.",
    requiredScopes: ["Zone:Zone:Read", "Zone:DNS:Edit"],
    tokenUrl: "https://dash.cloudflare.com/profile/api-tokens",
  },

  async preflight(credentials: DnsProviderCredentials) {
    if (!credentials.apiToken.trim()) {
      return { ok: false, reason: "Cloudflare API token is missing." };
    }

    try {
      const result = await cfFetch<CfTokenVerifyResult>(
        credentials.apiToken,
        "/user/tokens/verify",
        { method: "GET" },
      );
      if (result.status === "active") {
        return { ok: true, detail: "Cloudflare API token is active." };
      }
      return { ok: false, reason: `Cloudflare reports this token as "${result.status}".` };
    } catch (err) {
      const reason =
        err instanceof DnsApiError && err.isAuthFailure
          ? "Cloudflare rejected this token. Check it was copied in full and has Zone:Read + DNS:Edit."
          : err instanceof Error
            ? err.message
            : String(err);
      return { ok: false, reason };
    }
  },

  async findZone(credentials: DnsProviderCredentials, hostname: string): Promise<DnsZone | null> {
    for (const candidate of zoneCandidates(hostname)) {
      // Not caught: an auth failure or a rate limit must reach the caller. A
      // swallowed 429 here becomes "no provider manages this domain", which
      // reads as a configuration mistake the operator did not make.
      const zones = await cfFetch<CfZoneItem[]>(
        credentials.apiToken,
        `/zones?name=${encodeURIComponent(candidate)}&status=active`,
        { method: "GET" },
      );

      const zone = zones?.[0];
      if (zone) {
        return { id: zone.id, name: zone.name, status: zone.status };
      }
    }

    return null;
  },

  async listZones(credentials: DnsProviderCredentials): Promise<DnsZone[]> {
    const zones = await cfFetch<CfZoneItem[]>(
      credentials.apiToken,
      `/zones?status=active&per_page=50`,
      { method: "GET" },
    );
    return (zones || []).map((z) => ({ id: z.id, name: z.name, status: z.status }));
  },

  async listRecords(
    credentials: DnsProviderCredentials,
    zoneId: string,
    filter?: { name?: string; type?: DnsRecordType },
  ): Promise<DnsRecord[]> {
    const records: DnsRecord[] = [];

    for (let page = 1; page <= MAX_PAGES; page++) {
      const params = new URLSearchParams({ per_page: String(PER_PAGE), page: String(page) });
      if (filter?.name) params.set("name", normalizeName(filter.name));
      if (filter?.type) params.set("type", filter.type);

      const body = await cfRequest<CfDnsRecordItem[]>(
        credentials.apiToken,
        `/zones/${encodeURIComponent(zoneId)}/dns_records?${params.toString()}`,
        { method: "GET" },
      );

      records.push(...(body.result ?? []).map(toRecord));

      // Absent result_info means the provider returned everything at once.
      const totalPages = body.result_info?.total_pages ?? 1;
      if (page >= totalPages) break;
    }

    return records;
  },

  async upsertRecord(
    credentials: DnsProviderCredentials,
    zoneId: string,
    input: DnsRecordInput,
  ): Promise<DnsRecord> {
    const name = normalizeName(input.name);
    const desiredTtl = input.ttl ?? 1; // 1 = "automatic" in Cloudflare
    const ownMarker = input.comment ?? OPENSHIP_RECORD_COMMENT;

    const existing = await this.listRecords(credentials, zoneId, { name, type: input.type });

    // More than one record at this name+type is a SET the operator maintains
    // (round-robin origins, multiple MX). Rewriting one member leaves the
    // hostname answering with a mix of their origin and ours — worse than not
    // acting. Ours-if-present, otherwise refuse and say so.
    const target =
      existing.length > 1 ? existing.find(isOpenshipManaged) : existing[0];

    if (existing.length > 1 && !target) {
      throw new DnsRecordConflictError(name, input.type, existing.length);
    }

    if (target) {
      // Preserve what we don't manage. Cloudflare proxying in particular is the
      // operator's choice: defaulting it to false silently takes a zone off the
      // orange cloud the first time a domain is re-added.
      const proxied = input.proxied ?? target.proxied;

      // Repointing a record the operator wrote is the point of connecting a domain;
      // CLAIMING it is not. `releaseRecords` deletes on our marker, so stamping it
      // here would make "remove this domain" destroy a record we never created and
      // whose original value we don't keep. Adopt the value, leave the ownership.
      const comment = isOpenshipManaged(target) ? ownMarker : target.comment;

      const unchanged =
        target.content === input.content &&
        target.proxied === proxied &&
        target.ttl === desiredTtl &&
        (input.priority == null || target.priority === input.priority) &&
        target.comment === comment;
      if (unchanged) return target;

      const updated = await cfFetch<CfDnsRecordItem>(
        credentials.apiToken,
        `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(target.id)}`,
        {
          method: "PUT",
          body: JSON.stringify({
            type: input.type,
            name,
            content: input.content,
            ttl: desiredTtl,
            proxied,
            ...(input.priority != null ? { priority: input.priority } : {}),
            comment,
          }),
        },
      );
      return toRecord(updated);
    }

    // Nothing was there, so this record IS ours — mark it, and only this branch
    // does, which is what makes the marker mean "Openship created this".
    const created = await cfFetch<CfDnsRecordItem>(
      credentials.apiToken,
      `/zones/${encodeURIComponent(zoneId)}/dns_records`,
      {
        method: "POST",
        body: JSON.stringify({
          type: input.type,
          name,
          content: input.content,
          ttl: desiredTtl,
          proxied: input.proxied ?? false,
          ...(input.priority != null ? { priority: input.priority } : {}),
          comment: ownMarker,
        }),
      },
    );
    return toRecord(created);
  },

  async deleteRecord(
    credentials: DnsProviderCredentials,
    zoneId: string,
    recordId: string,
  ): Promise<void> {
    try {
      await cfFetch<{ id: string }>(
        credentials.apiToken,
        `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`,
        { method: "DELETE" },
      );
    } catch (err) {
      // Already gone is the outcome we wanted. Idempotent so a retried cleanup
      // (or two overlapping ones) doesn't fail the caller.
      if (err instanceof DnsApiError && err.providerStatus === 404) return;
      throw err;
    }
  },
};
