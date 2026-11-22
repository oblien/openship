import { and, eq, inArray } from "drizzle-orm";
import { type GitRepositoryRef, generateId } from "@repo/core";
import type { Database } from "../client";
import { cloudWebhookBinding } from "../schema";

// ─── Types ───────────────────────────────────────────────────────────────────

export type CloudWebhookBinding = typeof cloudWebhookBinding.$inferSelect;
export type NewCloudWebhookBinding = typeof cloudWebhookBinding.$inferInsert;

// ─── Repository ──────────────────────────────────────────────────────────────

export function createCloudWebhookBindingRepo(db: Database) {
  return {
    /**
     * Bindings for a git repo (lowercased owner/repo). Returns an array — a
     * repo can have several environment branches bound. Caller picks the row
     * whose `gitBranch` is "" (default) or matches the pushed branch.
     */
    async findByRepo(ref: GitRepositoryRef, organizationIds?: readonly string[]) {
      const conditions = [
        eq(cloudWebhookBinding.gitProvider, ref.provider),
        eq(cloudWebhookBinding.gitOwner, ref.namespace.toLowerCase()),
        eq(cloudWebhookBinding.gitRepo, ref.name.toLowerCase()),
      ];
      if (organizationIds) conditions.push(inArray(cloudWebhookBinding.organizationId, [...organizationIds]));
      return db.query.cloudWebhookBinding.findMany({
        where: and(...conditions),
      });
    },

    /** Create or update a binding, keyed on (gitOwner, gitRepo, gitBranch). */
    async upsert(
      data: Omit<NewCloudWebhookBinding, "id" | "createdAt" | "updatedAt"> & {
        id?: string;
      },
    ): Promise<CloudWebhookBinding> {
      const [row] = await db
        .insert(cloudWebhookBinding)
        .values({
          id: data.id ?? generateId("cwb"),
          ...data,
          gitOwner: data.gitOwner.toLowerCase(),
          gitRepo: data.gitRepo.toLowerCase(),
        })
        .onConflictDoUpdate({
          target: [
            cloudWebhookBinding.organizationId,
            cloudWebhookBinding.gitProvider,
            cloudWebhookBinding.gitOwner,
            cloudWebhookBinding.gitRepo,
            cloudWebhookBinding.gitBranch,
          ],
          set: {
            organizationId: data.organizationId,
            cloudProjectId: data.cloudProjectId,
            webhookId: data.webhookId,
            webhookSecret: data.webhookSecret,
            updatedAt: new Date(),
          },
        })
        .returning();
      return row;
    },

    async deleteByCloudProject(cloudProjectId: string): Promise<void> {
      await db
        .delete(cloudWebhookBinding)
        .where(eq(cloudWebhookBinding.cloudProjectId, cloudProjectId));
    },
  };
}
