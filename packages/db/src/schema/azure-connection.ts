import { pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organization } from "./organization";

/**
 * A panel organization's Azure DevOps connection.
 *
 * One row per (organization, Azure DevOps organization) pair. The PAT is the
 * customer's own credential — scoped by whoever created it, rotatable without
 * touching any other tenant, and never shared across organizations (unlike an
 * instance-wide token, which would leak read access across every project on
 * the panel).
 *
 * The PAT is stored in `patEncrypted`, sealed by the API with the versioned
 * `enc1:` envelope. The database package never decrypts it.
 */
export const azureConnection = pgTable(
  "azure_connection",
  {
    id: text("id").primaryKey(), // "azc_..."
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** Azure DevOps organization slug (e.g. "contoso" in dev.azure.com/contoso). */
    adoOrg: text("ado_org").notNull(),
    /** `enc1:` envelope containing the PAT. */
    patEncrypted: text("pat_encrypted").notNull(),
    patSetAt: timestamp("pat_set_at").notNull().defaultNow(),
    /** `active` | `invalid`; invalid connections fail clone resolution closed. */
    status: text("status").notNull().default("active"),
    /** Redacted operational reason only; never an upstream response body. */
    lastError: text("last_error"),
    lastVerifiedAt: timestamp("last_verified_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("uq_azure_connection_org_ado").on(t.organizationId, t.adoOrg)],
);

export type AzureConnection = typeof azureConnection.$inferSelect;
export type NewAzureConnection = typeof azureConnection.$inferInsert;
