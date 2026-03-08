import { eq, and, desc, sql } from "drizzle-orm";
import { generateId } from "@repo/core";
import type { Database } from "../client";
import { deployment, buildSession } from "../schema";

// ─── Types ───────────────────────────────────────────────────────────────────

export type Deployment = typeof deployment.$inferSelect;
export type NewDeployment = typeof deployment.$inferInsert;
export type BuildSession = typeof buildSession.$inferSelect;
export type NewBuildSession = typeof buildSession.$inferInsert;

// ─── Repository ──────────────────────────────────────────────────────────────

export function createDeploymentRepo(db: Database) {
  return {
    // ── Deployments ────────────────────────────────────────────────────

    async findById(id: string) {
      return db.query.deployment.findFirst({
        where: eq(deployment.id, id),
      });
    },

    async listByProject(
      projectId: string,
      opts?: { page?: number; perPage?: number; environment?: string },
    ) {
      const page = opts?.page ?? 1;
      const perPage = opts?.perPage ?? 20;
      const offset = (page - 1) * perPage;

      const conditions = [eq(deployment.projectId, projectId)];
      if (opts?.environment) {
        conditions.push(eq(deployment.environment, opts.environment));
      }

      const rows = await db.query.deployment.findMany({
        where: and(...conditions),
        orderBy: [desc(deployment.createdAt)],
        limit: perPage,
        offset,
      });

      const [{ value: total }] = await db
        .select({ value: sql<number>`count(*)` })
        .from(deployment)
        .where(and(...conditions));

      return { rows, total: Number(total), page, perPage };
    },

    async create(data: Omit<NewDeployment, "id">) {
      const id = generateId("dep");
      const row = { id, ...data };
      await db.insert(deployment).values(row);
      return { ...row, createdAt: new Date(), updatedAt: new Date() } as Deployment;
    },

    async updateStatus(id: string, status: string, extra?: Partial<NewDeployment>) {
      await db
        .update(deployment)
        .set({ status, ...extra, updatedAt: new Date() })
        .where(eq(deployment.id, id));
    },

    async setContainerId(id: string, containerId: string, url?: string) {
      await db
        .update(deployment)
        .set({ containerId, url, updatedAt: new Date() })
        .where(eq(deployment.id, id));
    },

    /** Find the most recent successful deployment for rollback */
    async findLatestReady(projectId: string, environment: string) {
      return db.query.deployment.findFirst({
        where: and(
          eq(deployment.projectId, projectId),
          eq(deployment.environment, environment),
          eq(deployment.status, "ready"),
        ),
        orderBy: [desc(deployment.createdAt)],
      });
    },

    // ── Build sessions ─────────────────────────────────────────────────

    async createBuildSession(data: Omit<NewBuildSession, "id">) {
      const id = generateId("bld");
      const row = { id, ...data };
      await db.insert(buildSession).values(row);
      return { ...row, createdAt: new Date() } as BuildSession;
    },

    async findBuildSession(id: string) {
      return db.query.buildSession.findFirst({
        where: eq(buildSession.id, id),
      });
    },

    async updateBuildSession(id: string, data: Partial<NewBuildSession>) {
      await db
        .update(buildSession)
        .set(data)
        .where(eq(buildSession.id, id));
    },

    async finishBuildSession(id: string, status: string, durationMs: number, logs?: unknown[]) {
      await db
        .update(buildSession)
        .set({
          status,
          durationMs,
          logs: logs as never,
          finishedAt: new Date(),
        })
        .where(eq(buildSession.id, id));
    },
  };
}
