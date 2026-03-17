import { eq } from "drizzle-orm";
import type { Database } from "../client";
import { userSettings } from "../schema";

// ─── Types ───────────────────────────────────────────────────────────────────

export type UserSettings = typeof userSettings.$inferSelect;
export type NewUserSettings = typeof userSettings.$inferInsert;

// ─── Repository ──────────────────────────────────────────────────────────────

export function createSettingsRepo(db: Database) {
  return {
    /** Get settings for a user (returns undefined if no row yet) */
    async findByUser(userId: string): Promise<UserSettings | undefined> {
      return db.query.userSettings.findFirst({
        where: eq(userSettings.userId, userId),
      });
    },

    /** Create or update (upsert) settings for a user */
    async upsert(data: NewUserSettings): Promise<UserSettings> {
      const [row] = await db
        .insert(userSettings)
        .values(data)
        .onConflictDoUpdate({
          target: userSettings.userId,
          set: {
            buildMode: data.buildMode,
            cloudSessionToken: data.cloudSessionToken,
            updatedAt: new Date(),
          },
        })
        .returning();
      return row;
    },

    /** Update a subset of settings fields */
    async update(
      userId: string,
      data: Partial<Omit<NewUserSettings, "id" | "userId" | "createdAt">>,
    ): Promise<UserSettings | undefined> {
      const [row] = await db
        .update(userSettings)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(userSettings.userId, userId))
        .returning();
      return row;
    },
  };
}
