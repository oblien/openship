import { and, eq, gt, inArray, isNull, lte, ne, or, sql, type SQL } from "drizzle-orm";
import {
  AppError,
  NotFoundError,
  CLUSTER_RUNTIME_LEASE_MS,
  CLUSTER_RUNTIME_STEPS,
  clusterRuntimeRunning,
  validateClusterWorkload,
  type ClusterRuntimePlan,
} from "@repo/core";
import type { Database } from "../client";
import {
  clusterRuntime as table,
  clusterStorage,
  clusterDatabase,
  computeCluster,
  serverCluster,
  project,
} from "../schema";

export type ClusterRuntimeRecord = typeof table.$inferSelect;
const conflict = (message: string) => new AppError(message, 409, "CLUSTER_RUNTIME_CONFLICT");
const running = ["setting_up", "removing"] as const;

export function createClusterRuntimeRepo(db: Database) {
  const owned = (org: string, clusterId: string) =>
    and(eq(table.organizationId, org), eq(table.clusterId, clusterId));
  const worker = (id: string, generation: number) =>
    and(
      eq(table.id, id),
      eq(table.generation, generation),
      inArray(table.status, [...running]),
      gt(table.leaseExpiresAt, new Date()),
    );
  const expired = () => or(isNull(table.leaseExpiresAt), lte(table.leaseExpiresAt, new Date()));
  async function interrupt(condition: SQL | undefined, message: string) {
    return db
      .update(table)
      .set({
        status: "interrupted",
        leaseExpiresAt: null,
        error: message,
        sequence: sql`${table.sequence} + 1`,
        updatedAt: new Date(),
      })
      .where(and(inArray(table.status, [...running]), condition))
      .returning();
  }
  async function expire(org: string) {
    await interrupt(
      and(eq(table.organizationId, org), expired()),
      "OpenShip stopped reporting setup progress. Retry to inspect the saved installation and continue.",
    );
  }
  async function get(org: string, clusterId: string) {
    await expire(org);
    const [row] = await db.select().from(table).where(owned(org, clusterId));
    return row ?? null;
  }
  return {
    get,
    async bindProject(
      org: string,
      projectId: string,
      clusterId: string | null,
      config: import("@repo/core").ClusterWorkloadConfig | null,
      expectedUpdatedAt: string,
    ) {
      if (clusterId) {
        if (!config) throw conflict("Configure replicas before assigning a cluster.");
        validateClusterWorkload(config);
      } else if (config) throw conflict("Cluster configuration requires a cluster target.");
      return db.transaction(async (tx) => {
        if (clusterId) {
          const [cluster] = await tx
            .select()
            .from(computeCluster)
            .where(and(eq(computeCluster.organizationId, org), eq(computeCluster.id, clusterId)))
            .for("update");
          if (!cluster) throw new NotFoundError("Cluster", clusterId);
          const [runtime] = await tx
            .select()
            .from(table)
            .where(owned(org, clusterId))
            .for("update");
          if (!runtime || runtime.status !== "ready")
            throw conflict("Finish setting up this cluster before assigning projects.");
        }
        const [current] = await tx
          .select()
          .from(project)
          .where(and(eq(project.organizationId, org), eq(project.id, projectId)))
          .for("update");
        if (!current || current.deletionInProgress) throw new NotFoundError("Project", projectId);
        if (current.updatedAt.toISOString() !== expectedUpdatedAt)
          throw conflict("Project settings changed. Reload before applying this target.");
        if (current.workspaceId)
          throw conflict("Cloud projects cannot be assigned to self-hosted clusters.");
        if (current.clusterId !== clusterId) {
          const [database] = await tx
            .select({ id: clusterDatabase.id })
            .from(clusterDatabase)
            .where(
              and(
                eq(clusterDatabase.projectId, projectId),
                ne(clusterDatabase.status, "deleted"),
                clusterId ? ne(clusterDatabase.clusterId, clusterId) : undefined,
              ),
            )
            .limit(1);
          if (database)
            throw conflict(
              "This project still owns databases on its current cluster. Remove or migrate them before changing its target.",
            );
        }
        const [updated] = await tx
          .update(project)
          .set({
            clusterId,
            clusterConfig: config,
            ...(clusterId
              ? { serverId: null, runtimeMode: "docker", buildStrategy: "server" }
              : {}),
            updatedAt: new Date(Math.max(Date.now(), current.updatedAt.getTime() + 1)),
          })
          .where(eq(project.id, projectId))
          .returning();
        return updated!;
      });
    },
    async start(
      org: string,
      clusterId: string,
      revision: number,
      requestId: string,
      plan: ClusterRuntimePlan,
    ) {
      await expire(org);
      return db.transaction(async (tx) => {
        const [cluster] = await tx
          .select()
          .from(computeCluster)
          .where(and(eq(computeCluster.organizationId, org), eq(computeCluster.id, clusterId)))
          .for("update");
        if (!cluster) throw new NotFoundError("Cluster", clusterId);
        if (cluster.revision !== revision || cluster.networkId !== plan.networkId)
          throw conflict("The cluster changed. Reload it before starting setup.");
        const [network] = await tx
          .select()
          .from(serverCluster)
          .where(and(eq(serverCluster.organizationId, org), eq(serverCluster.id, plan.networkId)))
          .for("update");
        if (!network || network.revision !== plan.networkRevision)
          throw conflict("The private network changed. Reload the cluster before starting setup.");
        const [existing] = await tx.select().from(table).where(owned(org, clusterId)).for("update");
        if (existing && existing.status !== "removed") return { row: existing, started: false };
        if (existing) await tx.delete(table).where(eq(table.id, existing.id));
        const [row] = await tx
          .insert(table)
          .values({
            organizationId: org,
            clusterId,
            clusterRevision: revision,
            requestId,
            plan,
            status: "setting_up",
            leaseExpiresAt: new Date(Date.now() + CLUSTER_RUNTIME_LEASE_MS),
          })
          .returning();
        return { row: row!, started: true };
      });
    },
    async change(org: string, clusterId: string, sequence: number, action: "retry" | "remove") {
      await expire(org);
      return db.transaction(async (tx) => {
        // Same lock order as start and cluster membership edits.
        const [cluster] = await tx
          .select()
          .from(computeCluster)
          .where(and(eq(computeCluster.organizationId, org), eq(computeCluster.id, clusterId)))
          .for("update");
        if (!cluster) throw new NotFoundError("Cluster", clusterId);
        const [current] = await tx.select().from(table).where(owned(org, clusterId)).for("update");
        if (!current) throw new NotFoundError("Cluster runtime");
        if (action === "remove" && current.status === "removed")
          return { row: current, started: false };
        if (clusterRuntimeRunning(current.status))
          throw conflict("A cluster operation is already running. Follow its saved progress.");
        if (current.sequence !== sequence)
          throw conflict("Setup changed. Reload its progress before continuing.");
        if (action === "retry" && !["failed", "interrupted"].includes(current.status))
          throw conflict("Only a stopped or failed operation can be retried.");
        const intent = action === "remove" ? "remove" : current.intent;
        if (intent === "remove") {
          const [storage] = await tx
            .select({ id: clusterStorage.id })
            .from(clusterStorage)
            .where(
              and(eq(clusterStorage.runtimeId, current.id), ne(clusterStorage.status, "removed")),
            )
            .limit(1);
          if (storage)
            throw conflict("Remove managed storage and its volumes before disabling scaling.");
          const [database] = await tx
            .select({ id: clusterDatabase.id })
            .from(clusterDatabase)
            .where(
              and(eq(clusterDatabase.runtimeId, current.id), ne(clusterDatabase.status, "deleted")),
            )
            .limit(1);
          if (database)
            throw conflict(
              "Databases or retained database disks still belong to this cluster. Remove or migrate them before disabling scaling.",
            );
          const [bound] = await tx
            .select({ id: project.id })
            .from(project)
            .where(eq(project.clusterId, clusterId))
            .limit(1);
          if (bound)
            throw conflict(
              "Projects still target this cluster. Change their deployment target and remove their cluster workloads before removing the runtime.",
            );
        }
        const [row] = await tx
          .update(table)
          .set({
            intent,
            status: intent === "setup" ? "setting_up" : "removing",
            generation: current.generation + 1,
            sequence: current.sequence + 1,
            error: null,
            verifiedAt: null,
            leaseExpiresAt: new Date(Date.now() + CLUSTER_RUNTIME_LEASE_MS),
            updatedAt: new Date(),
          })
          .where(eq(table.id, current.id))
          .returning();
        return { row: row!, started: true };
      });
    },
    async progress(id: string, generation: number, plan: ClusterRuntimePlan) {
      const rows = await db
        .update(table)
        .set({ plan, sequence: sql`${table.sequence} + 1`, updatedAt: new Date() })
        .where(worker(id, generation))
        .returning();
      if (!rows.length) throw conflict("This worker no longer owns cluster setup.");
    },
    async active(id: string, generation: number) {
      const rows = await db.select({ id: table.id }).from(table).where(worker(id, generation));
      return rows.length === 1;
    },
    async heartbeat(id: string, generation: number) {
      const rows = await db
        .update(table)
        .set({ leaseExpiresAt: new Date(Date.now() + CLUSTER_RUNTIME_LEASE_MS) })
        .where(worker(id, generation))
        .returning();
      return rows.length === 1;
    },
    async finish(
      id: string,
      generation: number,
      plan: ClusterRuntimePlan,
      intent: "setup" | "remove",
      error: string | null,
    ) {
      const expected = intent === "setup" ? CLUSTER_RUNTIME_STEPS : ["remove"];
      if (
        !error &&
        (!plan.hosts.length ||
          plan.hosts.some(
            (host) =>
              expected.some(
                (id) => !host.steps.some((step) => step.id === id && step.status === "completed"),
              ) || (intent === "setup" ? !host.ready || !host.installed : host.installed),
          ))
      )
        throw conflict("Every server must finish verification before this operation can complete.");
      const rows = await db
        .update(table)
        .set({
          plan,
          status: error ? "failed" : intent === "setup" ? "ready" : "removed",
          error,
          verifiedAt: !error && intent === "setup" ? new Date() : null,
          leaseExpiresAt: null,
          sequence: sql`${table.sequence} + 1`,
          updatedAt: new Date(),
        })
        .where(and(worker(id, generation), eq(table.intent, intent)))
        .returning();
      return rows.length === 1;
    },
    interrupt: (id: string, generation: number, message: string) =>
      interrupt(and(eq(table.id, id), eq(table.generation, generation)), message),
    recoverInterrupted: (exclusive: boolean) =>
      interrupt(
        exclusive ? undefined : expired(),
        "OpenShip restarted before cluster setup finished. Retry to inspect the saved installation and continue.",
      ),
  };
}
