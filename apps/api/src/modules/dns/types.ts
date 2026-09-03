/**
 * DNS provider abstraction — automated record management for custom domains.
 *
 * Openship already computes the exact records a domain needs (`buildRecords` in
 * the domains module). A connected provider turns that list from instructions
 * into an action: we write the A/CNAME and `_openship-challenge` TXT ourselves,
 * and the domain verifies without the operator leaving the page.
 *
 * The authority involved is real — a Zone:Read + DNS:Edit token can rewrite
 * every record in every zone it can see — so two rules hold throughout:
 *
 *   1. We only ever DELETE records we created. Ownership is proven by the
 *      provider-side comment marker (`OPENSHIP_RECORD_COMMENT`), never by name
 *      matching: a custom domain's apex IS the zone apex, and "delete every
 *      record at the apex" takes the operator's MX and SPF with it. Repointing an
 *      existing record is allowed — that is what connecting a domain means — but
 *      it does not transfer ownership: an ADOPTED record keeps whatever comment it
 *      already had, so it is not ours to delete and survives domain removal.
 *   2. "No zone matched" and "could not ask" are different answers. Collapsing a
 *      429 or a 5xx into "not managed here" tells the operator their token is
 *      wrong when it is fine, and silently skips provisioning.
 */

import { AppError } from "@repo/core";

export type DnsProviderName = "cloudflare";

export type DnsRecordType = "A" | "AAAA" | "CNAME" | "TXT" | "MX" | "NS" | "SRV";

/**
 * Written into the provider's record comment so cleanup can tell "Openship put
 * this here" from "the operator has run their mail on this zone for six years".
 * Changing this string orphans every record written under the old one.
 */
export const OPENSHIP_RECORD_COMMENT = "Managed by Openship";

export interface DnsRecordInput {
  /** Record type: A, CNAME, TXT, etc. */
  type: DnsRecordType;
  /** Fully-qualified name (e.g. "app.example.com", "_openship-challenge.example.com"). */
  name: string;
  /** Value / target (IPv4 address, target hostname, TXT string). */
  content: string;
  /** TTL in seconds; omit for provider-automatic. */
  ttl?: number;
  /** Provider-specific proxying (Cloudflare's orange cloud). */
  proxied?: boolean;
  /** Preference for MX/SRV records. Required by the provider on an MX create;
   *  omitted (and ignored) for A/CNAME/TXT. */
  priority?: number;
  /** Ownership marker. Defaults to `OPENSHIP_RECORD_COMMENT`. */
  comment?: string;
}

export interface DnsRecord {
  /** Provider-assigned record ID. */
  id: string;
  /** Zone ID the record belongs to. */
  zoneId: string;
  type: DnsRecordType;
  name: string;
  content: string;
  ttl: number;
  proxied: boolean;
  /** Preference for MX/SRV records, when the provider reports one. */
  priority?: number;
  /** Provider-side comment, when the provider supports one. */
  comment?: string;
}

export interface DnsZone {
  /** Provider-assigned zone ID. */
  id: string;
  /** Apex zone name (e.g. "example.com"). */
  name: string;
  /** Zone status: "active", "pending", etc. */
  status: string;
}

export interface DnsProviderCredentials {
  /** Decrypted API token. */
  apiToken: string;
  /** Optional provider account ID. */
  accountId?: string;
}

/** Operator-facing description of a provider, surfaced by GET /dns/providers. */
export interface DnsProviderDescriptor {
  name: DnsProviderName;
  displayName: string;
  /** One line explaining what connecting this provider buys you. */
  description: string;
  /** The exact token scopes we need, so the operator can mint a minimal token. */
  requiredScopes: string[];
  /** Where to create the token — linked from the connect form. */
  tokenUrl?: string;
}

export interface DnsProvider {
  readonly name: DnsProviderName;

  /** Rendered by the dashboard's provider picker. Lives on the provider so a new
   *  provider cannot be added without also describing itself. */
  readonly descriptor: DnsProviderDescriptor;

  /** Validate credentials against the provider API before we store them. */
  preflight(
    credentials: DnsProviderCredentials,
  ): Promise<{ ok: true; detail?: string } | { ok: false; reason: string }>;

