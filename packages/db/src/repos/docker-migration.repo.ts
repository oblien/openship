/**
 * Repo for docker_migration_run — the MigrationOrchestrator FSM owns it.
 * Mirrors createBackupRunRepo (create / findById / listByOrganization /
 * transition / sweepStaleRuns).
 */

import { and, eq, inArray, isNull, or } from "drizzle-orm";
import type { Database } from "../client";
import { dockerMigrationRun } from "../schema";

export type DockerMigrationRun = typeof dockerMigrationRun.$inferSelect;
export type NewDockerMigrationRun = typeof dockerMigrationRun.$inferInsert;

export type DockerMigrationStatus =
  | "queued"
  | "adopting"
  | "moving_data"
  | "deploying"
  | "verifying"
  | "awaiting_cutover"
  | "cutover"
  | "partial"
  | "succeeded"
  | "failed"
  | "rolled_back";

export const IN_FLIGHT_MIGRATION_STATUSES: DockerMigrationStatus[] = [
  "queued",
  "adopting",
  "moving_data",
  "deploying",
  "verifying",
  "awaiting_cutover",
  "cutover",
  // Parked like awaiting_cutover: target UP, awaiting resolve+resume. Blocks a
  // second migration on the server; boot recovery leaves it untouched.
  "partial",
];

const TERMINAL_MIGRATION_STATUSES: DockerMigrationStatus[] = [
  "succeeded",
  "failed",
  "rolled_back",
];

export function createDockerMigrationRunRepo(db: Database) {
  return {
    async create(data: NewDockerMigrationRun): Promise<DockerMigrationRun> {
      const [row] = await db.insert(dockerMigrationRun).values(data).returning();
      return row;
    },

    async findById(id: string): Promise<DockerMigrationRun | undefined> {
      return db.query.dockerMigrationRun.findFirst({
        where: eq(dockerMigrationRun.id, id),
      });
    },

    async listByOrganization(
      organizationId: string,
      opts?: { limit?: number; offset?: number },
    ): Promise<DockerMigrationRun[]> {
      return db.query.dockerMigrationRun.findMany({
        where: eq(dockerMigrationRun.organizationId, organizationId),
        orderBy: (t, { desc }) => [desc(t.startedAt)],
        limit: opts?.limit ?? 100,
        offset: opts?.offset ?? 0,
      });
    },

    /** FSM state transition. Bumps lastEventAt; sets finishedAt on terminal. */
    async transition(
      id: string,
      status: DockerMigrationStatus,
      patch?: Partial<Omit<NewDockerMigrationRun, "id" | "startedAt">>,
    ): Promise<void> {
      const finishing = TERMINAL_MIGRATION_STATUSES.includes(status);
      await db
        .update(dockerMigrationRun)
        .set({
          status,
          lastEventAt: new Date(),
          ...(finishing ? { finishedAt: new Date() } : {}),
          ...(patch ?? {}),
        })
        .where(eq(dockerMigrationRun.id, id));
    },

    /** Runs touching a server as source OR target, newest first — the server
     *  detail "Migrations" tab lists these like a project's deployments. */
    async listForServer(
      organizationId: string,
      serverId: string,
      opts?: { limit?: number },
    ): Promise<DockerMigrationRun[]> {
      return db.query.dockerMigrationRun.findMany({
        where: and(
          eq(dockerMigrationRun.organizationId, organizationId),
          or(
            eq(dockerMigrationRun.sourceServerId, serverId),
            eq(dockerMigrationRun.targetServerId, serverId),
          ),
        ),
        orderBy: (t, { desc }) => [desc(t.startedAt)],
        limit: opts?.limit ?? 50,
      });
    },

    /** Delete a run row (history cleanup). Caller must ensure it's terminal —
     *  deleting an in-flight run would orphan the running pipeline. */
    async remove(id: string): Promise<void> {
      await db.delete(dockerMigrationRun).where(eq(dockerMigrationRun.id, id));
    },

    /** Patch a partial run's pending-item list (no status change) — used as a
     *  resume whittles it down. */
    async updatePending(id: string, pendingItems: unknown[]): Promise<void> {
      await db
        .update(dockerMigrationRun)
        .set({ pendingItems, lastEventAt: new Date() })
        .where(eq(dockerMigrationRun.id, id));
    },

    /** Patch the recorded target-volume list (cleared after a post-failure wipe). */
    async updateTargetVolumes(id: string, targetVolumes: string[]): Promise<void> {
      await db
        .update(dockerMigrationRun)
        .set({ targetVolumes })
        .where(eq(dockerMigrationRun.id, id));
    },

    /** Patch only the durable session log (no status change). Bumps lastEventAt
     *  so an actively-logging long transfer isn't seen as stale. */
    async updateLogs(id: string, logs: string): Promise<void> {
      await db
        .update(dockerMigrationRun)
        .set({ logs, lastEventAt: new Date() })
        .where(eq(dockerMigrationRun.id, id));
    },

    /** Every in-flight (non-terminal) run — for boot recovery, which restarts
     *  the source containers before marking each rolled_back. */
    async listInFlight(): Promise<DockerMigrationRun[]> {
      return db.query.dockerMigrationRun.findMany({
        where: and(
          inArray(dockerMigrationRun.status, IN_FLIGHT_MIGRATION_STATUSES),
          isNull(dockerMigrationRun.finishedAt),
        ),
      });
    },

    /** In-flight runs touching a server as source OR target — the concurrency
     *  guard so two migrations can't race the same server destructively. */
    async findActiveForServer(serverId: string): Promise<DockerMigrationRun[]> {
      return db.query.dockerMigrationRun.findMany({
        where: and(
          inArray(dockerMigrationRun.status, IN_FLIGHT_MIGRATION_STATUSES),
          isNull(dockerMigrationRun.finishedAt),
          or(
            eq(dockerMigrationRun.sourceServerId, serverId),
            eq(dockerMigrationRun.targetServerId, serverId),
          ),
        ),
      });
    },

    /** Mark every in-flight run as failed. Called at boot to reconcile a crash. */
    async sweepStaleRuns(reason: string): Promise<number> {
      const result = await db
        .update(dockerMigrationRun)
        .set({
          status: "failed",
          finishedAt: new Date(),
          lastEventAt: new Date(),
          errorMessage: reason,
        })
        .where(
          and(
            inArray(dockerMigrationRun.status, IN_FLIGHT_MIGRATION_STATUSES),
            isNull(dockerMigrationRun.finishedAt),
          ),
        )
        .returning();
      return result.length;
    },
  };
}
