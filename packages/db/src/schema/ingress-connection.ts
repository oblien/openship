import {
  pgTable,
  text,
  boolean,
  integer,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { organization } from "./organization";
import { servers } from "./servers";
import { credential } from "./credential";

/** One explicit public-ingress binding per destination. Secrets remain in credential. */
export const ingressConnection = pgTable(
  "ingress_connection",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
    serverId: text("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "restrict" }),
    credentialId: text("credential_id")
      .notNull()
      .references(() => credential.id, { onDelete: "restrict" }),
    provider: text("provider").notNull().default("cloudflare"),
    accountId: text("account_id").notNull(),
    tunnelId: text("tunnel_id"),
    name: text("name").notNull(),
    managedTunnel: boolean("managed_tunnel").notNull().default(false),
    connector: text("connector").$type<"existing" | "managed">().notNull(),
    edgePort: integer("edge_port").notNull().default(80),
    defaultForDomains: boolean("default_for_domains").notNull().default(false),
    defaultAccessPolicyId: text("default_access_policy_id"),
    status: text("status")
      .$type<"pending" | "ready" | "error" | "removing">()
      .notNull()
      .default("pending"),
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at").notNull().defaultNow(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("ingress_connection_due").on(t.status, t.nextAttemptAt),
    uniqueIndex("ingress_connection_server").on(t.serverId),
    uniqueIndex("ingress_connection_tunnel").on(t.accountId, t.tunnelId),
  ],
);
