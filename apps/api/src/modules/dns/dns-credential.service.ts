/**
 * DNS credential storage + the two operations the domains module needs from it:
 * write a domain's records, and take them back down again.
 *
 * Read paths NEVER decrypt. The list endpoint returns the same constant mask the
 * env-var endpoints use, so "show me my credentials" can't be turned into a
 * partial token disclosure, and a rotated `BETTER_AUTH_SECRET` can't 500 the
 * list (`decryptSecretField` throws on a key mismatch — it does not return null).
 * A token that stopped working surfaces through `status`, set by the
 * provisioning path, which is the only place we legitimately hold plaintext.
 */

import { ConflictError, ENV_MASK, NotFoundError, safeErrorMessage } from "@repo/core";
import { repos, type DnsCredential } from "@repo/db";
import { encryptSecretField, decryptSecretField } from "../../lib/credential-encryption";
import { resolveDnsProvider } from "./registry";
import {
  DnsApiError,
  DnsProviderNotReadyError,
  isOpenshipManaged,
  type DnsProvider,
  type DnsRecordInput,
  type DnsZone,
} from "./types";

export interface SanitizedDnsCredential {
  id: string;
  organizationId: string;
  provider: string;
  name: string;
  /** "active" | "invalid" */
  status: string;
  /** Always the constant mask. There is no endpoint that reveals the token. */
  tokenMasked: string;
  lastVerifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export function sanitizeCredential(cred: DnsCredential): SanitizedDnsCredential {
  return {
    id: cred.id,
    organizationId: cred.organizationId,
    provider: cred.provider,
    name: cred.name,
    status: cred.status,
    tokenMasked: ENV_MASK,
    lastVerifiedAt: cred.lastVerifiedAt,
    createdAt: cred.createdAt,
    updatedAt: cred.updatedAt,
  };
}

export async function listCredentials(organizationId: string): Promise<SanitizedDnsCredential[]> {
  const rows = await repos.dnsCredential.listByOrg(organizationId);
  return rows.map(sanitizeCredential);
}

export async function getCredential(
  organizationId: string,
  id: string,
): Promise<SanitizedDnsCredential | null> {
  const row = await repos.dnsCredential.findById(organizationId, id);
  return row ? sanitizeCredential(row) : null;
}

export async function addCredential(
  organizationId: string,
  input: { provider: string; name: string; apiToken: string },
): Promise<SanitizedDnsCredential> {
  const provider = resolveDnsProvider(input.provider);
  const name = input.name.trim();

  // Reject the duplicate here rather than letting the unique index raise: the
  // operator gets "you already have one called that", not a constraint name.
  const existing = await repos.dnsCredential.findByName(organizationId, input.provider, name);
  if (existing) {
    throw new ConflictError(`A ${provider.name} credential named "${name}" already exists.`);
  }

  // Prove the token works before storing it. A credential that was never valid
  // is worse than none: it silently owns the zone lookup for every domain add.
  const pre = await provider.preflight({ apiToken: input.apiToken });
  if (!pre.ok) throw new DnsProviderNotReadyError(provider.name, pre.reason);

  const apiTokenEnc = encryptSecretField(input.apiToken);
  if (!apiTokenEnc) throw new Error("Failed to encrypt the DNS API token.");

  const row = await repos.dnsCredential.create({
    organizationId,
    provider: input.provider,
    name,
    apiTokenEnc,
    status: "active",
    lastVerifiedAt: new Date(),
  });

  return sanitizeCredential(row);
}

export async function removeCredential(organizationId: string, id: string): Promise<void> {
  const existing = await repos.dnsCredential.findById(organizationId, id);
  if (!existing) throw new NotFoundError("DNS credential", id);
  await repos.dnsCredential.delete(organizationId, id);
}

/* ────── Zone resolution ─────────────────────────────────────────── */

export interface MatchedDnsManager {
  credentialId: string;
  provider: DnsProvider;
  zone: DnsZone;
  credentials: { apiToken: string };
}

/**
 * Why "no manager" happened, because the three cases need different words.
 *
 *   none          → asked, and no connected provider hosts this zone. Normal:
 *                   the operator just hasn't delegated this domain to us.
 *   unauthorized  → a stored token was rejected (or can't be decrypted). The
 *                   operator has to act; provisioning marks it invalid.
 *   unavailable   → the provider was rate-limited or down. Nothing is wrong with
 *                   the configuration and nothing should be marked invalid.
 */
export type DnsManagerLookup =
  | { status: "matched"; manager: MatchedDnsManager }
  | { status: "none" }
  | { status: "unavailable"; reason: string }
  | { status: "unauthorized"; credentialId: string; reason: string };

export async function resolveDnsManager(
  organizationId: string,
  hostname: string,
): Promise<DnsManagerLookup> {
  const credentials = await repos.dnsCredential.findActiveByOrg(organizationId);
  if (credentials.length === 0) return { status: "none" };

  // Remembered, not returned immediately: a second credential may still own this
  // zone, and one broken token shouldn't hide a working one.
  let unauthorized: { credentialId: string; reason: string } | null = null;
  let unavailable: string | null = null;

  for (const cred of credentials) {
    let apiToken: string;
    try {
      const plain = decryptSecretField(cred.apiTokenEnc);
      if (!plain) throw new Error("stored token is empty");
      apiToken = plain;
    } catch (err) {
      // Almost always a rotated BETTER_AUTH_SECRET. Same operator action as a
      // revoked token: re-paste it.
      unauthorized ??= {
        credentialId: cred.id,
        reason: `Stored token could not be decrypted (${safeErrorMessage(err)}). Re-connect the credential.`,
      };
      continue;
    }

    try {
      const provider = resolveDnsProvider(cred.provider);
      const zone = await provider.findZone({ apiToken }, hostname);
      if (zone) {
        return {
          status: "matched",
          manager: { credentialId: cred.id, provider, zone, credentials: { apiToken } },
        };
      }
    } catch (err) {
      if (err instanceof DnsApiError && err.isAuthFailure) {
        unauthorized ??= { credentialId: cred.id, reason: safeErrorMessage(err) };
        continue;
      }
      if (err instanceof DnsApiError) {
        unavailable ??= safeErrorMessage(err);
        continue;
      }
      throw err;
    }
  }

  if (unauthorized) return { status: "unauthorized", ...unauthorized };
  if (unavailable) return { status: "unavailable", reason: unavailable };
  return { status: "none" };
}

/** Flag a credential the provider rejected so the UI can show it needs attention. */
export async function markCredentialInvalid(
  organizationId: string,
  credentialId: string,
): Promise<void> {
  await repos.dnsCredential
    .update(organizationId, credentialId, { status: "invalid" })
    .catch((err: unknown) =>
      console.warn("[dns] could not mark credential invalid:", safeErrorMessage(err)),
    );
}

/* ────── Record provisioning ─────────────────────────────────────── */

export interface DnsRecordOutcome {
  name: string;
  type: string;
  /** applied = created or updated; skipped = nothing to write; failed = see error. */
  outcome: "applied" | "skipped" | "failed";
  error?: string;
}

export interface DnsProvisionResult {
  /** True only when a provider managed the zone AND every record is in place. */
  provisioned: boolean;
  /** Present when we did not (or could not) act — safe to show an operator. */
  reason?: string;
  records: DnsRecordOutcome[];
}

/**
 * Write `desired` into whichever connected provider hosts the zone.
 *
 * Every record is attempted: one rejected value (a CNAME whose target we
 * couldn't resolve) must not suppress the ownership TXT that would have let the
 * domain verify. Failures are returned, not thrown — a domain add does not fail
 * because DNS automation did.
 */
export async function provisionRecords(
  organizationId: string,
  hostname: string,
  desired: DnsRecordInput[],
): Promise<DnsProvisionResult> {
  // No reason attached: "there was nothing to write" is not something to report
  // to an operator, and a reason here would make `autoDns` appear on the response
  // for a domain nobody is automating (external ingress returns no records).
  if (desired.length === 0) return { provisioned: false, records: [] };

  const lookup = await resolveDnsManager(organizationId, hostname);
  if (lookup.status === "unauthorized") {
    await markCredentialInvalid(organizationId, lookup.credentialId);
    return { provisioned: false, reason: lookup.reason, records: [] };
  }
  if (lookup.status === "unavailable") {
    return { provisioned: false, reason: lookup.reason, records: [] };
  }
  if (lookup.status === "none") {
    return { provisioned: false, records: [] };
  }

  const { provider, zone, credentials } = lookup.manager;
  const records: DnsRecordOutcome[] = [];

  for (const input of desired) {
    // `buildRecords` uses "" for a value it could not determine ("unknown — show
    // a placeholder"). Writing that is a guaranteed provider rejection.
    if (!input.content) {
      records.push({ name: input.name, type: input.type, outcome: "skipped" });
      continue;
    }

    try {
      await provider.upsertRecord(credentials, zone.id, input);
      records.push({ name: input.name, type: input.type, outcome: "applied" });
    } catch (err) {
      if (err instanceof DnsApiError && err.isAuthFailure) {
        await markCredentialInvalid(organizationId, lookup.manager.credentialId);
      }
      records.push({
        name: input.name,
        type: input.type,
        outcome: "failed",
        error: safeErrorMessage(err),
      });
    }
  }

  const applied = records.filter((r) => r.outcome === "applied").length;
  const failed = records.filter((r) => r.outcome === "failed");

  return {
    provisioned: failed.length === 0 && applied > 0,
    ...(failed.length > 0
      ? { reason: `${failed.length} of ${records.length} records could not be written.` }
      : {}),
    records,
  };
}

/**
 * Delete the records Openship created for `names`, and only those.
 *
 * Ownership is read off the provider-side comment marker. Name matching alone is
 * not enough: for an apex domain these names ARE the zone apex, where the
 * operator's MX, SPF TXT and CAA also live.
 */
export async function releaseRecords(
  organizationId: string,
  hostname: string,
  names: string[],
): Promise<{ deleted: number; reason?: string }> {
  const lookup = await resolveDnsManager(organizationId, hostname);
  if (lookup.status !== "matched") {
    return {
      deleted: 0,
      ...(lookup.status === "none" ? {} : { reason: lookup.reason }),
    };
  }

  const { provider, zone, credentials } = lookup.manager;
  let deleted = 0;

  for (const name of new Set(names)) {
    try {
      const found = await provider.listRecords(credentials, zone.id, { name });
      for (const record of found.filter(isOpenshipManaged)) {
        await provider.deleteRecord(credentials, zone.id, record.id);
        deleted++;
      }
    } catch (err) {
      // Best effort by design: a domain must still be removable from Openship
      // when the provider is unreachable. The leftover record is visible in the
      // operator's zone; a blocked delete is not.
      return { deleted, reason: safeErrorMessage(err) };
    }
  }

  return { deleted };
}
