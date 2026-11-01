import { and, eq, getTableColumns, isNotNull, sql } from "drizzle-orm";
import { generateId } from "@repo/core";
import type { Database } from "../client";
import { userSettings, member } from "../schema";

// ─── Types ───────────────────────────────────────────────────────────────────

type StoredUserSettings = typeof userSettings.$inferSelect;
export type UserSettings = Omit<StoredUserSettings, "appearance">;
// Font assets can be large. Ordinary credential/preferences reads must not load them.
const { appearance: _appearance, ...settingsColumns } = getTableColumns(userSettings);
export type NewUserSettings = typeof userSettings.$inferInsert;

// ─── Repository ──────────────────────────────────────────────────────────────

export function createSettingsRepo(db: Database) {
  return {
    /** Get settings for a user (returns undefined if no row yet) */
    async findByUser(userId: string): Promise<UserSettings | undefined> {
      return db.query.userSettings.findFirst({
        columns: { appearance: false },
        where: eq(userSettings.userId, userId),
      });
    },

    /** Read the personal library only when the caller requests appearance. */
    async getAppearance(userId: string): Promise<StoredUserSettings["appearance"]> {
      const row = await db.query.userSettings.findFirst({
        columns: { appearance: true },
        where: eq(userSettings.userId, userId),
      });
      return row?.appearance ?? null;
    },

    /** Read the language without loading account credentials or appearance assets. */
    async getLocale(userId: string): Promise<string | undefined> {
      const row = await db.query.userSettings.findFirst({
        columns: { locale: true },
        where: eq(userSettings.userId, userId),
      });
      return row?.locale;
    },

    /** Atomic personal language update; cannot overwrite credentials or other preferences. */
    async setLocale(userId: string, locale: string): Promise<void> {
      await db
        .insert(userSettings)
        .values({ id: generateId(), userId, locale })
        .onConflictDoUpdate({
          target: userSettings.userId,
          set: { locale, updatedAt: new Date() },
        });
    },

    /** Atomic partial upsert: saving a theme cannot overwrite credentials or deploy defaults. */
    async setAppearance(userId: string, appearance: NewUserSettings["appearance"]): Promise<void> {
      await db
        .insert(userSettings)
        .values({ id: generateId(), userId, appearance })
        .onConflictDoUpdate({
          target: userSettings.userId,
          set: { appearance, updatedAt: new Date() },
        });
    },

    /** Rotate/disconnect repository authorization without overwriting preferences. */
    async setGitHubAuthorization(userId: string, encrypted: string): Promise<void> {
      await db
        .insert(userSettings)
        .values({ id: generateId(), userId, githubAuthorizationEncrypted: encrypted })
        .onConflictDoUpdate({
          target: userSettings.userId,
          set: {
            githubAuthorizationEncrypted: encrypted,
            updatedAt: new Date(),
          },
        });
    },

    async setCloudSession(userId: string, encrypted: string): Promise<void> {
      await db
        .insert(userSettings)
        .values({ id: generateId(), userId, cloudSessionToken: encrypted })
        .onConflictDoUpdate({
          target: userSettings.userId,
          set: {
            cloudSessionToken: encrypted,
            updatedAt: new Date(),
          },
        });
    },

    /** An expired in-flight request must not erase a newly connected session. */
    async clearCloudSession(userId: string, encrypted: string): Promise<void> {
      await db
        .update(userSettings)
        .set({ cloudSessionToken: null, updatedAt: new Date() })
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
      const { appearance: _assets, ...settings } = row;
      return settings;
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
      if (!row) return undefined;
      const { appearance: _assets, ...settings } = row;
      return settings;
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
    async findOrgOwnerCloudLink(organizationId: string): Promise<UserSettings | undefined> {
      const rows = await db
        .select({ settings: settingsColumns })
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
