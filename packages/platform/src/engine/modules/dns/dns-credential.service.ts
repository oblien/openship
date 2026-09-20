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
import * as credentialService from "../credentials/credential.service";
import { listProviderCredentials } from "../credentials/credential.service";
import {
  DnsApiError,
  DnsProviderNotReadyError,
  isOpenshipManaged,
  type DnsProvider,
  type DnsProviderName,
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

/**
 * These endpoints are a VIEW over the generic `credential` store, not a second store.
 *
 * They stay while the Credentials screen replaces them so nothing breaks mid-migration —
 * but they read and write the same rows, because a token connected here and listed there
 * disagreeing would be worse than either UI alone.
 */
function asDnsCredential(
  organizationId: string,
  row: { id: string; provider: string; name: string; status: string; lastVerifiedAt: Date | null; createdAt: Date; updatedAt: Date },
): SanitizedDnsCredential {
  return {
    id: row.id,
    organizationId,
    provider: row.provider,
    name: row.name,
    status: row.status,
    // Unchanged guarantee: no endpoint returns the token, or a prefix of it.
    tokenMasked: ENV_MASK,
    lastVerifiedAt: row.lastVerifiedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listCredentials(organizationId: string): Promise<SanitizedDnsCredential[]> {
  const rows = await credentialService.listCredentials(organizationId);
  return rows
    .filter((r) => r.provider === "cloudflare")
    .map((r) => asDnsCredential(organizationId, r));
}

export async function getCredential(
  organizationId: string,
  id: string,
): Promise<SanitizedDnsCredential | null> {
  const row = await credentialService.getCredential(organizationId, id).catch(() => null);
  if (!row || row.provider !== "cloudflare") return null;
  return asDnsCredential(organizationId, row);
}

export async function addCredential(
  organizationId: string,
  input: { provider: string; name: string; apiToken: string },
): Promise<SanitizedDnsCredential> {
  // The credential service verifies with Cloudflare before storing — the same rule this
  // function used to enforce with `provider.preflight`, now applied to every provider.
  const row = await credentialService.createCredential(organizationId, {
    provider: "cloudflare",
    name: input.name,
    // Org-wide: the token addresses every zone it can see, so there is nothing to scope it
    // to, and the unique index treats a NULL selector as "" so labels stay unique.
    selector: null,
    values: { apiToken: input.apiToken },
  });
  return asDnsCredential(organizationId, row);
}

export async function removeCredential(organizationId: string, id: string): Promise<void> {
  const existing = await credentialService.getCredential(organizationId, id).catch(() => null);
  if (!existing || existing.provider !== "cloudflare") throw new NotFoundError("DNS credential", id);
  await credentialService.deleteCredential(organizationId, id);
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
  // The generic credential store is the single source of truth: `dns_credential` was one
  // of three places Openship kept a third-party secret, each with its own shape and form.
  // Rows land here via the boot backfill (see credential-backfill.ts) — SQL could not do
  // that copy, because the old column is an `enc1:` envelope over the RAW token and the new
  // one is over a JSON object, and the key is app-side.
  //
  // listProviderCredentials, not a single lookup: zone ownership is discovered by ASKING
  // each token which zones it can see, so a second token owning a second zone needs the
  // whole list.
  const credentials = await listProviderCredentials(organizationId, "cloudflare");
  if (credentials.length === 0) return { status: "none" };

  // Remembered, not returned immediately: a second credential may still own this
  // zone, and one broken token shouldn't hide a working one.
  let unauthorized: { credentialId: string; reason: string } | null = null;
  let unavailable: string | null = null;

  for (const cred of credentials) {
    if (!cred.readable) {
      // Almost always a rotated BETTER_AUTH_SECRET, or a cross-instance restore that
      // blanked the envelope. Same operator action as a revoked token: re-paste it. Kept
      // as a REASON rather than skipped, so this does not read as "no DNS provider".
      unauthorized ??= {
        credentialId: cred.id,
        reason: "Stored token could not be decrypted. Re-connect the credential.",
      };
      continue;
    }
    const apiToken = cred.secrets.apiToken!;

    try {
      const provider = resolveDnsProvider("cloudflare");
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
  await repos.credential
    .markInvalid(organizationId, credentialId, "The DNS provider rejected this token.")
    .catch((err: unknown) =>
      console.warn("[dns] could not mark credential invalid:", safeErrorMessage(err)),
    );
}

/* ────── Record provisioning ─────────────────────────────────────── */

/**
 * What we determined about a record relative to the zone, before touching it.
 *
 *   create   → nothing answers this name+type yet.
 *   update   → an Openship-managed record exists; we rewrite it in place.
 *   adopt    → one existing record we did NOT create; apply repoints it (that is
 *              what connecting a domain means) but leaves its ownership alone.
 *   in-sync  → a record already answers with exactly the value we'd write.
 *   conflict → more than one record answers and none is ours (a round-robin A set
 *              or multi-host MX the operator maintains); we never overwrite it.
 */
export type RecordPlanAction = "create" | "update" | "adopt" | "in-sync" | "conflict";

export interface DnsRecordOutcome {
  name: string;
  type: string;
  /** applied = created/updated/adopted; skipped = already in place or no value yet; failed = see error. */
  outcome: "applied" | "skipped" | "failed";
  /** The pre-write classification, so a status log can say what happened. */
  action?: RecordPlanAction;
  error?: string;
}

export interface DnsProvisionResult {
  /** True only when a provider managed the zone AND every record is in place. */
  provisioned: boolean;
  /** Present when we did not (or could not) act — safe to show an operator. */
  reason?: string;
  records: DnsRecordOutcome[];
}

export interface DnsRecordPlan {
  name: string;
  type: string;
  action: RecordPlanAction;
  /** The value apply would write. */
  desired: string;
  /** The value of the record apply would touch, when one already exists. */
  current?: string;
}

/**
 * A read-only preview of what apply would do — the on-demand button's input.
 *
 * `status` is the `resolveDnsManager` discriminant: `matched` means a connected
 * provider owns the zone and `records` carries a per-record action; every other
 * status means we can't (or don't) manage it and `records` is empty.
 */
export interface DnsPlanResult {
  status: DnsManagerLookup["status"];
  provider?: DnsProviderName;
  zoneName?: string;
  /** Present for unauthorized/unavailable — safe to show an operator. */
  reason?: string;
  records: DnsRecordPlan[];
}

/**
 * Classify one desired record against the zone WITHOUT writing — the shared
 * decision behind both the plan preview and the apply loop, so they can never
 * disagree about what a press will do.
 */
async function classifyRecord(
  provider: DnsProvider,
  credentials: { apiToken: string },
  zoneId: string,
  desired: DnsRecordInput,
): Promise<{ action: RecordPlanAction; current?: string }> {
  const existing = await provider.listRecords(credentials, zoneId, {
    name: desired.name,
    type: desired.type,
  });
  // Mirrors the provider's upsert decision: >1 records none of which are ours is
  // a set the operator maintains; a single foreign record is adopted (repointed);
  // ours is updated in place.
  const target = existing.length > 1 ? existing.find(isOpenshipManaged) : existing[0];
  if (existing.length > 1 && !target) {
    return { action: "conflict", current: `${existing.length} existing records` };
  }
  if (!target) return { action: "create" };
  if (target.content === desired.content) return { action: "in-sync", current: target.content };
  return { action: isOpenshipManaged(target) ? "update" : "adopt", current: target.content };
}

/**
 * Preview what `apply` would do to `desired`, reading only. Powers the
 * on-demand "Auto-configure DNS" button: the operator sees create/update/adopt/
 * in-sync/conflict per record before anything is written.
 *
 * Records with no value yet (`buildRecords` uses "" for "unknown") are dropped —
 * there is nothing to plan for a record whose target we can't determine.
 */
export async function planRecords(
  organizationId: string,
  hostname: string,
  desired: DnsRecordInput[],
): Promise<DnsPlanResult> {
  const provisionable = desired.filter((r) => r.content);
  if (provisionable.length === 0) return { status: "none", records: [] };

  const lookup = await resolveDnsManager(organizationId, hostname);
  if (lookup.status !== "matched") {
    return {
      status: lookup.status,
      ...(lookup.status === "unauthorized" || lookup.status === "unavailable"
        ? { reason: lookup.reason }
        : {}),
      records: [],
    };
  }

  const { provider, zone, credentials } = lookup.manager;
  const records: DnsRecordPlan[] = [];
  for (const input of provisionable) {
    try {
      const { action, current } = await classifyRecord(provider, credentials, zone.id, input);
      records.push({
        name: input.name,
        type: input.type,
        action,
        desired: input.content,
        ...(current !== undefined ? { current } : {}),
      });
    } catch (err) {
      // A list that failed on auth or transport is "couldn't check", never a
      // half-plan the operator might apply against — collapse to the lookup's
      // own vocabulary.
      if (err instanceof DnsApiError && err.isAuthFailure) {
        await markCredentialInvalid(organizationId, lookup.manager.credentialId);
        return { status: "unauthorized", reason: safeErrorMessage(err), records: [] };
      }
      return { status: "unavailable", reason: safeErrorMessage(err), records: [] };
    }
  }

  return { status: "matched", provider: provider.name, zoneName: zone.name, records };
}

/**
 * Write `desired` into whichever connected provider hosts the zone.
 *
 * Check-before-set: each record is classified first, so a record already in place
 * is reported (skipped) rather than rewritten, and a conflict the operator owns is
 * refused rather than clobbered. Every record is attempted independently — one
 * rejected value must not suppress the others. Failures are returned, not thrown.
 */
export async function provisionRecords(
  organizationId: string,
  hostname: string,
  desired: DnsRecordInput[],
): Promise<DnsProvisionResult> {
  // No reason attached: "there was nothing to write" is not something to report
  // to an operator, and external ingress legitimately produces no provider
  // inputs. The on-demand panel can keep showing the manual-record fallback.
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
      const { action } = await classifyRecord(provider, credentials, zone.id, input);
      if (action === "in-sync") {
        records.push({ name: input.name, type: input.type, outcome: "skipped", action });
        continue;
      }
      if (action === "conflict") {
        records.push({
          name: input.name,
          type: input.type,
          outcome: "failed",
          action,
          error:
            "Existing records here are not managed by Openship — remove or consolidate them first.",
        });
        continue;
      }
      await provider.upsertRecord(credentials, zone.id, input);
      records.push({ name: input.name, type: input.type, outcome: "applied", action });
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
  const inSync = records.filter((r) => r.outcome === "skipped" && r.action === "in-sync").length;
  const failed = records.filter((r) => r.outcome === "failed");

  return {
    // In place = applied now, or already correct. Empty-value skips don't count:
    // "provisioned" must not be true for a domain whose records we never set.
    provisioned: failed.length === 0 && applied + inSync > 0,
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
