import { and, eq, isNotNull, sql } from "drizzle-orm";
import { generateId } from "@repo/core";
import type { Database } from "../client";
import { userSettings, member } from "../schema";

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

    /** Rotate/disconnect repository authorization without overwriting preferences. */
    async setGitHubAuthorization(userId: string, encrypted: string): Promise<void> {
      await db.insert(userSettings).values({ id: generateId(), userId, githubAuthorizationEncrypted: encrypted })
        .onConflictDoUpdate({ target: userSettings.userId, set: {
          githubAuthorizationEncrypted: encrypted, updatedAt: new Date(),
        } });
    },

    async setCloudSession(userId: string, encrypted: string): Promise<void> {
      await db.insert(userSettings).values({ id: generateId(), userId, cloudSessionToken: encrypted })
        .onConflictDoUpdate({ target: userSettings.userId, set: {
          cloudSessionToken: encrypted, updatedAt: new Date(),
        } });
    },

    /** An expired in-flight request must not erase a newly connected session. */
    async clearCloudSession(userId: string, encrypted: string): Promise<void> {
      await db.update(userSettings).set({ cloudSessionToken: null, updatedAt: new Date() })
        .where(and(eq(userSettings.userId, userId), eq(userSettings.cloudSessionToken, encrypted)));
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
            defaultDeployTarget: data.defaultDeployTarget,
            defaultServerId: data.defaultServerId,
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

    /**
     * Return the cloud-linked settings row for the org owner.
     *
     * Only the owner role can connect Openship Cloud — their token IS
     * the org's cloud identity. Every org-scoped cloud operation
     * (edge proxy, analytics, pages, GitHub App tokens) flows through
     * this single bearer. Returns undefined if the owner hasn't linked
     * yet, or if the org has no owner.
     */
    async findOrgOwnerCloudLink(
      organizationId: string,
    ): Promise<UserSettings | undefined> {
      const rows = await db
        .select({ settings: userSettings })
        .from(userSettings)
        .innerJoin(member, eq(member.userId, userSettings.userId))
        .where(
          and(
            eq(member.organizationId, organizationId),
            eq(member.role, "owner"),
            isNotNull(userSettings.cloudSessionToken),
            sql`length(${userSettings.cloudSessionToken}) > 0`,
          ),
        )
        .limit(1);
      return rows[0]?.settings;
    },

    /**
     * All org ids whose owner has linked Openship Cloud. Same join/filter as
     * findOrgOwnerCloudLink, minus the org scope — used to route an org-less
     * inbound webhook to the cloud-linked org that owns the pushed repo.
     */
    async listCloudLinkedOrgIds(): Promise<string[]> {
      const rows = await db
        .select({ organizationId: member.organizationId })
        .from(userSettings)
        .innerJoin(member, eq(member.userId, userSettings.userId))
        .where(
          and(
            eq(member.role, "owner"),
            isNotNull(userSettings.cloudSessionToken),
            sql`length(${userSettings.cloudSessionToken}) > 0`,
          ),
        )
        .groupBy(member.organizationId);
      return rows.map((r) => r.organizationId);
    },
  };
}
