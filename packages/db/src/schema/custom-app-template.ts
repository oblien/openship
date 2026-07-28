import { pgTable, text, jsonb, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import type { AppTemplate } from "@repo/core";
import { organization } from "./organization";
import { user } from "./auth";

// ─── Custom (user-uploaded) app templates ───────────────────────────────────

/**
 * A per-ORG custom app: a user-uploaded catalog template, stored so it appears
 * as an UNVERIFIED card in that org's Apps catalog and installs like a curated
 * app. Trust is provenance-based — the service forces `verified:false` +
 * `available:true` before storing, so a JSON claiming `"verified": true` is
 * never trusted. Isolated per org (a member of org A never sees org B's custom
 * apps). Re-uploading the same `appId` upserts (update-my-custom-app).
 */
export const customAppTemplate = pgTable(
  "custom_app_template",
  {
    id: text("id").primaryKey(), // "capp_..."
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** The template's own id — its catalog slug within this org. */
    appId: text("app_id").notNull(),
    /** The validated AppTemplate JSON (verified/available forced by the service). */
    template: jsonb("template").$type<AppTemplate>().notNull(),
    createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    // One custom app per (org, appId) — re-upload upserts.
    uniqueIndex("uq_custom_app_template_org_app").on(t.organizationId, t.appId),
    index("idx_custom_app_template_org").on(t.organizationId),
  ],
);
