import { eq, and, desc, inArray, isNotNull, lte } from "drizzle-orm";
import { generateId } from "@repo/core";
import type { Database } from "../client";
import { serviceDeployment, service } from "../schema";

// ─── Types ───────────────────────────────────────────────────────────────────

export type ServiceDeployment = typeof serviceDeployment.$inferSelect;
export type NewServiceDeployment = typeof serviceDeployment.$inferInsert;

/** Status values recognized by the smart per-service deploy path. */
export type ServiceDeploymentStatus =
  | "pending"
  | "building"
  | "deploying"
  | "in_progress"
  | "success"
  | "failure"
  | "skipped"
  | "cancelled"
  /** Container started but the connection dropped before we could confirm —
   *  awaiting reconciliation. */
  | "indeterminate"
  /** The container is gone on the host (deleted out-of-band) — drift. */
  | "missing";

// ─── Repository ──────────────────────────────────────────────────────────────

/**
 * Per-service deployment access.
 *
 * Sister of `createServiceRepo` — they touch the same table but
 * separating the per-service-deploy concerns from the service-CRUD
 * concerns keeps the surface focused. The build pipeline imports
 * this repo; the dashboard service-list controller imports
 * `createServiceRepo`.
 */
export function createServiceDeploymentRepo(db: Database) {
  return {
    async findById(id: string) {
      return db.query.serviceDeployment.findFirst({
        where: eq(serviceDeployment.id, id),
      });
    },

    /** Single insert. Returns the inserted row with timestamps populated. */
    async create(data: Omit<NewServiceDeployment, "id">) {
      const id = generateId("sd");
      const row = { id, ...data };
      await db.insert(serviceDeployment).values(row);
      return {
        ...row,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as ServiceDeployment;
    },

    /**
     * Bulk fan-out used by the smart deploy path at the start of a
     * project deployment. Inserts one row per service in a single
     * round trip. Falls through to a no-op when the input is empty
     * so callers don't have to guard.
     */
    async bulkCreate(
      rows: Omit<NewServiceDeployment, "id">[],
    ): Promise<ServiceDeployment[]> {
      if (rows.length === 0) return [];
      const withIds = rows.map((r) => ({ id: generateId("sd"), ...r }));
      await db.insert(serviceDeployment).values(withIds);
      const now = new Date();
      return withIds.map(
        (r) => ({ ...r, createdAt: now, updatedAt: now }) as ServiceDeployment,
      );
    },

    /**
     * Patch status (and optional supporting fields) on one row.
     * Designed for the build pipeline to flip a service from
     * pending → building → success | failure | skipped without
     * thinking about which other columns to clear.
     */
    async updateStatus(
      id: string,
      status: ServiceDeploymentStatus,
      extra?: Partial<NewServiceDeployment>,
    ) {
      await db
        .update(serviceDeployment)
        .set({ status, ...extra, updatedAt: new Date() })
        .where(eq(serviceDeployment.id, id));
    },

    /** Generic patch used by the deploy worker when it has more than just `status` to set. */
    async update(id: string, data: Partial<NewServiceDeployment>) {
      await db
        .update(serviceDeployment)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(serviceDeployment.id, id));
    },

    async listByDeployment(deploymentId: string) {
      return db.query.serviceDeployment.findMany({
        where: eq(serviceDeployment.deploymentId, deploymentId),
      });
    },

    /**
     * Reverse lookup from a GitHub check_run.id back to the
     * service_deployment row. Used by the webhook handler when a user
     * hits "re-run this check" on GitHub — we need to find which
     * deployment + service the rerun targets.
     */
    async findByCheckRunId(checkRunId: number) {
      return db.query.serviceDeployment.findFirst({
        where: eq(serviceDeployment.checkRunId, checkRunId),
      });
    },

    /**
     * Batch variant of listByDeployment — one round trip for N
     * deployments. Used by the dashboard's deployment-list view to
     * avoid an N+1 when rendering per-service status pills.
     */
    async listByDeployments(
      deploymentIds: string[],
    ): Promise<Map<string, ServiceDeployment[]>> {
      const out = new Map<string, ServiceDeployment[]>();
      if (deploymentIds.length === 0) return out;
      const rows = await db.query.serviceDeployment.findMany({
        where: inArray(serviceDeployment.deploymentId, deploymentIds),
      });
      for (const id of deploymentIds) out.set(id, []);
      for (const row of rows) {
        const list = out.get(row.deploymentId);
        if (list) list.push(row);
      }
      return out;
    },

    async listByService(serviceId: string) {
      return db.query.serviceDeployment.findMany({
        where: eq(serviceDeployment.serviceId, serviceId),
        orderBy: [desc(serviceDeployment.createdAt)],
      });
    },

    /**
     * The image each service was ACTUALLY running as of `deploymentId` — the
     * newest row at-or-before it that recorded one.
     *
     * A deploy only rebuilds what changed: an untouched service carries its
     * previous image forward, and a smart-deploy `skipped` row can record no
     * image at all. So "what was service X running in that release?" is not
     * always answerable from that release's own rows — it's the last row that
     * named an image, walking backwards. This is what lets a rollback reuse the
     * images that are ALREADY on the host for the services a deploy never
     * touched, instead of rebuilding the whole stack.
     *
     * Returns serviceId → { imageRef, serviceName }, newest-wins.
     */
    async effectiveImagesAsOf(
      projectId: string,
      createdAtOrBefore: Date,
    ): Promise<Map<string, { imageRef: string; serviceName: string | null }>> {
      const rows = await db
        .select({ sd: serviceDeployment })
        .from(serviceDeployment)
        .innerJoin(service, eq(service.id, serviceDeployment.serviceId))
        .where(
          and(
            eq(service.projectId, projectId),
            isNotNull(serviceDeployment.imageRef),
            lte(serviceDeployment.createdAt, createdAtOrBefore),
          ),
        )
        .orderBy(desc(serviceDeployment.createdAt));

      const out = new Map<string, { imageRef: string; serviceName: string | null }>();
      for (const { sd } of rows) {
        if (out.has(sd.serviceId) || !sd.imageRef) continue;
        out.set(sd.serviceId, { imageRef: sd.imageRef, serviceName: sd.serviceName });
      }
      return out;
    },

    /** Hard delete; cascades from the parent deployment row in normal flow. */
    async remove(id: string) {
      await db.delete(serviceDeployment).where(eq(serviceDeployment.id, id));
    },

    /**
     * Quick lookup used by the dashboard service row: "what was the
     * last per-service deploy status across all services in this
     * project?". One round trip; collapses by service in JS.
     */
    async latestByProject(projectId: string): Promise<Map<string, ServiceDeployment>> {
      // Pull through service.projectId — service_deployment doesn't
      // carry the project_id directly.
      const rows = await db
        .select({ sd: serviceDeployment })
        .from(serviceDeployment)
        .innerJoin(service, eq(service.id, serviceDeployment.serviceId))
        .where(eq(service.projectId, projectId))
        .orderBy(desc(serviceDeployment.createdAt));
      const out = new Map<string, ServiceDeployment>();
      for (const { sd } of rows) {
        if (!out.has(sd.serviceId)) out.set(sd.serviceId, sd);
      }
      return out;
    },
  };
}
