/**
 * Third-party credentials — CRUD, verification, and the one accessor consumers use.
 *
 * The store is generic (see `credential` in @repo/db); everything provider-specific comes
 * from `CREDENTIAL_PROVIDERS` in @repo/core, so this file adds a provider only by gaining
 * a verifier.
 *
 * TWO RULES THIS FILE EXISTS TO ENFORCE:
 *
 * 1. NOTHING RETURNS A SECRET. Reads produce `publicFields` plus a constant mask per
 *    secret field — never the value, never a prefix of it, never its length. The only way
 *    out is {@link resolveCredentialSecrets}, which is server-internal and takes an
 *    organization id.
 *
 * 2. A CREDENTIAL IS VERIFIED BEFORE IT IS STORED. The DNS slice set that precedent and
 *    its reasoning generalizes: an unverified credential silently owns the lookup for
 *    every consumer that matches it, so storing a broken registry login turns a working
 *    anonymous pull into a failing authenticated one.
 */

import { repos, type Credential } from "@repo/db";
import {
  CREDENTIAL_MASK,
  getCredentialProvider,
  normalizeCredentialSelector,
  splitCredentialValues,
  validateCredentialValues,
  type CredentialProvider,
} from "@repo/core";

import { ConflictError, NotFoundError, ValidationError } from "@repo/core";
import { encryptSecretField, decryptSecretField } from "../../lib/credential-encryption";
import { hasVerifier, verifyCredentialValues, type CredentialSecrets } from "./verify";

// ─── Read shape ──────────────────────────────────────────────────────────────

