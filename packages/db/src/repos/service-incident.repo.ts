import { and, desc, eq, isNull, isNotNull, lt, lte, sql, inArray, or, ne, notExists } from "drizzle-orm";
import { generateId } from "@repo/core";
import type { Database } from "../client";
import { serviceIncident, project, deployment, service, serviceDeployment, type IncidentKind } from "../schema";

// ─── Types ───────────────────────────────────────────────────────────────────

export type ServiceIncident = typeof serviceIncident.$inferSelect;
export type NewServiceIncident = typeof serviceIncident.$inferInsert;

/** Severity order — an incident escalates upward and re-notifies, never downward. */
const SEVERITY: Record<IncidentKind, number> = {
  unhealthy: 1,
  crash_loop: 2,
  down: 3,
  server_unreachable: 3,
};

export function incidentSeverity(kind: IncidentKind): number {
  return SEVERITY[kind] ?? 0;
}

// ─── Repository ──────────────────────────────────────────────────────────────

export function createServiceIncidentRepo(db: Database) {
  return {
    /** The open incident for one workload, if any. */
    async findOpen(projectId: string, serviceKey: string): Promise<ServiceIncident | undefined> {
      return db.query.serviceIncident.findFirst({
        where: and(
          eq(serviceIncident.projectId, projectId),
          eq(serviceIncident.serviceKey, serviceKey),
          eq(serviceIncident.status, "open"),
        ),
      });
    },

    /** The open SERVER-scoped incident for a box, if any (project-less by design). */
    async findOpenForServer(serverId: string): Promise<ServiceIncident | undefined> {
      return db.query.serviceIncident.findFirst({
        where: and(
          eq(serviceIncident.serverId, serverId),
          isNull(serviceIncident.projectId),
          eq(serviceIncident.status, "open"),
        ),
      });
    },

    /**
     * Every open incident, project-scoped rows only.
     *
     * The watcher loads these ONCE per tick rather than querying per workload: a
     * healthy instance then does zero further reads, and resolving an incident whose
     * project no longer appears in any container list still works.
     */
    async listOpen(): Promise<ServiceIncident[]> {
      return db.query.serviceIncident.findMany({
        where: and(eq(serviceIncident.status, "open"), isNotNull(serviceIncident.projectId)),
      });
    },

    /** Current workload incidents for an authorized project batch. One query,
     * no history cap and no runtime polling. An incident for a retired container
     * or an intentionally stopped/disabled workload is not current attention. */
    async listOpenForActiveProjects(
      scopes: ReadonlyArray<{
        id: string;
        organizationId: string;
        activeDeploymentId: string;
      }>,
    ): Promise<ServiceIncident[]> {
      if (scopes.length === 0) return [];
      const rows = await db
        .select({ incident: serviceIncident })
        .from(serviceIncident)
        .innerJoin(
          project,
          and(
            eq(project.id, serviceIncident.projectId),
            eq(project.organizationId, serviceIncident.organizationId),
          ),
        )
        .innerJoin(
          deployment,
          and(
            eq(deployment.id, project.activeDeploymentId),
            eq(deployment.projectId, project.id),
            eq(deployment.organizationId, project.organizationId),
          ),
        )
        .leftJoin(
          service,
          and(
            eq(service.id, serviceIncident.serviceId),
            eq(service.projectId, project.id),
          ),
        )
        .leftJoin(
          serviceDeployment,
          and(
            eq(serviceDeployment.serviceId, service.id),
            eq(serviceDeployment.deploymentId, deployment.id),
          ),
        )
        .where(
          and(
            eq(serviceIncident.status, "open"),
            inArray(serviceIncident.kind, ["unhealthy", "crash_loop", "down"]),
            isNull(project.disabledAt),
            isNull(project.deletedAt),
            or(
              ...scopes.map((scope) =>
                and(
                  eq(project.id, scope.id),
                  eq(project.organizationId, scope.organizationId),
                  eq(deployment.id, scope.activeDeploymentId),
                ),
              ),
            ),
            or(
              and(
                eq(serviceIncident.serviceKey, service.id),
                eq(service.enabled, true),
                sql`coalesce(${service.advanced}->>'monitoringEnabled', 'true') <> 'false'`,
                ne(serviceDeployment.status, "stopped"),
                // A live name/label match can replace the stored identity hint.
                // Accept that observation only while its release AND hint still
                // match; a new release or service replacement retires it.
                or(
                  eq(serviceIncident.containerId, serviceDeployment.containerId),
                  and(
                    eq(serviceIncident.deploymentId, deployment.id),
                    sql`${serviceIncident.trackedContainerId} is not distinct from ${serviceDeployment.containerId}`,
                  ),
                ),
              ),
              and(
                isNull(serviceIncident.serviceId),
                notExists(
                  db
                    .select({ id: service.id })
                    .from(service)
                    .where(eq(service.projectId, project.id)),
                ),
                or(
                  and(
                    eq(serviceIncident.serviceKey, "__app__"),
                    eq(serviceIncident.containerId, deployment.containerId),
                  ),
                  sql`exists (select 1 from jsonb_array_elements(case
                when jsonb_typeof(${deployment.roleContainers}) = 'array' then ${deployment.roleContainers}
                else '[]'::jsonb end) as role where
                role->>'containerId' = ${serviceIncident.containerId}
                and ${serviceIncident.serviceKey} = '__role__:' || (role->>'role') || ':' || (role->>'replica'))`,
                ),
              ),
            ),
          ),
        );
      return rows.map((row) => row.incident);
    },

    /**
     * Every incident in ONE organization — backs the global Issues feed.
     *
     * Deliberately separate from `listOpen()` above rather than parameterised: that
     * one is instance-wide across all orgs BY DESIGN (the watcher reconciles every
     * box in one tick), and quietly giving it an org filter is how a tenant-scoped
     * caller would eventually narrow the watcher's sweep.
     *
     * Includes SERVER-scoped rows (`projectId IS NULL`), which is the point — an
     * unreachable box is one incident that no project-keyed read can see.
     */
    async listByOrg(
      organizationId: string,
      opts: { status?: "open" | "resolved"; limit?: number } = {},
    ): Promise<ServiceIncident[]> {
      const conds = [eq(serviceIncident.organizationId, organizationId)];
      if (opts.status) conds.push(eq(serviceIncident.status, opts.status));
      return db.query.serviceIncident.findMany({
        where: and(...conds),
        orderBy: [desc(serviceIncident.openedAt)],
        limit: opts.limit ?? 200,
      });
    },

    /** Open incidents + recent history for one project — backs the Health tab. */
    async listForProject(projectId: string, limit = 50): Promise<ServiceIncident[]> {
      return db.query.serviceIncident.findMany({
        where: eq(serviceIncident.projectId, projectId),
        orderBy: [desc(serviceIncident.openedAt)],
        limit,
      });
    },

    /**
     * Open an incident.
     *
     * `onConflictDoNothing` + a re-read rather than a plain insert: the partial unique
     * index is what guarantees one open incident per workload, and two overlapping
     * ticks (a manual Run now landing on a cron tick) must not both insert and
     * double-notify. A null return means somebody else already opened it — the caller
     * treats that as "not mine to notify about".
     */
    async open(
      data: Omit<NewServiceIncident, "id" | "status">,
    ): Promise<ServiceIncident | undefined> {
      const [row] = await db
        .insert(serviceIncident)
        .values({ ...data, id: generateId("inc"), status: "open" })
        .onConflictDoNothing()
        .returning();
      return row;
    },

    /**
     * Refresh an open incident's observation without changing its kind — the
     * every-tick write for a still-broken workload. Never touches notify bookkeeping,
     * which is what keeps a multi-hour outage at one notification.
     *
     * One call IS one observation, so `confirmations` is incremented in the statement
     * rather than set from a number the caller read: two control-plane processes on one
     * database (or a manual "Run now" landing on a cron tick) both compute the same next
     * value off the same snapshot, and one of the two observations silently vanishes.
     * Guarded on `open` for the same reason `resolve` is — a closed incident is not
     * still being observed.
     */
    async touch(
      id: string,
      patch: Partial<
        Pick<
          ServiceIncident,
          | "containerId"
          | "deploymentId"
          | "trackedContainerId"
          | "reason"
          | "exitCode"
          | "restartCount"
          | "oomKilled"
        >
      > = {},
    ): Promise<void> {
      await db
        .update(serviceIncident)
        .set({
          ...patch,
          confirmations: sql`${serviceIncident.confirmations} + 1`,
          lastSeenAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(serviceIncident.id, id), eq(serviceIncident.status, "open")));
    },

    /**
     * Promote an open incident to a worse kind (unhealthy → crash_loop → down).
     *
     * Compare-and-set on the kind the caller decided against, reporting whether the
     * update landed — the same discipline as `resolve`, for the same reason: escalation
     * notifies, and an unconditional UPDATE lets two processes both "promote" the one
     * transition and page for it twice. Losing that race isn't an error; it means the
     * operator has already been told.
     */
    async escalate(
      id: string,
      from: IncidentKind,
      to: IncidentKind,
      patch: Partial<
        Pick<
          ServiceIncident,
          | "reason"
          | "exitCode"
          | "restartCount"
          | "oomKilled"
          | "logExcerpt"
          | "containerId"
          | "deploymentId"
          | "trackedContainerId"
        >
      > = {},
    ): Promise<boolean> {
      const rows = await db
        .update(serviceIncident)
        .set({ ...patch, kind: to, lastSeenAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(serviceIncident.id, id),
            eq(serviceIncident.status, "open"),
            eq(serviceIncident.kind, from),
          ),
        )
        .returning();
      return rows.length > 0;
    },

    /**
     * Close an incident.
     *
     * Guarded on `status = 'open'` so a concurrent resolve can't fire two recovery
     * notifications: the caller notifies only when this reports a row was updated.
     */
    async resolve(id: string, at = new Date()): Promise<boolean> {
      const rows = await db
        .update(serviceIncident)
        .set({ status: "resolved", resolvedAt: at, lastSeenAt: at, updatedAt: at })
        .where(and(eq(serviceIncident.id, id), eq(serviceIncident.status, "open")))
        .returning();
      return rows.length > 0;
    },

    /** Record that a notification went out for this incident's current state. */
    async markNotified(id: string): Promise<void> {
      await db
        .update(serviceIncident)
        .set({
          notifyCount: sql`${serviceIncident.notifyCount} + 1`,
          notifiedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(serviceIncident.id, id));
    },

    /** Clear only this organization's resolved history observed before the cutoff. */
    async clearResolvedByOrg(organizationId: string, cutoff: Date): Promise<number> {
      const rows = await db
        .delete(serviceIncident)
        .where(and(
          eq(serviceIncident.organizationId, organizationId),
          eq(serviceIncident.status, "resolved"),
          lte(serviceIncident.resolvedAt, cutoff),
        ))
        .returning();
      return rows.length;
    },

    /** Retention: drop resolved history past the cutoff. Open rows are never pruned. */
    async deleteResolvedOlderThan(cutoff: Date): Promise<number> {
      const rows = await db
        .delete(serviceIncident)
        .where(and(eq(serviceIncident.status, "resolved"), lt(serviceIncident.resolvedAt, cutoff)))
        .returning();
      return rows.length;
    },
  };
}
