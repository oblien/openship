import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
/**
 * DigitalOcean DNS provider.
 *
 * Talks to the v2 REST API with a custom-scoped token (domain read, create,
 * update and delete). A zone's ID is its domain name: every record call is
 * addressed as `/domains/{zone}/records`.
 *
 * OWNERSHIP. DigitalOcean records have no comment field, so the marker Cloudflare
 * keeps on the record itself lives next to it instead: for every record we
 * create we also write a TXT record at `_openship-owner.<record name>` whose
 * value names the record's type and ID. `listRecords` reports a record whose
 * marker matches with `comment = OPENSHIP_RECORD_COMMENT`, so the shared rules
 * (`isOpenshipManaged`, plan/apply, `releaseRecords`) apply unchanged. The
 * marker is bound to the record ID, so a record the operator deleted and
 * recreated by hand is theirs, and an adopted record never gets one.
 */

import {
  DigitalOceanApiError,
  digitaloceanList,
  digitaloceanRequest,
} from "../../../lib/digitalocean-api";
import { dnsTxtValue } from "../../../lib/dns-txt";
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

/**
 * How many domain suffixes we'll probe when looking for the zone. Same bound
 * and reasoning as the Cloudflare provider: real hostnames are 2-5 labels.
 */
const MAX_ZONE_CANDIDATES = 8;

/** DigitalOcean rejects a TTL below 30 seconds. */
const MIN_TTL = 30;

/** DigitalOcean's own default, used when neither the input nor an existing record sets one. */
const DEFAULT_TTL = 1800;

/**
 * First label of every ownership marker. Changing it orphans every marker
 * written under the old one, exactly like changing `OPENSHIP_RECORD_COMMENT`.
 */
const OWNER_LABEL = "_openship-owner";

/** Stands in for `*` in a marker name: a wildcard label is only valid leftmost. */
const WILDCARD_LABEL = "_wildcard";

const MARKER_PATTERN = /^openship-owner;type=([A-Z]+);id=(\d+)$/;

interface DoDomainItem {
  name: string;
}

interface DoRecordItem {
  id: number;
  type: string;
  name: string;
  data: string;
  ttl: number;
  priority?: number | null;
}

/** Preserve the DNS provider's public error contract. */
async function doRequest<T>(token: string, path: string, options?: RequestInit): Promise<T> {
  try {
    return await digitaloceanRequest<T>(token, path, options);
  } catch (error) {
    if (error instanceof DigitalOceanApiError) {
      throw new DnsApiError("digitalocean", error.providerStatus, error.message);
    }
    throw error;
  }
}

async function doList<T>(token: string, path: string, key: string): Promise<T[]> {
  try {
    return await digitaloceanList<T>(token, path, key);
  } catch (error) {
    if (error instanceof DigitalOceanApiError) {
      throw new DnsApiError("digitalocean", error.providerStatus, error.message);
    }
    throw error;
  }
}

/** Trailing dots and case are not part of a name's identity. */
function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\.+$/, "");
}

/** "a.b.example.com" → ["a.b.example.com", "b.example.com", "example.com"], bounded. */
function zoneCandidates(hostname: string): string[] {
  const parts = normalizeName(hostname).split(".").filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i <= parts.length - 2; i++) {
    out.push(parts.slice(i).join("."));
  }
  // Keep the apex end: a deep name's zone is near the apex.
  return out.slice(-MAX_ZONE_CANDIDATES);
}

/** DigitalOcean names records relative to the zone, with `@` for the apex. */
export function toRelativeName(fqdn: string, zone: string): string {
  const name = normalizeName(fqdn);
  const apex = normalizeName(zone);
  if (name === apex) return "@";
  if (name.endsWith(`.${apex}`)) return name.slice(0, -(apex.length + 1));
  throw new Error(`"${fqdn}" is not inside the zone "${zone}"`);
}

export function toFqdn(relative: string, zone: string): string {
  const name = normalizeName(relative);
  const apex = normalizeName(zone);
  return name === "@" || name === "" ? apex : `${name}.${apex}`;
}

/** Where the marker for a record at `fqdn` lives. */
export function ownerMarkerName(fqdn: string): string {
  const name = normalizeName(fqdn);
  return name.startsWith("*.")
    ? `${OWNER_LABEL}.${WILDCARD_LABEL}.${name.slice(2)}`
    : `${OWNER_LABEL}.${name}`;
}

export function ownerMarkerValue(type: DnsRecordType, id: string): string {
  return `openship-owner;type=${type};id=${id}`;
}

export function parseOwnerMarker(value: string): { type: string; id: string } | null {
  const match = MARKER_PATTERN.exec(dnsTxtValue(value).trim());
  return match ? { type: match[1]!, id: match[2]! } : null;
}

function isMarkerName(fqdn: string): boolean {
  return normalizeName(fqdn).startsWith(`${OWNER_LABEL}.`);
}

