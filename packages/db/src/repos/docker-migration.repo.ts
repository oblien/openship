/**
 * Repo for docker_migration_run — the MigrationOrchestrator FSM owns it.
 * Mirrors createBackupRunRepo (create / findById / listByOrganization /
 * transition / sweepStaleRuns).
 */

import { and, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { Database } from "../client";
import { dockerMigrationRun } from "../schema";
import { withProjectWorkAdmission } from "./project-work-admission";

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

/**
 * A run can be about TWO projects, and both need to know.
 *
 * `project_id` is the run's subject: the project being moved, or — for a DUPLICATE — the new
 * project the run creates (the column is repointed at it when the adopt step mints it, because
 * that is the project whose service rows the resume path restarts). A duplicate also has a
 * SOURCE project, which keeps running and is briefly stopped while its volumes stream across.
 * That project is where the operator started the run, so it is the one whose panel has to
 * survive a reload and whose pill has to say what is happening to it.
 *
 * The source id is read out of `input_snapshot` rather than a column of its own: the snapshot
 * already persists the start request verbatim, so there is nothing to migrate and no second
 * value that can disagree with the first.
 *
 * Two readers need that path — one asks Postgres, one walks a row already in memory — and the
 * KEYS below are the single definition both derive from. They were briefly two copies of the
 * same literal, which is a divergence waiting to happen: changing one would leave the SQL
 * finding runs the in-memory walk then discards, i.e. a project that reads "migrating" from a
 * list and "live" from its own page.
 */
const SOURCE_PROJECT_PATH_KEYS = ["projectMove", "projectId"] as const;
/** The same path in Postgres' `#>>` notation. */
const SOURCE_PROJECT_PATH = `{${SOURCE_PROJECT_PATH_KEYS.join(",")}}`;

/** SQL predicate: this run is about `projectId`, as subject OR as a duplicate's source. */
function runTouchesProject(projectId: string) {
  return or(
    eq(dockerMigrationRun.projectId, projectId),
    sql`${dockerMigrationRun.inputSnapshot} #>> ${SOURCE_PROJECT_PATH} = ${projectId}`,
  );
}

/** Every project id a fetched run is about — the in-memory twin of the predicate above. */
function runProjectIds(row: DockerMigrationRun): string[] {
  let node: unknown = row.inputSnapshot;
  for (const key of SOURCE_PROJECT_PATH_KEYS) {
    node = node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined;
  }
  return [row.projectId, typeof node === "string" ? node : null].filter((id): id is string =>
    Boolean(id),
  );
}

const TERMINAL_MIGRATION_STATUSES: DockerMigrationStatus[] = ["succeeded", "failed", "rolled_back"];

/** A terminal-looking outcome is still active until its winning callback exits. */
const liveExecution = and(
  isNotNull(dockerMigrationRun.executionStartedAt),
  isNull(dockerMigrationRun.executionFinishedAt),
);

const activeMigration = or(
  and(
    inArray(dockerMigrationRun.status, IN_FLIGHT_MIGRATION_STATUSES),
    isNull(dockerMigrationRun.finishedAt),
  ),
  liveExecution,
);

export function createDockerMigrationRunRepo(db: Database) {
  return {
    /**
     * Admit project-owned migration work through the same project-row barrier
     * as deployments and backups. A move/copy can stop the source project's
     * containers before it creates its target deployment, so guarding only that
     * later deployment is too late.
     *
     * Scan/adopt runs have no project yet and pass null; once they create one,
     * the run is bound through `bindProject` below before further destructive
     * project work continues.
     */
    async create(data: NewDockerMigrationRun): Promise<DockerMigrationRun | undefined> {
      return withProjectWorkAdmission(db, data.projectId, data.organizationId, async (tx) => {
        const [row] = await tx.insert(dockerMigrationRun).values(data).returning();
        return row as DockerMigrationRun;
      });
    },

    /**
     * Attach an adopt/duplicate run to a project only while that project is
     * still live. This closes the short adoption gap where the new project row
     * exists before the migration row names it.
     */
    async bindProject(
      id: string,
      projectId: string,
      organizationId: string,
      patch: Partial<Omit<NewDockerMigrationRun, "id" | "startedAt" | "projectId">> = {},
    ): Promise<boolean> {
      const bound = await withProjectWorkAdmission(db, projectId, organizationId, async (tx) => {
        const [row] = await tx
          .update(dockerMigrationRun)
          .set({ projectId, lastEventAt: new Date(), ...patch })
          .where(
            and(
              eq(dockerMigrationRun.id, id),
              eq(dockerMigrationRun.organizationId, organizationId),
              inArray(dockerMigrationRun.status, IN_FLIGHT_MIGRATION_STATUSES),
              isNull(dockerMigrationRun.finishedAt),
            ),
          )
          .returning();
        return Boolean(row);
      });
      return bound === true;
    },

    async findById(id: string): Promise<DockerMigrationRun | undefined> {
      return db.query.dockerMigrationRun.findFirst({
        where: eq(dockerMigrationRun.id, id),
      });
    },

    /**
     * Atomically claim one parked-state action and its durable worker lease.
     *
     * The state CAS gives resume/cutover exactly one winner. Admission locks
     * every project the run touches (subject plus duplicate source) against
     * deletion before changing state, so the winning remote worker cannot start
     * after teardown has claimed either side.
     */
    async claimExecution(input: {
      id: string;
      organizationId: string;
      from: "partial" | "awaiting_cutover" | "cutover";
      to: "moving_data" | "awaiting_cutover" | "cutover";
    }): Promise<DockerMigrationRun | undefined> {
      const snapshot = await db.query.dockerMigrationRun.findFirst({
        where: and(
          eq(dockerMigrationRun.id, input.id),
          eq(dockerMigrationRun.organizationId, input.organizationId),
        ),
      });
      if (!snapshot) return undefined;

      const claimed = await withProjectWorkAdmission(
        db,
        [...new Set(runProjectIds(snapshot))],
        input.organizationId,
        async (tx) => {
          const now = new Date();
          const [row] = await tx
            .update(dockerMigrationRun)
            .set({
              status: input.to,
              lastEventAt: now,
              executionStartedAt: now,
              executionFinishedAt: null,
              errorMessage: null,
            })
            .where(
              and(
                eq(dockerMigrationRun.id, input.id),
                eq(dockerMigrationRun.organizationId, input.organizationId),
                eq(dockerMigrationRun.status, input.from),
                or(
                  isNull(dockerMigrationRun.executionStartedAt),
                  isNotNull(dockerMigrationRun.executionFinishedAt),
                ),
              ),
            )
            .returning();
          return row as DockerMigrationRun | undefined;
        },
      );
      return claimed;
    },

    /** Outermost worker-finally acknowledgement; outcome transitions never own it. */
    async acknowledgeExecutionFinished(id: string): Promise<void> {
      await db
        .update(dockerMigrationRun)
        .set({ executionFinishedAt: new Date(), lastEventAt: new Date() })
        .where(
          and(
            eq(dockerMigrationRun.id, id),
            isNotNull(dockerMigrationRun.executionStartedAt),
            isNull(dockerMigrationRun.executionFinishedAt),
          ),
        );
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
      patch?: Partial<
        Omit<
          NewDockerMigrationRun,
          "id" | "startedAt" | "executionStartedAt" | "executionFinishedAt"
        >
      >,
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

    /**
     * Runs about ONE project, newest first — the project's own migration history, listed the
     * same way a server lists its runs and a project lists its deployments.
     *
     * Uses the same "touches this project" predicate as {@link findActiveForProject}, so a
     * duplicate appears in BOTH histories: under the source it reads as "a copy was taken from
     * this", and under the copy as "this is where it came from". Two views of one row, which is
     * the point of not duplicating the row.
     */
    async listForProject(
      organizationId: string,
      projectId: string,
      opts?: { limit?: number },
    ): Promise<DockerMigrationRun[]> {
      return db.query.dockerMigrationRun.findMany({
        where: and(
          eq(dockerMigrationRun.organizationId, organizationId),
          runTouchesProject(projectId),
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
        where: activeMigration,
      });
    },

    /** In-flight runs touching a server as source OR target — the concurrency
     *  guard so two migrations can't race the same server destructively. */
    async findActiveForServer(serverId: string): Promise<DockerMigrationRun[]> {
      return db.query.dockerMigrationRun.findMany({
        where: and(
          activeMigration,
          or(
            eq(dockerMigrationRun.sourceServerId, serverId),
            eq(dockerMigrationRun.targetServerId, serverId),
          ),
        ),
      });
    },

    /**
     * The in-flight run for ONE project, if any — what makes a project read "migrating"
     * everywhere, and what lets the project's own migration panel come back after a reload
     * instead of losing the session with the page.
     *
     * `awaiting_cutover` counts as in-flight (it is in {@link IN_FLIGHT_MIGRATION_STATUSES}),
     * which is the point: a run parked there is exactly the one the operator has to come
     * back to. Newest first, so a stale row can never shadow the live one.
     */
    async findActiveForProject(projectId: string): Promise<DockerMigrationRun | null> {
      const rows = await db.query.dockerMigrationRun.findMany({
        where: and(runTouchesProject(projectId), activeMigration),
        orderBy: (t, { desc }) => [desc(t.startedAt)],
        limit: 1,
      });
      return rows[0] ?? null;
    },

    /**
     * {@link findActiveForProject} for MANY projects in one query — what the batched project
     * read (`enrichProjectsBatch`, i.e. the home page and every project list) uses so a
     * "migrating" pill costs one statement for N projects instead of N.
     *
     * Newest-first with a first-write-wins fill, which reproduces the single-project
     * `limit: 1`: for a project with two in-flight rows both answer the same run.
     */
    async findActiveForProjects(projectIds: string[]): Promise<Map<string, DockerMigrationRun>> {
      const byProject = new Map<string, DockerMigrationRun>();
      if (projectIds.length === 0) return byProject;
      const rows = await db.query.dockerMigrationRun.findMany({
        where: and(
          or(
            inArray(dockerMigrationRun.projectId, projectIds),
            // `inArray` over the extracted path, not a hand-written `= ANY(...)`: it renders a
            // bound list drizzle already knows how to parameterise for both Postgres and PGlite.
            inArray(
              sql`${dockerMigrationRun.inputSnapshot} #>> ${SOURCE_PROJECT_PATH}`,
              projectIds,
            ),
          ),
          activeMigration,
        ),
        orderBy: (t, { desc }) => [desc(t.startedAt)],
      });
      // Filled per project id ASKED FOR, not per row: a duplicate's row answers for two
      // projects (its subject and its source), so keying only on `row.projectId` would lose
      // the source — the very project whose Advanced tab started the run.
      for (const row of rows) {
        for (const id of runProjectIds(row)) {
          if (projectIds.includes(id) && !byProject.has(id)) byProject.set(id, row);
        }
      }
      return byProject;
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
