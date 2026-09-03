import { pgTable, text, timestamp, boolean } from "drizzle-orm/pg-core";

export const wildcardDomain = pgTable("wildcard_domain", {
  id: text("id").primaryKey(), // "wd_..."
  domain: text("domain").notNull().unique(), // e.g. "*.apps.example.com"
  apex: text("apex").notNull(), // e.g. "apps.example.com"
  isDefault: boolean("is_default").notNull().default(false),
  dnsProvider: text("dns_provider").default("manual"), // "cloudflare" | "manual"
  dnsZoneId: text("dns_zone_id"),
  dnsRecordId: text("dns_record_id"),
  sslStatus: text("ssl_status").notNull().default("none"), // "none" | "active" | "error"
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type WildcardDomain = typeof wildcardDomain.$inferSelect;
export type NewWildcardDomain = typeof wildcardDomain.$inferInsert;
