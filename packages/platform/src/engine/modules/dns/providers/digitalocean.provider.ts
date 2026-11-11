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
 *
 * DELEGATION. DigitalOcean has no zone status: a domain added to the account
 * exists whether or not the registrar points at DigitalOcean's name servers.
 * `findZone` therefore checks the public NS set and reports an undelegated zone
 * as "pending", which the caller treats like a non-active Cloudflare zone.
 */

import { Resolver } from "node:dns/promises";

import {
  DigitalOceanApiError,
  digitaloceanList,
  digitaloceanRequest,
} from "../../../lib/digitalocean-api";
import { dnsTxtValue } from "../../../lib/dns-txt";
import { PUBLIC_DNS_SERVERS } from "../../../lib/public-dns";
import { normalizeName, zoneCandidates } from "../names";
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
const WILDCARD_OWNER_LABEL = "_openship-owner-wildcard";

const MARKER_PATTERN = /^openship-owner;type=([A-Z]+);id=(\d+)$/;

/** The name servers a domain must be delegated to for DigitalOcean to answer for it. */
const DIGITALOCEAN_NAMESERVERS = new Set([
  "ns1.digitalocean.com",
  "ns2.digitalocean.com",
  "ns3.digitalocean.com",
]);

/** Resolver answers that mean "this name has no public NS set", i.e. not delegated. */
const NOT_DELEGATED_CODES = new Set(["ENOTFOUND", "ENODATA"]);

const SOURCE = "platform/engine/modules/dns/providers/digitalocean.provider";

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

/**
 * Preserve the DNS provider's public error contract.
 *
 * A 403 on a write is named for what it almost always is: the token was verified
 * with `domain:read` only (the one scope we can check without writing), and
 * lacks create/update/delete. Still a 403, so the caller marks it invalid.
 */
