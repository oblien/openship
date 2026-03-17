import { eq } from "drizzle-orm";
import type { Database } from "../client";
import { instanceSettings } from "../schema";

// ─── Types ───────────────────────────────────────────────────────────────────

export type InstanceSettings = typeof instanceSettings.$inferSelect;
export type NewInstanceSettings = typeof instanceSettings.$inferInsert;

// ─── Repository ──────────────────────────────────────────────────────────────

const DEFAULT_ID = "default";

export function createInstanceSettingsRepo(db: Database) {
  return {
    /** Get the singleton instance settings row */
    async get(): Promise<InstanceSettings | undefined> {
      return db.query.instanceSettings.findFirst({
        where: eq(instanceSettings.id, DEFAULT_ID),
      });
    },

    /** Create or update instance settings (upsert on the single row) */
    async upsert(
      data: Omit<NewInstanceSettings, "id" | "createdAt">,
    ): Promise<InstanceSettings> {
      const [row] = await db
        .insert(instanceSettings)
        .values({ id: DEFAULT_ID, ...data })
        .onConflictDoUpdate({
          target: instanceSettings.id,
          set: { ...data, updatedAt: new Date() },
        })
        .returning();
      return row;
    },

    /** Delete the singleton instance settings row (removes server) */
    async delete(): Promise<void> {
      await db.delete(instanceSettings).where(eq(instanceSettings.id, DEFAULT_ID));
    },
  };
}
