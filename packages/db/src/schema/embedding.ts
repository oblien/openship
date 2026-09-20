import { pgTable, text, timestamp, primaryKey } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { organization } from "./organization";

/** A durable host assertion maps by issuer/subject, never by an unverified email. */
export const externalIdentity = pgTable("external_identity", {
  issuer: text("issuer").notNull(),
  subject: text("subject").notNull(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.issuer, t.subject] })]);

/** External customer/namespace keys select an organization; groups are not a security boundary. */
export const externalNamespace = pgTable("external_namespace", {
  issuer: text("issuer").notNull(),
  key: text("key").notNull(),
  organizationId: text("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.issuer, t.key] })]);

/** Installation identity and a one-way key check prevent attaching with another application's key. */
export const platformInstance = pgTable("platform_instance", {
  id: text("id").primaryKey(),
  instanceId: text("instance_id").notNull(),
  keyFingerprint: text("key_fingerprint").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
