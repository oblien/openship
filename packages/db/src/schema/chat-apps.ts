import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  index,
  uniqueIndex,
  jsonb,
} from "drizzle-orm/pg-core";
import type { ExecutionAuthority } from "@repo/core";
import { sql } from "drizzle-orm";
import type { ChatAppPurpose, ChatAppTransport } from "@repo/contracts";
import { user } from "./auth";
import { organization } from "./organization";
import { servers } from "./servers";

/** Public connection metadata. Credentials and incoming messages have separate encrypted storage. */
export const chatAppConnection = pgTable(
  "chat_app_connection",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    serverId: text("server_id").references(() => servers.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    provider: text("provider").notNull(),
    transport: text("transport").$type<ChatAppTransport>().notNull().default("webhook"),
    purpose: text("purpose").$type<ChatAppPurpose>().notNull().default("commands"),
    origin: text("origin").notNull(),
    nativeId: text("native_id"),
    enabled: boolean("enabled").notNull().default(false),
    assistantAllowed: boolean("assistant_allowed").notNull().default(false),
    revision: integer("revision").notNull().default(1),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("chat_app_org_idx").on(t.organizationId)],
);
export const chatAppIdentity = pgTable(
  "chat_app_identity",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id")
      .notNull()
      .references(() => chatAppConnection.id, { onDelete: "cascade" }),
    externalWorkspace: text("external_workspace").notNull(),
    externalUser: text("external_user").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    clientId: text("client_id").notNull(),
    assistantProvider: text("assistant_provider"),
    assistantModel: text("assistant_model").notNull().default(""),
    assistantRevision: integer("assistant_revision").notNull().default(1),
    assistantAuthority: jsonb("assistant_authority").$type<ExecutionAuthority>(),
    assistantFingerprint: text("assistant_fingerprint"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("chat_app_sender_idx").on(t.connectionId, t.externalWorkspace, t.externalUser),
  ],
);
/** A private conversation per linked sender, channel and thread. No messages or credentials. */
export const chatAppThread = pgTable(
  "chat_app_thread",
  {
    id: text("id").primaryKey(),
    identityId: text("identity_id")
      .notNull()
      .references(() => chatAppIdentity.id, { onDelete: "cascade" }),
    senderKey: text("sender_key").notNull(),
    active: boolean("active").notNull().default(true),
    connectionRevision: integer("connection_revision").notNull(),
    identityRevision: integer("identity_revision").notNull(),
    conversationId: text("conversation_id").notNull().unique(),
  },
  (t) => [
    uniqueIndex("chat_app_thread_active_idx")
      .on(t.identityId, t.senderKey)
      .where(sql`${t.active} = true`),
    index("chat_app_thread_sender_idx").on(t.identityId, t.senderKey),
  ],
);
/** Expiring pairing, OAuth and action confirmations. Payloads are encrypted by the control plane. */
export const chatAppChallenge = pgTable(
  "chat_app_challenge",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id")
      .notNull()
      .references(() => chatAppConnection.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    payload: text("payload").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
  },
  (t) => [index("chat_app_challenge_expiry_idx").on(t.expiresAt)],
);
/** At-most-once execution receipts. Ambiguous interrupted writes are never automatically replayed. */
export const chatAppCommand = pgTable(
  "chat_app_command",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id")
      .notNull()
      .references(() => chatAppConnection.id, { onDelete: "cascade" }),
    externalUser: text("external_user").notNull(),
    command: text("command").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    identityId: text("identity_id"),
    state: text("state").notNull().default("running"),
    response: text("response"),
    conversationId: text("conversation_id"),
    assistantRequestId: text("assistant_request_id"),
    delivery: text("delivery"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("chat_app_command_connection_idx").on(t.connectionId, t.createdAt)],
);

/** Bot transport is owned by OpenShip, independently of optional assistant execution. */
export const chatAppTransportState = pgTable("chat_app_transport_state", {
  connectionId: text("connection_id")
    .primaryKey()
    .references(() => chatAppConnection.id, { onDelete: "cascade" }),
  configuration: text("configuration").notNull(),
  botKey: text("bot_key").notNull().unique(),
  cursor: text("cursor"),
  owner: text("owner"),
  leaseUntil: timestamp("lease_until"),
});

/** Verified provider deliveries, deduplicated before acknowledgment. Payloads are encrypted. */
export const chatAppInbox = pgTable(
  "chat_app_inbox",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id")
      .notNull()
      .references(() => chatAppConnection.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    payload: text("payload").notNull(),
    deliveredCount: integer("delivered_count").notNull().default(0),
    state: text("state").notNull().default("pending"),
    lease: text("lease"),
    leaseUntil: timestamp("lease_until"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("chat_app_inbox_pending_idx").on(t.connectionId, t.state, t.createdAt)],
);
