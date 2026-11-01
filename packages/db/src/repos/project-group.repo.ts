import { eq, and, isNull, desc, sql } from "drizzle-orm";
import { generateId } from "@repo/core";
import type { Database } from "../client";
import { project, projectGroup } from "../schema";
import { member } from "../schema/organization";
import { withProjectConfigurationWrite } from "./project-work-admission";

export type ProjectGroup = typeof projectGroup.$inferSelect;
export type NewProjectGroup = typeof projectGroup.$inferInsert;

export function createProjectGroupRepo(db: Database) {
  return {
    async findById(id: string) {
      return db.query.projectGroup.findFirst({
        where: and(eq(projectGroup.id, id), isNull(projectGroup.deletedAt)),
      });
    },

    /** Slug uniqueness scoped to one org. */
    async findBySlugInOrg(organizationId: string, slug: string) {
      return db.query.projectGroup.findFirst({
        where: and(
          eq(projectGroup.organizationId, organizationId),
          eq(projectGroup.slug, slug),
          isNull(projectGroup.deletedAt),
        ),
      });
    },

    /**
     * Find a project_app by slug without scoping to a user. Use ONLY for
     * deterministic, globally-unique slugs (e.g. `webmail-<serverId>`),
     * never for user-facing slugs where cross-user collisions are
     * expected. Caller is responsible for verifying org membership after
     * the lookup (via assertResourceInOrg).
     */
    async findFirstBySlug(slug: string) {
      return db.query.projectGroup.findFirst({
        where: and(eq(projectGroup.slug, slug), isNull(projectGroup.deletedAt)),
      });
    },

    // listByUser removed — use listByOrganization. project_app.user_id
    // is gone; access is org-only.

    /** Org-scoped list. */
    async listByOrganization(
      organizationId: string,
      opts?: { page?: number; perPage?: number },
    ) {
      const page = opts?.page ?? 1;
      const perPage = opts?.perPage ?? 20;
      const offset = (page - 1) * perPage;

      const rows = await db.query.projectGroup.findMany({
        where: and(
          eq(projectGroup.organizationId, organizationId),
          isNull(projectGroup.deletedAt),
        ),
        orderBy: [desc(projectGroup.createdAt)],
        limit: perPage,
        offset,
      });

      const [{ value: total }] = await db
        .select({ value: sql<number>`count(*)` })
        .from(projectGroup)
        .where(
          and(eq(projectGroup.organizationId, organizationId), isNull(projectGroup.deletedAt)),
        );

      return { rows, total: Number(total), page, perPage };
    },

    async create(data: Omit<NewProjectGroup, "id">) {
      const id = generateId("app");
      const row = { id, ...data };
      await db.insert(projectGroup).values(row);
      return { ...row, createdAt: new Date(), updatedAt: new Date() } as ProjectGroup;
    },

    async update(id: string, data: Partial<NewProjectGroup>) {
      await withProjectConfigurationWrite(db, eq(project.groupId, id), async (tx) => tx
        .update(projectGroup)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(projectGroup.id, id)));
    },

    async softDelete(id: string) {
      await withProjectConfigurationWrite(db, eq(project.groupId, id), async (tx) => tx
        .update(projectGroup)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(projectGroup.id, id)));
    },
  };
}
