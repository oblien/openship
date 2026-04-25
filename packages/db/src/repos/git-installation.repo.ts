import { eq, and } from "drizzle-orm";
import { randomUUID } from "crypto";
import type { Database } from "../client";
import { gitInstallation } from "../schema";

// ─── Types ───────────────────────────────────────────────────────────────────

export type GitInstallation = typeof gitInstallation.$inferSelect;
export type NewGitInstallation = typeof gitInstallation.$inferInsert;

// ─── Repository ──────────────────────────────────────────────────────────────

export function createGitInstallationRepo(db: Database) {
  return {
    /** Find installation by user + owner */
    async findByOwner(userId: string, owner: string) {
      return db.query.gitInstallation.findFirst({
        where: and(
          eq(gitInstallation.userId, userId),
          eq(gitInstallation.provider, "github"),
          eq(gitInstallation.owner, owner.toLowerCase()),
        ),
      });
    },

    /** Find all installations for a user */
    async listByUser(userId: string) {
      return db.query.gitInstallation.findMany({
        where: and(
          eq(gitInstallation.userId, userId),
          eq(gitInstallation.provider, "github"),
        ),
      });
    },

    /** Upsert installation (create or update installation_id) */
    async upsert(data: Omit<NewGitInstallation, "id">) {
      const existing = await this.findByOwner(data.userId, data.owner);

      if (existing) {
        await db
          .update(gitInstallation)
          .set({
            installationId: data.installationId,
            updatedAt: new Date(),
          })
          .where(eq(gitInstallation.id, existing.id));
        return { ...existing, installationId: data.installationId };
      }

      const id = randomUUID();
      const row = { id, ...data, owner: data.owner.toLowerCase() };
      await db.insert(gitInstallation).values(row);
      return { ...row, createdAt: new Date(), updatedAt: new Date() };
    },

    /** Replace all GitHub App installations for a user with a fresh snapshot */
    async replaceForUser(userId: string, data: Array<Omit<NewGitInstallation, "id" | "userId" | "provider">>) {
      const rows = data.map((installation) => ({
        id: randomUUID(),
        userId,
        provider: "github",
        ...installation,
        owner: installation.owner.toLowerCase(),
      }));

      const replace = async (tx: Database) => {
        await tx
          .delete(gitInstallation)
          .where(
            and(
              eq(gitInstallation.userId, userId),
              eq(gitInstallation.provider, "github"),
            ),
          );

        if (rows.length > 0) {
          await tx.insert(gitInstallation).values(rows);
        }
      };

      await db.transaction(replace);
    },

    /** Remove installation by user + owner */
    async removeByOwner(userId: string, owner: string) {
      return db
        .delete(gitInstallation)
        .where(
          and(
            eq(gitInstallation.userId, userId),
            eq(gitInstallation.provider, "github"),
            eq(gitInstallation.owner, owner.toLowerCase()),
          ),
        );
    },

    /** Remove installation by installation_id */
    async removeByInstallationId(userId: string, installationId: number) {
      return db
        .delete(gitInstallation)
        .where(
          and(
            eq(gitInstallation.userId, userId),
            eq(gitInstallation.provider, "github"),
            eq(gitInstallation.installationId, installationId),
          ),
        );
    },

    /** Remove all GitHub installations for a user */
    async removeAllForUser(userId: string) {
      return db
        .delete(gitInstallation)
        .where(
          and(
            eq(gitInstallation.userId, userId),
            eq(gitInstallation.provider, "github"),
          ),
        );
    },
  };
}
