import { and, eq } from "drizzle-orm";
import { generateId, type AppTemplate } from "@repo/core";
import type { Database } from "../client";
import { customAppTemplate } from "../schema";

// ─── Types ───────────────────────────────────────────────────────────────────

export type CustomAppTemplate = typeof customAppTemplate.$inferSelect;
export type NewCustomAppTemplate = typeof customAppTemplate.$inferInsert;

// ─── Repository ──────────────────────────────────────────────────────────────

export function createCustomAppTemplateRepo(db: Database) {
  return {
    /** All custom apps for an org (merged into that org's catalog). */
    async listByOrg(organizationId: string): Promise<CustomAppTemplate[]> {
      return db.query.customAppTemplate.findMany({
        where: eq(customAppTemplate.organizationId, organizationId),
      });
    },

    /** One custom app by (org, appId) — org-isolated lookup for install/resolve. */
    async findByAppId(
      organizationId: string,
      appId: string,
    ): Promise<CustomAppTemplate | undefined> {
      return db.query.customAppTemplate.findFirst({
        where: and(
          eq(customAppTemplate.organizationId, organizationId),
          eq(customAppTemplate.appId, appId),
        ),
      });
    },

    /** Create or update the org's custom app for `appId` (re-upload = update). */
    async upsert(data: {
      organizationId: string;
      appId: string;
      template: AppTemplate;
      createdByUserId?: string | null;
    }): Promise<CustomAppTemplate> {
      const [row] = await db
        .insert(customAppTemplate)
        .values({
          id: generateId("capp"),
          organizationId: data.organizationId,
          appId: data.appId,
          template: data.template,
          createdByUserId: data.createdByUserId ?? null,
        })
        .onConflictDoUpdate({
          target: [customAppTemplate.organizationId, customAppTemplate.appId],
          set: { template: data.template, updatedAt: new Date() },
        })
        .returning();
      return row;
    },

    async deleteByAppId(organizationId: string, appId: string): Promise<void> {
      await db
        .delete(customAppTemplate)
        .where(
          and(
            eq(customAppTemplate.organizationId, organizationId),
            eq(customAppTemplate.appId, appId),
          ),
        );
    },
  };
}
