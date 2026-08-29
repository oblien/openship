import { pgTable, text, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organization } from "./organization";

// ─── credential ──────────────────────────────────────────────────────────────

/**
 * Organization-scoped third-party credentials — one table for every provider.
 *
 * Openship holds other people's secrets for unrelated jobs (write a DNS record, pull a
 * private image, later push a backup), and each job had grown its own storage: a single
 * token column on `dns_credential`, five encrypted columns inlined on a backup
 * destination, a channel's own on notifications. Same `enc1:` envelope, three shapes,
 * three forms, and no way to reuse one credential across features.
 *
 * The unit is the CREDENTIAL, deliberately not its consumer. A destination is a place, a
 * zone is a zone, a channel is a route — each keeps its own row and points here. That is
 * what makes one Cloudflare token serve every zone, and one `ghcr.io` login every
 * project.
 *
 * Provider-specific knowledge lives in `CREDENTIAL_PROVIDERS` (@repo/core), not in
 * columns: the field declarations there decide which submitted values are encrypted and
 * which are readable, so adding a provider touches a registry entry and a verify
 * function — never this table.
 *
 * NOT for `personal_access_token`: those are INBOUND (authenticating TO Openship), with
 * different scoping and revocation. Same word "token", opposite direction.
 */
export const credential = pgTable(
  "credential",
  {
    id: text("id").primaryKey(), // "cred_..."
    /** Organization that owns this credential. */
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),

    /** Provider id from `CREDENTIAL_PROVIDERS`. Text, not an enum, so a new provider is
     *  a registry entry rather than a migration. */
    provider: text("provider").notNull(),
    /** Operator-facing label, e.g. "GHCR read-only". */
    name: text("name").notNull(),
    /**
     * What this credential applies to, when one per provider is not enough: a normalized
     * registry host for `docker-registry`, NULL for an org-wide `cloudflare` token.
     *
     * Stored through `normalizeCredentialSelector` so the value a pull derives from an
     * image reference is byte-identical to what the operator typed — `https://GHCR.IO/`
     * and `ghcr.io` must not become two rows that each fail to match.
     */
    selector: text("selector"),

    /** Non-secret fields (username, region, endpoint). Safe to return unmodified. */
    publicFields: jsonb("public_fields")
      .$type<Record<string, string>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /**
     * Every secret field for this provider as ONE `enc1:` envelope over a JSON object
     * (`encryptSecretField(JSON.stringify({...}))`).
     *
     * One envelope rather than a column per secret is what lets a provider with a key
     * PAIR (S3) or a key plus passphrase (SFTP) arrive without a migration — the shape
     * inside is the provider's business, declared in @repo/core.
     */
    secretsEnc: text("secrets_enc").notNull(),

    /** "active" | "invalid" — "invalid" means the provider rejected it. */
    status: text("status").notNull().default("active"),
    /** Last time the provider accepted this credential. */
    lastVerifiedAt: timestamp("last_verified_at"),
    /** Redacted reason the last verify/use failed; never a provider response body. */
    lastError: text("last_error"),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    // "This org's credential for this provider and this resource" — asked on every deploy
    // that pulls and every domain that provisions. The org-wide and per-provider listings
    // ride this as prefixes, so it is the only lookup index needed; `status` is filtered
    // in code because there are a handful of rows per org.
    index("idx_credential_org_provider_selector").on(
      table.organizationId,
      table.provider,
      table.selector,
    ),
    // One label per provider per resource per org.
    //
    // COALESCE, not the bare column: Postgres treats NULLs as DISTINCT in a unique index,
    // so every org-wide provider (selector IS NULL) would accept unlimited duplicates of
    // one name and this constraint would quietly enforce nothing.
    uniqueIndex("uq_credential_org_provider_selector_name").on(
      table.organizationId,
      table.provider,
      sql`COALESCE(${table.selector}, '')`,
      table.name,
    ),
  ],
);
