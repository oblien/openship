import { and, eq, gt, inArray, isNull, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import {
  AppError,
  CLUSTER_STORAGE_LEASE_MS,
  CLUSTER_STORAGE_STEPS,
  MANAGED_STORAGE_CLASS,
  clusterStorageRunning,
  validateClusterStorage,
  type ClusterStorageConfig,
  type ClusterStorageProgress,
  type ClusterStorageObservation,
} from "@repo/core";
import type { Database } from "../client";
import { clusterStorage as table, clusterRuntime, clusterDatabase } from "../schema";
import { lockClusterBackupDestinations } from "./cluster-backup-destination";

export type ClusterStorageRecord = typeof table.$inferSelect;
const conflict = (message: string) => new AppError(message, 409, "CLUSTER_STORAGE_CONFLICT");
export function createClusterStorageRepo(db: Database) {
  const owned = (org: string, id: string) =>
    and(eq(table.organizationId, org), eq(table.clusterId, id));
  const running = ["setting_up", "removing"] as const;
  const expired = () => or(isNull(table.leaseExpiresAt), lte(table.leaseExpiresAt, new Date()));
  const worker = (id: string, generation: number) =>
    and(
      eq(table.id, id),
      eq(table.generation, generation),
      inArray(table.status, [...running]),
      gt(table.leaseExpiresAt, new Date()),
    );
  const interrupt = (where: SQL | undefined, message: string) =>
    db
      .update(table)
      .set({
        status: "interrupted",
        error: message,
        leaseExpiresAt: null,
        sequence: sql`${table.sequence}+1`,
        updatedAt: new Date(),
      })
      .where(and(inArray(table.status, [...running]), where))
      .returning();
  const expire = (org: string) =>
    interrupt(
      and(eq(table.organizationId, org), expired()),
      "Storage setup stopped reporting progress. Retry to inspect the saved installation and continue.",
    );
  async function get(org: string, clusterId: string) {
    await expire(org);
    const [row] = await db.select().from(table).where(owned(org, clusterId));
    return row ?? null;
  }
  return {
    get,
    async start(
      input: Pick<
        ClusterStorageRecord,
        "organizationId" | "clusterId" | "runtimeId" | "requestId" | "config"
      >,
    ) {
      validateClusterStorage(input.config);
      await expire(input.organizationId);
      return db.transaction(async (tx) => {
        const [runtime] = await tx
          .select()
          .from(clusterRuntime)
          .where(
            and(
              eq(clusterRuntime.id, input.runtimeId),
              eq(clusterRuntime.organizationId, input.organizationId),
            ),
          )
          .for("update");
        if (!runtime || runtime.status !== "ready" || runtime.clusterId !== input.clusterId)
          throw conflict("Finish cluster setup before enabling storage.");
        if (
          input.config.disks.some((d) => !runtime.plan.hosts.some((h) => h.serverId === d.serverId))
        )
          throw conflict("Every storage disk must belong to this cluster.");
        const [existing] = await tx
          .select()
          .from(table)
          .where(owned(input.organizationId, input.clusterId))
          .for("update");
        if (existing && existing.status !== "removed") {
          if (
            existing.requestId === input.requestId &&
            isDeepStrictEqual(existing.config, input.config)
          )
            return { row: existing, started: false };
          throw conflict(
            "Storage already has a saved configuration. Open its progress or retry the existing operation.",
          );
        }
        await lockClusterBackupDestinations(tx, input.organizationId, [
          input.config.backupDestinationId,
        ]);
        if (existing) await tx.delete(table).where(eq(table.id, existing.id));
        const [row] = await tx
          .insert(table)
          .values({ ...input, leaseExpiresAt: new Date(Date.now() + CLUSTER_STORAGE_LEASE_MS) })
          .returning();
        return { row: row!, started: true };
      });
    },
    async change(org: string, clusterId: string, sequence: number, action: "retry" | "remove") {
      await expire(org);
      return db.transaction(async (tx) => {
        const [runtime] = await tx
          .select()
          .from(clusterRuntime)
          .where(
            and(eq(clusterRuntime.clusterId, clusterId), eq(clusterRuntime.organizationId, org)),
          )
          .for("update");
        if (!runtime || runtime.status !== "ready")
          throw conflict("The cluster runtime must remain available while managing storage.");
        const [current] = await tx.select().from(table).where(owned(org, clusterId)).for("update");
        if (!current || current.status === "removed") throw conflict("Storage is not installed.");
        if (current.sequence !== sequence || clusterStorageRunning(current.status))
          throw conflict("Storage setup changed or is still running. Refresh its progress.");
        if (action === "retry" && !["failed", "interrupted"].includes(current.status))
          throw conflict("Only failed or interrupted operations can be retried.");
        const intent = action === "remove" ? "remove" : current.intent;
        if (intent === "remove") {
          const [database] = await tx
            .select({ id: clusterDatabase.id })
            .from(clusterDatabase)
            .where(
              and(
                eq(clusterDatabase.runtimeId, current.runtimeId),
                ne(clusterDatabase.status, "deleted"),
                sql`${clusterDatabase.config}->>'storageClass' = ${MANAGED_STORAGE_CLASS}`,
              ),
            )
            .limit(1);
          if (database)
            throw conflict(
              "A database still uses this storage. Move or explicitly delete its data before removing shared storage.",
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
            leaseExpiresAt: new Date(Date.now() + CLUSTER_STORAGE_LEASE_MS),
            updatedAt: new Date(),
          })
          .where(eq(table.id, current.id))
          .returning();
        return row!;
      });
    },
    async active(id: string, generation: number) {
      return (
        (await db.select({ id: table.id }).from(table).where(worker(id, generation))).length === 1
      );
    },
    async configureBackup(org: string, clusterId: string, sequence: number, destinationId: string) {
      return db.transaction(async (tx) => {
        const [current] = await tx.select().from(table).where(owned(org, clusterId)).for("update");
        if (!current || current.status !== "ready" || current.sequence !== sequence)
          throw conflict("Storage changed. Refresh before configuring backups.");
        if (
          current.config.backupDestinationId &&
          current.config.backupDestinationId !== destinationId
        )
          throw conflict(
            "Keep the existing backup destination so saved volume backups remain recoverable.",
          );
        await lockClusterBackupDestinations(tx, org, [destinationId]);
        const [row] = await tx
          .update(table)
          .set({
            config: { ...current.config, backupDestinationId: destinationId },
            intent: "setup",
            status: "setting_up",
            generation: current.generation + 1,
            sequence: current.sequence + 1,
            error: null,
            leaseExpiresAt: new Date(Date.now() + CLUSTER_STORAGE_LEASE_MS),
            updatedAt: new Date(),
          })
          .where(eq(table.id, current.id))
          .returning();
        return row!;
      });
    },
    async heartbeat(id: string, generation: number) {
      return (
        (
          await db
            .update(table)
            .set({ leaseExpiresAt: new Date(Date.now() + CLUSTER_STORAGE_LEASE_MS) })
            .where(worker(id, generation))
            .returning()
        ).length === 1
      );
    },
    async progress(id: string, generation: number, progress: ClusterStorageProgress) {
      if (
        !(
          await db
            .update(table)
            .set({ progress, sequence: sql`${table.sequence}+1`, updatedAt: new Date() })
            .where(worker(id, generation))
            .returning()
        ).length
      )
        throw conflict("This worker no longer owns storage setup.");
    },
    async finish(
      id: string,
      generation: number,
      progress: ClusterStorageProgress,
      observation: ClusterStorageObservation | null,
      error: string | null,
    ) {
      if (!error) {
        const [row] = await db.select().from(table).where(worker(id, generation));
        if (!row) return false;
        const required = row.intent === "remove" ? ["remove"] : CLUSTER_STORAGE_STEPS;
        if (
          required.some(
            (step) =>
              !progress.steps.some((item) => item.id === step && item.status === "completed"),
          ) ||
          (row.intent === "setup" && !observation?.ready)
        )
          throw conflict("Storage cannot be marked ready until its checks finish successfully.");
      }
      return (
        (
          await db
            .update(table)
            .set({
              progress,
              observation,
              error,
              status: error
                ? "failed"
                : sql`CASE WHEN ${table.intent} = 'remove' THEN 'removed' ELSE 'ready' END`,
              leaseExpiresAt: null,
              sequence: sql`${table.sequence}+1`,
              updatedAt: new Date(),
            })
            .where(worker(id, generation))
            .returning()
        ).length === 1
      );
    },
    interrupt: (id: string, generation: number, message: string) =>
      interrupt(and(eq(table.id, id), eq(table.generation, generation)), message),
    recoverInterrupted: (exclusive: boolean) =>
      interrupt(
        exclusive ? undefined : expired(),
        "OpenShip restarted during storage setup. Retry to inspect the saved installation and continue.",
      ),
  };
}
