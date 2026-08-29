/**
 * Move `dns_credential` rows into the generic `credential` store, once, at boot.
 *
 * WHY THIS IS CODE AND NOT A `.sql` MIGRATION — the part worth reading before changing it:
 * the old column is an `enc1:` AES-256-GCM envelope over the RAW token; the new one is an
 * envelope over a JSON object (which is what lets a provider hold several secrets without
 * new columns). The key is derived app-side from `BETTER_AUTH_SECRET`, so Postgres cannot
 * decrypt the old value and no amount of SQL can re-wrap it. The copy has to happen where
 * the key is.
 *
 * Which forces the release order, and it is not negotiable: migrations run BEFORE app code,
 * so a `DROP TABLE dns_credential` in the same release would delete every token before this
 * ever read one. This backfill empties the table; a LATER release drops it.
 *
 * Idempotent and best-effort, like the other boot reconciles: it runs on every start, so an
 * install that upgraded while the DB was briefly unreachable heals on the next one, and any
 * failure leaves the old rows exactly where they were.
 */

import { repos, type DnsCredential } from "@repo/db";
import { registerStartupHook } from "./index";
import { safeErrorMessage } from "@repo/core";

import { decryptSecretField, encryptSecretField } from "../credential-encryption";

/** What the DNS provider entry calls its secret field, per CREDENTIAL_PROVIDERS. */
const CLOUDFLARE_SECRET_FIELD = "apiToken";

/**
 * Copy one row. Returns why it was skipped, or null when it moved.
 *
 * The token is re-encrypted, never carried over as ciphertext: the two envelopes wrap
 * different things, and copying bytes would produce a row whose secret parses as neither.
 */
async function moveOne(row: DnsCredential): Promise<string | null> {
  let token: string | undefined;
  try {
    token = decryptSecretField(row.apiTokenEnc);
  } catch (err) {
    // A rotated BETTER_AUTH_SECRET. The token is unrecoverable either way, so the old row
    // is LEFT IN PLACE rather than deleted — an operator who restores the previous secret
    // can still migrate it, and deleting would destroy the only copy.
    return `undecryptable (${safeErrorMessage(err)})`;
  }
  if (!token) return "stored token was empty";

  const secretsEnc = encryptSecretField(JSON.stringify({ [CLOUDFLARE_SECRET_FIELD]: token }));
  if (!secretsEnc) return "re-encryption produced nothing";

  // Name collisions are real: the unique index is (org, provider, COALESCE(selector,''),
  // name) and a previous partial run may already hold this label. Treat an existing row as
  // done rather than failing the boot.
  if (await repos.credential.nameTaken(row.organizationId, "cloudflare", null, row.name)) {
    await repos.dnsCredential.delete(row.organizationId, row.id).catch(() => {});
    return null;
  }

  await repos.credential.create({
    organizationId: row.organizationId,
    provider: "cloudflare",
    name: row.name,
    // Org-wide: a Cloudflare token addresses every zone it can see, so there is nothing to
    // scope it to. NULL, never "" — the unique index would treat those as different rows.
    selector: null,
    publicFields: {},
    secretsEnc,
    // Carried, not reset: an operator who saw "invalid" here must keep seeing it, and
    // `lastVerifiedAt` is the only evidence of when it last worked.
    status: row.status,
    lastVerifiedAt: row.lastVerifiedAt,
  });

  // Delete only after the new row exists, so a crash between the two leaves a duplicate
  // (which the collision check above absorbs) rather than no credential at all.
  await repos.dnsCredential.delete(row.organizationId, row.id);
  return null;
}

/**
 * Run the backfill for every organization that still has a legacy row.
 *
 * Never throws: a boot hook that can fail startup over a credential copy would take an
 * instance down for a problem that is not urgent.
 */
export async function backfillDnsCredentials(): Promise<{ moved: number; skipped: number }> {
  let moved = 0;
  let skipped = 0;
  try {
    const rows = await repos.dnsCredential.listAll();
    if (rows.length === 0) return { moved: 0, skipped: 0 };

    for (const row of rows) {
      try {
        const why = await moveOne(row);
        if (why) {
          skipped += 1;
          console.warn(`[credential-backfill] left ${row.id} in place: ${why}`);
        } else {
          moved += 1;
        }
      } catch (err) {
        skipped += 1;
        console.warn(`[credential-backfill] ${row.id} failed: ${safeErrorMessage(err)}`);
      }
    }
    if (moved > 0) {
      console.log(`[credential-backfill] moved ${moved} DNS credential(s) into the credential store`);
    }
  } catch (err) {
    console.warn(`[credential-backfill] skipped: ${safeErrorMessage(err)}`);
  }
  return { moved, skipped };
}

/**
 * Boot hook.
 *
 * Self-hosted and desktop only, matching every other reconcile here: the SaaS never had a
 * `dns_credential` row to move.
 */
export function registerCredentialBackfill(): void {
  registerStartupHook({
    id: "credentials:dns-backfill",
    modes: ["selfhosted", "desktop"],
    run: async () => {
      const { skipped } = await backfillDnsCredentials();
      if (skipped > 0) {
        console.warn(
          `[credential-backfill] ${skipped} DNS credential(s) could not be moved and were left ` +
            `in place. Re-connect them from Settings → Credentials; the old rows are dropped in a ` +
            `later release.`,
        );
      }
    },
  });
}