  /**
   * Find the zone that manages `hostname` by walking up its labels.
   *
   * Returns null ONLY for "this provider definitively does not host it". A
   * transport failure, rate limit or 5xx must THROW (`DnsApiError`) so the
   * caller can say "couldn't check" instead of "not yours".
   */
  findZone(
    credentials: DnsProviderCredentials,
    hostname: string,
  ): Promise<DnsZone | null>;

  /** Optional zone enumeration for interactive pickers */
  listZones?(
    credentials: DnsProviderCredentials,
  ): Promise<DnsZone[]>;

  /** List records in a zone, optionally filtered by name or type. Paginated. */
  listRecords(
    credentials: DnsProviderCredentials,
    zoneId: string,
    filter?: { name?: string; type?: DnsRecordType },
  ): Promise<DnsRecord[]>;

  /**
   * Create or update a record idempotently. When a record of the same name and
   * type exists it is updated in place; provider-specific settings we do not
   * manage (e.g. Cloudflare proxying) are preserved rather than reset.
   */
  upsertRecord(
    credentials: DnsProviderCredentials,
    zoneId: string,
    input: DnsRecordInput,
  ): Promise<DnsRecord>;

  /** Delete a record by ID. Idempotent — an already-gone record is a success. */
  deleteRecord(
    credentials: DnsProviderCredentials,
    zoneId: string,
    recordId: string,
  ): Promise<void>;
}

/** True when this record carries our ownership marker, i.e. we wrote it. */
export function isOpenshipManaged(record: DnsRecord): boolean {
  return record.comment?.trim() === OPENSHIP_RECORD_COMMENT;
}

/* ────── Typed errors ───────────────────────────────────────────── */
/* All extend AppError so `handleApiError` maps status + code centrally and no
 * handler needs its own try/catch. */

export class UnknownDnsProviderError extends AppError {
  constructor(name: string) {
    super(`Unknown DNS provider: ${name}`, 400, "DNS_UNKNOWN_PROVIDER");
    this.name = "UnknownDnsProviderError";
  }
}

export class DnsProviderNotReadyError extends AppError {
  constructor(
    public readonly provider: DnsProviderName,
    reason: string,
  ) {
    super(`DNS provider "${provider}" is not ready: ${reason}`, 400, "DNS_PROVIDER_NOT_READY");
    this.name = "DnsProviderNotReadyError";
  }
}

/**
 * Several records already answer for this name+type and none of them are ours.
 *
 * 409 rather than a silent overwrite: a round-robin A set or a multi-host MX is
 * deliberate configuration, and rewriting one member of it leaves the hostname
 * answering with a mix of the operator's origin and ours.
 */
export class DnsRecordConflictError extends AppError {
  constructor(
    public readonly recordName: string,
    public readonly recordType: DnsRecordType,
    public readonly existingCount: number,
  ) {
    super(
      `${existingCount} existing ${recordType} records already answer for "${recordName}". ` +
        `Openship won't rewrite records it didn't create — remove or consolidate them first.`,
      409,
      "DNS_RECORD_CONFLICT",
    );
    this.name = "DnsRecordConflictError";
  }
}

/**
 * The provider's API said no. 502, because the failure is upstream of us rather
 * than the caller's fault.
 *
 * `providerStatus` is the PROVIDER's HTTP status and is deliberately not named
 * `statusCode` — that name belongs to AppError and drives OUR response status.
 * Conflating the two turns "Cloudflare returned 404" into "this endpoint does
 * not exist".
 */
export class DnsApiError extends AppError {
  constructor(
    public readonly provider: DnsProviderName,
    public readonly providerStatus: number,
    message: string,
  ) {
    super(
      `DNS provider "${provider}" API error (${providerStatus}): ${message}`,
      502,
      "DNS_API_ERROR",
    );
    this.name = "DnsApiError";
  }

  /** The stored token was rejected — revoked, expired or under-scoped. */
  get isAuthFailure(): boolean {
    return this.providerStatus === 401 || this.providerStatus === 403;
  }

  /** Transient: report as "couldn't check", never as "not managed here". */
  get isTransient(): boolean {
    return this.providerStatus === 429 || this.providerStatus >= 500;
  }
}
