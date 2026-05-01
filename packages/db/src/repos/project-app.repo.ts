import { eq, and, isNull, desc, sql } from "drizzle-orm";
import { generateId } from "@repo/core";
import type { Database } from "../client";
import { projectApp } from "../schema";

export type ProjectApp = typeof projectApp.$inferSelect;
export type NewProjectApp = typeof projectApp.$inferInsert;

export function createProjectAppRepo(db: Database) {
  return {
    async findById(id: string) {
      return db.query.projectApp.findFirst({
        where: and(eq(projectApp.id, id), isNull(projectApp.deletedAt)),
      });
    },

    async findBySlug(userId: string, slug: string) {
      return db.query.projectApp.findFirst({
        where: and(
          eq(projectApp.userId, userId),
          eq(projectApp.slug, slug),
          isNull(projectApp.deletedAt),
        ),
      });
    },

    async listByUser(userId: string, opts?: { page?: number; perPage?: number }) {
      const page = opts?.page ?? 1;
      const perPage = opts?.perPage ?? 20;
      const offset = (page - 1) * perPage;

      const rows = await db.query.projectApp.findMany({
        where: and(eq(projectApp.userId, userId), isNull(projectApp.deletedAt)),
        orderBy: [desc(projectApp.createdAt)],
        limit: perPage,
        offset,
      });

      const [{ value: total }] = await db
        .select({ value: sql<number>`count(*)` })
        .from(projectApp)
        .where(and(eq(projectApp.userId, userId), isNull(projectApp.deletedAt)));

      return { rows, total: Number(total), page, perPage };
    },

    async create(data: Omit<NewProjectApp, "id">) {
      const id = generateId("app");
      const row = { id, ...data };
      await db.insert(projectApp).values(row);
      return { ...row, createdAt: new Date(), updatedAt: new Date() } as ProjectApp;
    },

    async update(id: string, data: Partial<NewProjectApp>) {
      await db
        .update(projectApp)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(projectApp.id, id));
    },

    async softDelete(id: string) {
      await db
        .update(projectApp)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(projectApp.id, id));
    },
  };
}
