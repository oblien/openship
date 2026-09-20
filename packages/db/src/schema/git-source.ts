import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organization } from "./organization";

/**
 * An organization-owned Git provider application.
 *
 * Public application identity is stored in discrete columns so it can be
 * listed without touching secret material. Private keys, client secrets and
 * webhook secrets live together in `secretsEnc`, sealed by the API with the
 * versioned `enc1:` envelope. The database package deliberately never decrypts
 * that value.
 */
export const gitSource = pgTable(
  "git_source",
  {
    id: text("id").primaryKey(), // "src_..."
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    provider: text("provider").notNull().default("github"),
    name: text("name").notNull(),

    appId: integer("app_id").notNull(),
    slug: text("slug").notNull(),
    clientId: text("client_id"),
    appName: text("app_name"),
    avatarUrl: text("avatar_url"),

    /** GitHub/GHE origins, without a trailing slash. */
    apiBaseUrl: text("api_base_url").notNull().default("https://api.github.com"),
    webBaseUrl: text("web_base_url").notNull().default("https://github.com"),
    /** Exact URL registered on the App when this source was created. */
    webhookUrl: text("webhook_url").notNull(),

    /** `enc1:` envelope containing privateKeyPem/clientSecret/webhookSecret. */
    secretsEnc: text("secrets_enc").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    /** `active` | `invalid`; invalid sources are excluded from token resolution. */
    status: text("status").notNull().default("active"),
    lastVerifiedAt: timestamp("last_verified_at"),
    /** Redacted operational reason only; never an upstream response body. */
    lastError: text("last_error"),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("idx_git_source_org_provider").on(t.organizationId, t.provider),
    uniqueIndex("uq_git_source_org_provider_name").on(
      t.organizationId,
      t.provider,
      sql`lower(${t.name})`,
    ),
    uniqueIndex("uq_git_source_org_provider_app").on(
      t.organizationId,
      t.provider,
      t.apiBaseUrl,
      t.appId,
    ),
    // Exactly one preferred source per provider and organization. PostgreSQL's
    // partial unique index keeps non-default rows unconstrained.
    uniqueIndex("uq_git_source_org_provider_default")
      .on(t.organizationId, t.provider)
      .where(sql`${t.isDefault} = true`),
  ],
);