export interface SanitizedCredential {
  id: string;
  provider: string;
  providerLabel: string;
  name: string;
  selector: string | null;
  /** Non-secret values, as stored. */
  publicFields: Record<string, string>;
  /** Secret field key → the constant mask. Tells the UI which inputs exist, nothing else. */
  secretsMasked: Record<string, string>;
  status: string;
  lastVerifiedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Row → API shape.
 *
 * The mask is per DECLARED secret field, not per stored key, so the UI renders the right
 * inputs even for a row whose secrets were blanked by a cross-instance restore.
 */
export function sanitizeCredential(row: Credential): SanitizedCredential {
  const provider = getCredentialProvider(row.provider);
  const secretsMasked: Record<string, string> = {};
  for (const field of provider?.fields ?? []) {
    if (field.type === "secret") secretsMasked[field.key] = CREDENTIAL_MASK;
  }
  return {
    id: row.id,
    provider: row.provider,
    providerLabel: provider?.label ?? row.provider,
    name: row.name,
    selector: row.selector,
    publicFields: row.publicFields ?? {},
    secretsMasked,
    status: row.status,
    lastVerifiedAt: row.lastVerifiedAt,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ─── Secret envelope ─────────────────────────────────────────────────────────

/**
 * Decrypt the stored envelope.
 *
 * An EMPTY result is a real, expected state, not corruption: `secrets_enc` is NOT NULL, so
 * a cross-instance restore writes `""` there (the redaction pass cannot carry a secret
 * sealed with the source instance's key). Callers must treat empty as "re-enter this
 * credential", exactly as the DNS service does today — never as "no credential needed".
 */
function readSecrets(row: Credential): CredentialSecrets {
  try {
    // The DECRYPT is inside the try, not before it. A rotated `BETTER_AUTH_SECRET` makes
    // `decryptSecretField` THROW, and letting that escape turned "this credential needs
    // re-connecting" into a crash on every read path — including the plain listing of
    // every OTHER credential in the org.
    const plain = decryptSecretField(row.secretsEnc);
    if (!plain) return {};
    const parsed = JSON.parse(plain) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: CredentialSecrets = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    // Undecryptable or not JSON — same handling as empty. Deliberately not thrown: one
    // unreadable credential must not break the listing of every other one.
    return {};
  }
}

function writeSecrets(secrets: CredentialSecrets): string {
  const enc = encryptSecretField(JSON.stringify(secrets));
  if (!enc) throw new Error("Failed to encrypt the credential.");
  return enc;
}

// ─── Reads ───────────────────────────────────────────────────────────────────

export async function listCredentials(organizationId: string): Promise<SanitizedCredential[]> {
  const rows = await repos.credential.listByOrg(organizationId);
  return rows.map(sanitizeCredential);
}

export async function getCredential(
  organizationId: string,
  id: string,
): Promise<SanitizedCredential> {
  const row = await repos.credential.findById(organizationId, id);
  if (!row) throw new NotFoundError("Credential", id);
  return sanitizeCredential(row);
}

// ─── Writes ──────────────────────────────────────────────────────────────────

function requireProvider(providerId: string): CredentialProvider {
  const provider = getCredentialProvider(providerId);
  if (!provider) throw new ValidationError(`Unknown credential provider "${providerId}".`);
  // A provider Openship cannot check must not be storable: rule 2 above would be
  // unenforceable for it, and the operator would get a credential that looks fine.
  if (!hasVerifier(provider.id)) {
    throw new ValidationError(`Openship cannot verify ${provider.label} credentials yet.`);
  }
  return provider;
}

export interface CredentialInput {
  provider: string;
  name: string;
  selector?: string | null;
  /** Field key → value, mixing readable and secret; the registry decides which is which. */
  values: Record<string, string | undefined>;
}

export async function createCredential(
  organizationId: string,
  input: CredentialInput,
): Promise<SanitizedCredential> {
  const provider = requireProvider(input.provider);
  const name = input.name.trim();
  if (!name) throw new ValidationError("A name is required.");

  const selector = normalizeCredentialSelector(provider, input.selector);
  if (provider.selector?.required && !selector) {
    throw new ValidationError(`${provider.selector.label} is required.`);
  }

  const errors = validateCredentialValues(provider, input.values);
  if (errors.length) throw new ValidationError(errors.join("; "));

  // Reject the duplicate here rather than letting the unique index raise, so the operator
  // reads "you already have one called that" instead of a constraint name.
  if (await repos.credential.nameTaken(organizationId, provider.id, selector, name)) {
    throw new ConflictError(`A ${provider.label} credential named "${name}" already exists.`);
  }

  const { publicFields, secrets } = splitCredentialValues(provider, input.values);
  const verdict = await verifyCredentialValues(provider, { selector, publicFields, secrets });
  if (!verdict.ok) throw new ValidationError(verdict.reason ?? "The provider rejected this credential.");

  const row = await repos.credential.create({
    organizationId,
    provider: provider.id,
    name,
    selector,
    publicFields,
    secretsEnc: writeSecrets(secrets),
    status: "active",
    lastVerifiedAt: new Date(),
  });
  return sanitizeCredential(row);
}

export async function updateCredential(
  organizationId: string,
  id: string,
  input: { name?: string; selector?: string | null; values?: Record<string, string | undefined> },
): Promise<SanitizedCredential> {
  const row = await repos.credential.findById(organizationId, id);
  if (!row) throw new NotFoundError("Credential", id);
  const provider = requireProvider(row.provider);

  const name = input.name?.trim() || row.name;
  const selector =
    input.selector === undefined
      ? row.selector
      : normalizeCredentialSelector(provider, input.selector);
  if (provider.selector?.required && !selector) {
    throw new ValidationError(`${provider.selector.label} is required.`);
  }

  // "Leave blank to keep" applies only while the credential stays bound to the same
  // destination. In that case the stored secret counts as present during validation.
  const held = readSecrets(row);
  const submitted = input.values ?? {};
  // A stored secret is bound to the destination it was entered for. Reusing it after an
  // admin changes the selector would turn this write-only store into a secret-export
  // primitive: point the credential at a server they control, leave the masked field
  // blank, and let verification send the old secret there. A new destination therefore
  // requires new secret material; optional held secrets are dropped rather than carried.
  const mayReuseHeldSecrets = selector === row.selector;
  const errors = validateCredentialValues(provider, submitted, {
    existingSecretKeys: mayReuseHeldSecrets ? Object.keys(held) : [],
  });
  if (errors.length) throw new ValidationError(errors.join("; "));

  if (await repos.credential.nameTaken(organizationId, provider.id, selector, name, id)) {
    throw new ConflictError(`A ${provider.label} credential named "${name}" already exists.`);
  }

  const split = splitCredentialValues(provider, submitted);
  const publicFields = { ...row.publicFields, ...split.publicFields };
  const secrets = mayReuseHeldSecrets ? { ...held, ...split.secrets } : split.secrets;

  // Re-verified on every update: a changed username, registry host or secret can each
  // invalidate the pair, and the point of verifying at all is that a stored credential
  // was known good at the moment it was stored.
  const verdict = await verifyCredentialValues(provider, { selector, publicFields, secrets });
  if (!verdict.ok) throw new ValidationError(verdict.reason ?? "The provider rejected this credential.");

  const updated = await repos.credential.update(organizationId, id, {
    name,
    selector,
    publicFields,
    secretsEnc: writeSecrets(secrets),
    status: "active",
    lastVerifiedAt: new Date(),
    lastError: null,
  });
  if (!updated) throw new NotFoundError("Credential", id);
  return sanitizeCredential(updated);
}

export async function deleteCredential(organizationId: string, id: string): Promise<void> {
  const row = await repos.credential.findById(organizationId, id);
  if (!row) throw new NotFoundError("Credential", id);
  await repos.credential.remove(organizationId, id);
}

/**
 * Re-check a stored credential against its provider and record the answer.
 *
 * This is how a credential revoked upstream becomes VISIBLE rather than failing every
 * deploy forever: `status` flips to `invalid` with a redacted reason, which the settings
 * list renders.
 */
export async function verifyCredential(
  organizationId: string,
  id: string,
): Promise<SanitizedCredential> {
  const row = await repos.credential.findById(organizationId, id);
  if (!row) throw new NotFoundError("Credential", id);
  const provider = getCredentialProvider(row.provider);
  if (!provider) throw new ValidationError(`Unknown credential provider "${row.provider}".`);

  const secrets = readSecrets(row);
  if (Object.keys(secrets).length === 0) {
    // The restore case: the row survived a cross-instance move but its secret could not.
    const reason = "The stored secret is empty — re-enter it.";
    await repos.credential.markInvalid(organizationId, id, reason);
    return sanitizeCredential({ ...row, status: "invalid", lastError: reason });
  }

  const verdict = await verifyCredentialValues(provider, {
    selector: row.selector,
    publicFields: row.publicFields ?? {},
    secrets,
  });
  if (verdict.ok) await repos.credential.markVerified(organizationId, id);
  else await repos.credential.markInvalid(organizationId, id, verdict.reason ?? "Rejected by the provider.");

  const fresh = await repos.credential.findById(organizationId, id);
  return sanitizeCredential(fresh ?? row);
}

// ─── The consumer accessor ───────────────────────────────────────────────────

export interface ResolvedCredential {
  id: string;
  publicFields: Record<string, string>;
  secrets: CredentialSecrets;
}

/**
 * The ACTIVE credential for a provider + resource, decrypted — the only path that yields
 * a secret, and server-internal by construction (it takes an organization id and is never
 * reachable from a controller).
 *
 * `selector` must already be normalized: matching is exact, so pass what
 * `normalizeCredentialSelector` (or `registryForImage`) produced, never raw operator text.
 *
 * Returns undefined when there is no credential OR when the stored envelope is empty. Both
 * mean "nothing usable here" to a caller, and conflating them is correct: a consumer's job
 * is to fall back to an anonymous attempt, not to explain the difference.
 */
export async function resolveCredentialSecrets(opts: {
  organizationId: string;
  provider: string;
  selector: string | null;
}): Promise<ResolvedCredential | undefined> {
  const row = await repos.credential.findActive(opts.organizationId, opts.provider, opts.selector);
  if (!row) return undefined;
  const secrets = readSecrets(row);
  if (Object.keys(secrets).length === 0) return undefined;
  return { id: row.id, publicFields: row.publicFields ?? {}, secrets };
}

/**
 * Every ACTIVE credential for one provider, with its secrets and whether they could be
 * read — for a consumer that must TRY each one rather than pick.
 *
 * DNS zone resolution is exactly that: it asks each token which zones it can see, so a
 * second token owning a second zone depends on getting the whole list.
 *
 * `readable: false` is reported rather than filtered, and that matters: an undecryptable
 * credential (almost always a rotated `BETTER_AUTH_SECRET`, or a cross-instance restore
 * that blanked the envelope) needs the operator told to re-connect it. Dropping it
 * silently turns that into "no credential configured", which is the same words for a
 * completely different fix.
 */
export interface ProviderCredential {
  id: string;
  publicFields: Record<string, string>;
  /** Empty when `readable` is false. */
  secrets: CredentialSecrets;
  readable: boolean;
}

export async function listProviderCredentials(
  organizationId: string,
  provider: string,
): Promise<ProviderCredential[]> {
  const rows = await repos.credential.listActiveByProvider(organizationId, provider);
  return rows.map((row) => {
    const secrets = readSecrets(row);
    const readable = Object.keys(secrets).length > 0;
    return { id: row.id, publicFields: row.publicFields ?? {}, secrets, readable };
  });
}
