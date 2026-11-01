import { pgTable, text, timestamp, boolean, integer, jsonb, index } from "drizzle-orm/pg-core";
import type { ExecutionAuthority, GrantPermission, SourceAccessScope } from "@repo/core";
import { user } from "./auth";
import { organization } from "./organization";
import { servers } from "./servers";

/** OpenShip owns authority; the selected host's native bot owns its instructions and chats. */
export const assistantAgent = pgTable(
  "assistant_agent",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    clientId: text("client_id").notNull(),
    serverId: text("server_id").references(() => servers.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    model: text("model").notNull().default(""),
    icon: text("icon").notNull().default("bot"),
    nativeRevision: integer("native_revision").notNull(),
    revision: integer("revision").notNull().default(1),
    readOnly: boolean("read_only").notNull().default(true),
    grants: jsonb("grants")
      .$type<
        {
          resourceType: string;
          resourceId: string;
          permissions: GrantPermission[];
          scope?: SourceAccessScope | null;
        }[]
      >()
      .notNull(),
    authority: jsonb("authority").$type<ExecutionAuthority>().notNull(),
    archived: boolean("archived").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("assistant_agent_owner_idx").on(t.organizationId, t.userId)],
);