/**
 * Hostname targets as fully qualified names. Without the trailing dot
 * DigitalOcean reads a target as relative and appends the zone to it.
 */
function absoluteTarget(value: string): string {
  return value.endsWith(".") ? value : `${value}.`;
}

function formatContent(type: DnsRecordType, content: string): string {
  return type === "CNAME" || type === "MX" ? absoluteTarget(content) : content;
}

function toRecord(item: DoRecordItem, zone: string, owned: boolean): DnsRecord {
  const type = item.type as DnsRecordType;
  const content =
    type === "CNAME" || type === "MX"
      ? item.data === "@"
        ? `${normalizeName(zone)}.`
        : absoluteTarget(item.data)
      : type === "TXT"
        ? dnsTxtValue(item.data)
        : item.data;
  return {
    id: String(item.id),
    zoneId: zone,
    type,
    name: toFqdn(item.name, zone),
    content,
    ttl: item.ttl,
    proxied: false,
    ...(typeof item.priority === "number" ? { priority: item.priority } : {}),
    ...(owned ? { comment: OPENSHIP_RECORD_COMMENT } : {}),
  };
}

const recordsPath = (zone: string) => `/domains/${encodeURIComponent(zone)}/records`;

/**
 * Records at `fqdn` (or the whole zone), with ownership resolved from markers
 * and the markers themselves left out: they are bookkeeping, never something a
 * caller plans against.
 */
async function listOwned(
  token: string,
  zone: string,
  filter?: { name?: string; type?: DnsRecordType },
): Promise<DnsRecord[]> {
  let items: DoRecordItem[];
  let markers: DoRecordItem[];
  if (filter?.name) {
    const fqdn = normalizeName(filter.name);
    const params = new URLSearchParams({ name: fqdn });
    if (filter.type) params.set("type", filter.type);
    items = await doList<DoRecordItem>(token, `${recordsPath(zone)}?${params}`, "domain_records");
    const markerParams = new URLSearchParams({ name: ownerMarkerName(fqdn), type: "TXT" });
    markers = await doList<DoRecordItem>(
      token,
      `${recordsPath(zone)}?${markerParams}`,
      "domain_records",
    );
  } else {
    const all = await doList<DoRecordItem>(token, recordsPath(zone), "domain_records");
    markers = all.filter((r) => r.type === "TXT" && isMarkerName(toFqdn(r.name, zone)));
    items = all.filter((r) => !isMarkerName(toFqdn(r.name, zone)));
    if (filter?.type) items = items.filter((r) => r.type === filter.type);
  }

  const owned = new Set<string>();
  for (const marker of markers) {
    const parsed = parseOwnerMarker(marker.data);
    if (parsed) owned.add(`${toFqdn(marker.name, zone)}|${parsed.type}|${parsed.id}`);
  }
  return items.map((item) => {
    const fqdn = toFqdn(item.name, zone);
    return toRecord(item, zone, owned.has(`${ownerMarkerName(fqdn)}|${item.type}|${item.id}`));
  });
}

