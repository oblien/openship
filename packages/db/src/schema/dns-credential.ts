import { pgTable, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { organization } from "./organization";

// ─── dns_credential ──────────────────────────────────────────────────────────

/**
 * Organization-scoped DNS provider credentials (Cloudflare today).
 *
 * Holding one of these lets Openship write the A/CNAME + `_openship-challenge`
 * TXT records a custom domain needs, instead of printing them for the operator
 * to paste. That is a lot of authority — the token can rewrite every record in
 * every zone it can see — so:
 *   - the token is encrypted at rest with the standard `enc1:` AES-256-GCM
 *     envelope (`encryptSecretField`), decrypted only for the provider call;
 *   - the API returns a constant mask, never plaintext and never a prefix of it;
 *   - `status` is how a token that stopped working becomes visible — the
 *     provisioning path flips it to "invalid" on a 401/403 instead of failing
 *     silently forever.
 */
export const dnsCredential = pgTable(
  "dns_credential",
  {
    id: text("id").primaryKey(), // "dns_..."
    /** Organization that owns this credential. */
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),

    /** Provider name ("cloudflare"). Text, not an enum, so adding a provider is
     *  a registry entry rather than a migration. */
    provider: text("provider").notNull(),
    /** Operator-facing label, e.g. "Cloudflare production". */
    name: text("name").notNull(),
    /** Encrypted API token (`enc1:...`). Never leaves the process in plaintext. */
    apiTokenEnc: text("api_token_enc").notNull(),
    /** "active" | "invalid" — "invalid" means the provider rejected the token. */
    status: text("status").notNull().default("active"),
    /** Last time the provider accepted this token. */
    lastVerifiedAt: timestamp("last_verified_at"),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    // Zone resolution reads "this org's ACTIVE credentials" on every domain add
    // and remove; the org-only listing rides the same index as a prefix.
    index("idx_dns_credential_org_status").on(table.organizationId, table.status),
    // One label per provider per org — a second "Cloudflare production" is a
    // double-submit, not a second credential.
    uniqueIndex("uq_dns_credential_org_provider_name").on(
      table.organizationId,
      table.provider,
      table.name,
    ),
  ],
);
