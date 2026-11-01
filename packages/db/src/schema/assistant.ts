import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  index,
  uniqueIndex,
  primaryKey,
} from "drizzle-orm/pg-core";
import type { ExecutionAuthority } from "@repo/core";
import { assistantAgent } from "./assistant-agents";
import { user } from "./auth";
import { organization } from "./organization";
import { servers } from "./servers";

/** Opt-in metadata only. Better Auth remains the sole store/issuer of MCP credentials. */
export const assistantConnection = pgTable(
  "assistant_connection",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    clientId: text("client_id").notNull(),
    origin: text("origin").notNull(),
    serverId: text("server_id").references(() => servers.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.organizationId] }),
    uniqueIndex("assistant_connection_client_idx").on(t.clientId),
  ],
);

/** Mindwire owns messages. Only ownership, native identity and turn receipts live here. */
export const assistantConversation = pgTable(
  "assistant_conversation",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    clientId: text("client_id").notNull(),
    accessFingerprint: text("access_fingerprint").notNull(),
    nativeChatId: text("native_chat_id").notNull().unique(),
    serverId: text("server_id").references(() => servers.id, { onDelete: "cascade" }),
    title: text("title").notNull().default("New conversation"),
    provider: text("provider").notNull(),
    model: text("model").notNull().default(""),
    agentId: text("agent_id").references(() => assistantAgent.id),
    agentRevision: integer("agent_revision"),
    authority: jsonb("authority").$type<ExecutionAuthority>(),
    executionToken: text("execution_token"),
    executionTokenId: text("execution_token_id"),
    automationRunId: text("automation_run_id"),
    chatThreadId: text("chat_thread_id"),
    state: text("state").notNull().default("idle"),
    requestId: text("request_id"),
    runId: text("run_id"),
    runOwner: text("run_owner"),
    leaseExpiresAt: timestamp("lease_expires_at"),
    stopRequested: boolean("stop_requested").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [index("assistant_conversation_owner_idx").on(t.organizationId, t.userId)],
);

/** Short-lived authorization handshakes survive load balancing; secrets are sealed by the instance. */
export const assistantAuthorization = pgTable("assistant_authorization", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  payload: text("payload").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
});

export const assistantRequest = pgTable(
  "assistant_request",
  {
    conversationId: text("conversation_id")
      .notNull()
      .references(() => assistantConversation.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    messageHash: text("message_hash").notNull(),
    state: text("state").notNull().default("running"),
    runId: text("run_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.conversationId, t.id] })],
);
