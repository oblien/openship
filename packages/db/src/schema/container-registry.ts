import { boolean, index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organization } from "./organization";

/** Organization-scoped registry binding for digest-pinned source builds. */
export const containerRegistry = pgTable(
  "container_registry",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    registryUrl: text("registry_url").notNull(),
    repositoryPrefix: text("repository_prefix"),
    username: text("username"),
    /** Encrypted password/token/docker config (enc1: envelope), never serialized by default. */
    credentialsEnc: text("credentials_enc"),
    insecure: boolean("insecure").notNull().default(false),
    lastVerifiedAt: timestamp("last_verified_at"),
    lastVerifyError: text("last_verify_error"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_container_registry_org_name").on(t.organizationId, t.name),
    index("idx_container_registry_org").on(t.organizationId),
  ],
);
