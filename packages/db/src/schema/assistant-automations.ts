import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  primaryKey,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { ExecutionAuthority } from "@repo/core";
import { assistantAgent } from "./assistant-agents";
import { user } from "./auth";
import { organization } from "./organization";
import { project } from "./project";

export const assistantAutomationSettings = pgTable(
  "assistant_automation_settings",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    paused: boolean("paused").notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.userId, t.organizationId] })],
);

export const assistantAutomation = pgTable(
  "assistant_automation",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    trigger: text("trigger").notNull(),
    agentId: text("agent_id").references(() => assistantAgent.id),
    provider: text("provider").notNull(),
    model: text("model").notNull().default(""),
    mode: text("mode").notNull().default("report"),
    action: text("action").notNull().default("none"),
    allowedActions: jsonb("allowed_actions").$type<string[] | null>(),
    readRepository: boolean("read_repository").notNull().default(false),
    instructions: text("instructions").notNull().default(""),
    channelIds: jsonb("channel_ids").$type<string[]>().notNull().default([]),
    cooldownMinutes: integer("cooldown_minutes").notNull().default(30),
    dailyLimit: integer("daily_limit").notNull().default(5),
    enabled: boolean("enabled").notNull().default(false),
    revision: integer("revision").notNull().default(1),
    authority: jsonb("authority").$type<ExecutionAuthority>().notNull(),
    accessFingerprint: text("access_fingerprint").notNull(),
    lastStartedAt: timestamp("last_started_at"),
    armedAt: timestamp("armed_at").notNull().defaultNow(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("assistant_automation_event_idx").on(t.organizationId, t.projectId, t.trigger),
    index("assistant_automation_owner_idx").on(t.organizationId, t.userId),
  ],
);

/** Durable event receipt and execution checkpoints. Never store log excerpts in notifications. */
export const assistantAutomationRun = pgTable(
  "assistant_automation_run",
  {
    id: text("id").primaryKey(),
    automationId: text("automation_id")
      .notNull()
      .references(() => assistantAutomation.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    definition: jsonb("definition")
      .$type<{ name: string; mode: string; action: string }>()
      .notNull(),
    eventKey: text("event_key").notNull(),
    deploymentId: text("deployment_id").notNull(),
    incidentId: text("incident_id"),
    state: text("state").notNull().default("queued"),
    message: text("message").notNull().default("Waiting to investigate."),
    conversationId: text("conversation_id"),
    tokenId: text("token_id"),
    token: text("token"),
    resultDeploymentId: text("result_deployment_id"),
    proposal: text("proposal"),
    proposedAction: text("proposed_action"),
    resultUrl: text("result_url"),
    actionClaimedAt: timestamp("action_claimed_at"),
    expiresAt: timestamp("expires_at"),
    leaseOwner: text("lease_owner"),
    leaseUntil: timestamp("lease_until"),
    notifiedAt: timestamp("notified_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("assistant_automation_event_once").on(t.automationId, t.eventKey),
    index("assistant_automation_run_queue_idx").on(t.state, t.updatedAt),
    index("assistant_automation_run_project_idx").on(t.organizationId, t.projectId),
  ],
);