/** Already gone is the outcome a delete wants. */
async function deleteById(token: string, zone: string, id: string): Promise<void> {
  try {
    await doRequest<void>(token, `${recordsPath(zone)}/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  } catch (err) {
    if (err instanceof DnsApiError && err.providerStatus === 404) return;
    throw err;
  }
}

export const digitaloceanDnsProvider: DnsProvider = {
  name: "digitalocean",

  formatContent,

  descriptor: {
    name: "digitalocean",
    displayName: "DigitalOcean",
    description:
      "Openship writes your domain's DNS records on DigitalOcean DNS, so a new custom domain verifies and gets its certificate without you leaving the page.",
    requiredScopes: ["domain:read", "domain:create", "domain:update", "domain:delete"],
    tokenUrl: "https://cloud.digitalocean.com/account/api/tokens",
  },

  async preflight(credentials: DnsProviderCredentials) {
    if (!credentials.apiToken.trim()) {
      return { ok: false, reason: "DigitalOcean API token is missing." };
    }

    try {
      // Not /account: that needs account:read, which a DNS-only token rightly lacks.
      await doRequest(credentials.apiToken, "/domains?per_page=1", { method: "GET" });
      return { ok: true, detail: "DigitalOcean API token can read domains." };
    } catch (err) {
      observeCaughtError(err, "platform/engine/modules/dns/providers/digitalocean.provider");
      const reason =
        err instanceof DnsApiError && err.isAuthFailure
          ? "DigitalOcean rejected this token. Check it was copied in full and has the domain read, create, update and delete scopes."
          : err instanceof Error
            ? err.message
            : String(err);
      return { ok: false, reason };
    }
  },

  async findZone(credentials: DnsProviderCredentials, hostname: string): Promise<DnsZone | null> {
    for (const candidate of zoneCandidates(hostname)) {
      try {
        const body = await doRequest<{ domain: DoDomainItem }>(
          credentials.apiToken,
          `/domains/${encodeURIComponent(candidate)}`,
          { method: "GET" },
        );
        // DigitalOcean has no zone status: a domain added to the account is served
        // by its name servers once the registrar delegates to them.
        if (body?.domain?.name)
          return { id: body.domain.name, name: body.domain.name, status: "active" };
      } catch (err) {
        // 404 is "not this suffix". Anything else (auth, rate limit) must reach the
        // caller, or a 429 reads as "no provider manages this domain".
        if (err instanceof DnsApiError && err.providerStatus === 404) continue;
        throw err;
      }
    }
    return null;
  },

  async listRecords(
    credentials: DnsProviderCredentials,
    zoneId: string,
    filter?: { name?: string; type?: DnsRecordType },
  ): Promise<DnsRecord[]> {
    return listOwned(credentials.apiToken, zoneId, filter);
  },

  async upsertRecord(
    credentials: DnsProviderCredentials,
    zoneId: string,
    input: DnsRecordInput,
  ): Promise<DnsRecord> {
    const token = credentials.apiToken;
    const fqdn = normalizeName(input.name);
    const data = formatContent(input.type, input.content);

    const existing = await listOwned(token, zoneId, { name: fqdn, type: input.type });

    // Same rule as Cloudflare: more than one record at this name+type is a set the
    // operator maintains. Ours-if-present, otherwise refuse and say so.
    const target = existing.length > 1 ? existing.find(isOpenshipManaged) : existing[0];
    if (existing.length > 1 && !target) {
      throw new DnsRecordConflictError(fqdn, input.type, existing.length);
    }

    const ttl = Math.max(MIN_TTL, input.ttl ?? target?.ttl ?? DEFAULT_TTL);
    const body = {
      type: input.type,
      name: toRelativeName(fqdn, zoneId),
      data,
      ttl,
      ...(input.priority != null ? { priority: input.priority } : {}),
    };

    if (target) {
      // Repointing keeps the record ID, so an existing marker stays valid and an
      // adopted record stays unmarked: repointing does not transfer ownership.
      const unchanged =
        target.content === data &&
        target.ttl === ttl &&
        (input.priority == null || target.priority === input.priority);
      if (unchanged) return target;

      const updated = await doRequest<{ domain_record: DoRecordItem }>(
        token,
        `${recordsPath(zoneId)}/${encodeURIComponent(target.id)}`,
        { method: "PUT", body: JSON.stringify(body) },
      );
      return toRecord(updated.domain_record, zoneId, isOpenshipManaged(target));
    }

    // Nothing was there, so this record IS ours — and only this branch writes a
    // marker, which is what makes the marker mean "Openship created this".
    const created = await doRequest<{ domain_record: DoRecordItem }>(token, recordsPath(zoneId), {
      method: "POST",
      body: JSON.stringify(body),
    });
    const id = String(created.domain_record.id);
    try {
      await doRequest(token, recordsPath(zoneId), {
        method: "POST",
        body: JSON.stringify({
          type: "TXT",
          name: toRelativeName(ownerMarkerName(fqdn), zoneId),
          data: ownerMarkerValue(input.type, id),
          ttl: DEFAULT_TTL,
        }),
      });
    } catch (err) {
      // An unmarked record we created would outlive the domain: nothing could
      // prove it is ours. Take it back down and report the original failure.
      await deleteById(token, zoneId, id).catch((cleanupFailure) =>
        observeCaughtError(
          cleanupFailure,
          "platform/engine/modules/dns/providers/digitalocean.provider",
        ),
      );
      throw err;
    }
    return toRecord(created.domain_record, zoneId, true);
  },

  async deleteRecord(
    credentials: DnsProviderCredentials,
    zoneId: string,
    recordId: string,
  ): Promise<void> {
    const token = credentials.apiToken;
    let record: DoRecordItem;
    try {
      const body = await doRequest<{ domain_record: DoRecordItem }>(
        token,
        `${recordsPath(zoneId)}/${encodeURIComponent(recordId)}`,
        { method: "GET" },
      );
      record = body.domain_record;
    } catch (err) {
      // Already gone. A marker left behind names an ID that no longer exists, so
      // it can never claim a different record.
      if (err instanceof DnsApiError && err.providerStatus === 404) return;
      throw err;
    }

    await deleteById(token, zoneId, recordId);

    const fqdn = toFqdn(record.name, zoneId);
    const params = new URLSearchParams({ name: ownerMarkerName(fqdn), type: "TXT" });
    const markers = await doList<DoRecordItem>(
      token,
      `${recordsPath(zoneId)}?${params}`,
      "domain_records",
    );
    for (const marker of markers) {
      if (parseOwnerMarker(marker.data)?.id === recordId) {
        await deleteById(token, zoneId, String(marker.id));
      }
    }
  },
};
