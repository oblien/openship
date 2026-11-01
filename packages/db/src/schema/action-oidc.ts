import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** Instance-wide signing identity, never exposed by an organization API. */
export const actionOidcKey = pgTable("action_oidc_key", {
  id: text("id").primaryKey(), // canonical issuer URL
  kid: text("kid").notNull(),
  privateKeyEnc: text("private_key_enc").notNull(),
  publicKey: jsonb("public_key").$type<Record<string, string>>().notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
