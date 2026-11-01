import { pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { domain } from "./domain";
import { organization } from "./organization";

/** Internal ACME signing identities, distinct from operator-supplied DNS credentials. */
export const acmeAccount = pgTable(
  "acme_account",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    directoryUrl: text("directory_url").notNull(),
    keyEnc: text("key_enc").notNull(),
  },
  (t) => [uniqueIndex("uq_acme_account_org_directory").on(t.organizationId, t.directoryUrl)],
);

/** One current DNS certificate attempt per domain. No worker or project lock is
 * retained while a person adds a TXT record. Private order material is encrypted. */
export const domainDnsChallenge = pgTable("domain_dns_challenge", {
  domainId: text("domain_id")
    .primaryKey()
    .references(() => domain.id, { onDelete: "cascade" }),
  id: text("id").notNull(),
  mode: text("mode").$type<"automatic" | "manual">().notNull(),
  status: text("status")
    .$type<
      | "preparing"
      | "waiting"
      | "checking"
      | "installing"
      | "cancelling"
      | "completed"
      | "failed"
      | "cancelled"
      | "expired"
    >()
    .notNull(),
  recordName: text("record_name"),
  recordValue: text("record_value"),
  accountId: text("account_id").references(() => acmeAccount.id),
  orderEnc: text("order_enc"),
  leaseId: text("lease_id"),
  leaseExpiresAt: timestamp("lease_expires_at"),
  expiresAt: timestamp("expires_at").notNull(),
  logs: text("logs").notNull().default(""),
  error: text("error"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