async function doRequest<T>(
  token: string,
  path: string,
  options?: Parameters<typeof digitaloceanRequest>[2],
): Promise<T> {
  try {
    return await digitaloceanRequest<T>(token, path, options);
  } catch (error) {
    if (error instanceof DigitalOceanApiError) {
      const method = (options?.method ?? "GET").toUpperCase();
      if (error.providerStatus === 403 && method !== "GET") {
        throw new DnsApiError(
          "digitalocean",
          403,
          "This token can read domains but lacks write scope. Re-create it with domain create, update and delete.",
        );
      }
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

/** A wildcard label can never be a zone; `*.example.com` lives in `example.com`. */
function stripWildcard(hostname: string): string {
  const name = normalizeName(hostname);
  return name.startsWith("*.") ? name.slice(2) : name;
}

/** Only confirmed public delegation makes a zone eligible for provisioning. */
async function delegationStatus(zone: string): Promise<"active" | "pending"> {
  let nameservers: string[];
  try {
    // Public resolvers: delegation is the internet's view, not this host's (which
    // may be split-horizon). Bounded so a black-holed resolver can't stall a lookup.
    const resolver = new Resolver({ timeout: 3_000, tries: 2 });
    resolver.setServers([...PUBLIC_DNS_SERVERS]);
    nameservers = await resolver.resolveNs(zone);
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code && NOT_DELEGATED_CODES.has(code)) return "pending";
    observeCaughtError(err, SOURCE);
    throw new DnsApiError(
      "digitalocean",
      503,
      "Could not verify the domain's nameservers. Try again.",
    );
  }
  const delegated =
    nameservers.length > 0 &&
    nameservers.every((ns) => DIGITALOCEAN_NAMESERVERS.has(normalizeName(ns)));
  return delegated ? "active" : "pending";
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
    ? `${WILDCARD_OWNER_LABEL}.${name.slice(2)}`
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
  const name = normalizeName(fqdn);
  return name.startsWith(`${OWNER_LABEL}.`) || name.startsWith(`${WILDCARD_OWNER_LABEL}.`);
}

/**
 * Hostname targets as fully qualified names. Without the trailing dot
 * DigitalOcean reads a target as relative and appends the zone to it.
 */
function absoluteTarget(value: string): string {
  return value.endsWith(".") ? value : `${value}.`;
}

/**
 * DigitalOcean takes TXT data as the plain value (it adds the DNS quoting and
 * chunking itself), and `toRecord` reports it decoded. Decode an input given in
 * presentation syntax (`"v=spf1 -all"`, `"abc" "def"`) the same way, or it is
 * stored with literal quotes and never compares in-sync.
 */
function formatContent(type: DnsRecordType, content: string): string {
  if (type === "CNAME" || type === "MX") return absoluteTarget(content);
  return type === "TXT" ? dnsTxtValue(content) : content;
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
    const markerParams = new URLSearchParams({ name: ownerMarkerName(fqdn), type: "TXT" });
    [items, markers] = await Promise.all([
      doList<DoRecordItem>(token, `${recordsPath(zone)}?${params}`, "domain_records"),
      doList<DoRecordItem>(token, `${recordsPath(zone)}?${markerParams}`, "domain_records"),
    ]);
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

/**
 * Delete the ownership markers that name `recordId`. With the record's name we
 * look only where its marker lives; without it (the record is already gone) we
 * sweep the zone's TXT records for markers naming that ID.
 *
 * Best effort and never thrown: it runs after the record itself is handled, so a
 * 429 here must not report a deleted record as failed. A marker left behind names
 * an ID that no longer exists, can never claim another record, and is swept by
 * `pruneOrphanedMarkers` on the next release.
 */
async function dropMarkersFor(
  token: string,
  zone: string,
  recordId: string,
  fqdn?: string,
): Promise<void> {
  try {
    const markers = fqdn
      ? await doList<DoRecordItem>(
          token,
          `${recordsPath(zone)}?${new URLSearchParams({ name: ownerMarkerName(fqdn), type: "TXT" })}`,
          "domain_records",
        )
      : (
          await doList<DoRecordItem>(token, `${recordsPath(zone)}?type=TXT`, "domain_records")
        ).filter((r) => isMarkerName(toFqdn(r.name, zone)));
    for (const marker of markers) {
      if (parseOwnerMarker(marker.data)?.id === recordId) {
        await deleteById(token, zone, String(marker.id));
      }
    }
  } catch (err) {
    observeCaughtError(err, SOURCE);
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

    // Proves domain:read only. There is no side-effect-free way to check the write
    // scopes; a token without them is reported (and marked invalid) on its first
    // write, through `doRequest`'s 403 mapping.
    try {
      // Not /account: that needs account:read, which a DNS-only token rightly lacks.
      await doRequest(credentials.apiToken, "/domains?per_page=1", { method: "GET" });
      return {
        ok: true,
        detail:
          "DigitalOcean API token can read domains. Write access is confirmed on the first record write.",
      };
    } catch (err) {
      observeCaughtError(err, SOURCE);
      const reason =
        err instanceof DnsApiError && err.isAuthFailure
          ? "DigitalOcean rejected this token. Check it was copied in full and has at least the domain read scope (writing records also needs domain create, update and delete)."
          : err instanceof Error
            ? err.message
            : String(err);
      return { ok: false, reason };
    }
  },

  async findZone(credentials: DnsProviderCredentials, hostname: string): Promise<DnsZone | null> {
    const candidates = zoneCandidates(stripWildcard(hostname));
    if (candidates.length === 0) return null;
    // One paginated list instead of a GET per suffix. Not caught: an auth failure
    // or a 429 must reach the caller, or it reads as "no provider manages this".
    const domains = await doList<DoDomainItem>(credentials.apiToken, "/domains", "domains");
    const hosted = new Set(domains.map((d) => normalizeName(d.name)));
    // Candidates run most specific first, so the longest hosted suffix wins.
    const zone = candidates.find((candidate) => hosted.has(candidate));
    if (!zone) return null;
    return { id: zone, name: zone, status: await delegationStatus(zone) };
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
        observeCaughtError(cleanupFailure, SOURCE),
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
      // Already gone (deleted in the console, or by an earlier attempt whose marker
      // cleanup failed). Its marker may still be there: sweep for it by ID.
      if (err instanceof DnsApiError && err.providerStatus === 404) {
        await dropMarkersFor(token, zoneId, recordId);
        return;
      }
      throw err;
    }

    await deleteById(token, zoneId, recordId);
    await dropMarkersFor(token, zoneId, recordId, toFqdn(record.name, zoneId));
  },

  async pruneOrphanedMarkers(
    credentials: DnsProviderCredentials,
    zoneId: string,
    name: string,
  ): Promise<void> {
    const token = credentials.apiToken;
    const fqdn = normalizeName(name);
    const markers = await doList<DoRecordItem>(
      token,
      `${recordsPath(zoneId)}?${new URLSearchParams({ name: ownerMarkerName(fqdn), type: "TXT" })}`,
      "domain_records",
    );
    if (markers.length === 0) return;
    const present = new Set(
      (
        await doList<DoRecordItem>(
          token,
          `${recordsPath(zoneId)}?${new URLSearchParams({ name: fqdn })}`,
          "domain_records",
        )
      ).map((r) => `${r.type}|${r.id}`),
    );
    for (const marker of markers) {
      const parsed = parseOwnerMarker(marker.data);
      // Unparseable: not a marker we wrote, so not ours to remove. A marker only
      // ever claims a record at its own name, so one naming a record that is not
      // here marks nothing and is safe to drop.
      if (!parsed || present.has(`${parsed.type}|${parsed.id}`)) continue;
      await deleteById(token, zoneId, String(marker.id));
    }
  },
};
