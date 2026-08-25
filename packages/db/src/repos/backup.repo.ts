/**
 * Repos for the four backup tables. Single file because they're
 * conceptually one feature and the cross-references are tight.
 *
 *   destination  — per-user storage targets
 *   policy       — per-project (+ per-service override) rules
 *   run          — execution history (orchestrator FSM owns it)
 *   restore      — restore history (sibling of run)
 */

import { and, desc, eq, inArray, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import type { Database } from "../client";
import { backupDestination, backupPolicy, backupRestore, backupRun } from "../schema";
import { detailOf } from "./storable-detail";

// ─── Inferred types ──────────────────────────────────────────────────────────

export type BackupDestination = typeof backupDestination.$inferSelect;
export type NewBackupDestination = typeof backupDestination.$inferInsert;
export type BackupPolicy = typeof backupPolicy.$inferSelect;
export type NewBackupPolicy = typeof backupPolicy.$inferInsert;
export type BackupRun = typeof backupRun.$inferSelect;
export type NewBackupRun = typeof backupRun.$inferInsert;
export type BackupRestore = typeof backupRestore.$inferSelect;
export type NewBackupRestore = typeof backupRestore.$inferInsert;

export type BackupRunStatus =
  | "queued"
  | "preparing"
  | "snapshotting"
  | "uploading"
  | "verifying"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "server_error";

/**
 * Restore FSM: queued → preparing → prepared → applying → terminal.
 *
 *   preparing  Downloading artifact + verifying sha256 into a staging
 *              area (Docker named volume or Cloud workspace sub-path).
 *              Service stays running, untouched.
 *   prepared   Staging complete. Waiting for user to confirm + apply.
 *              Can sit indefinitely. User can also cancel here and
 *              the staging area gets cleaned up.
 *   applying   Destructive phase: stop service → swap volume contents
 *              from staging → start service → verify health.
 */
export type BackupRestoreStatus =
  | "queued"
  | "preparing"
  | "prepared"
  | "applying"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "server_error";

export const IN_FLIGHT_RUN_STATUSES: BackupRunStatus[] = [
  "queued",
  "preparing",
  "snapshotting",
  "uploading",
  "verifying",
];

const TERMINAL_RUN_STATUSES: BackupRunStatus[] = [
  "succeeded",
  "failed",
  "cancelled",
  "server_error",
];

export const IN_FLIGHT_RESTORE_STATUSES: BackupRestoreStatus[] = [
  "queued",
  "preparing",
  "applying",
];
// Note: `prepared` is INTENTIONALLY not in-flight — it's a quiescent
// waiting state. Boot sweep doesn't kill prepared restores, the user
// gets to apply them after a restart.

// ─── Transition durability ───────────────────────────────────────────────────

/**
 * Persist an FSM transition so the STATUS can never be lost to its payload.
 *
 * A run/restore's status is the RECORD; the patch riding with it — hook log,
 * error text, artifact metadata — is raw remote bytes, i.e. observability.
 * Postgres refuses a NUL in a text column ("invalid byte sequence for encoding
 * UTF8: 0x00") and an unpaired surrogate in jsonb, and both used to travel in
 * ONE statement with the status: a user shell hook that printed a NUL turned a
 * SUCCEEDED backup into a FAILED one (the rejected UPDATE threw out of the
 * orchestrator's try, whose catch then transitioned the run to "failed" — with
 * the artifact already uploaded and the manifest already written).
 *
 * So: status first, in its own statement out of values we construct. Then the
 * payload, which sheds itself column-by-column — a poisoned hook log costs its
 * own column and nothing else, and a rejected string column keeps a marker
 * naming the DB error rather than going blank (a failed run with no reason
 * reads as "no reason given").
 */
async function persistTransition(
  label: string,
  id: string,
  status: string,
  core: Record<string, unknown>,
  patch: Record<string, unknown> | undefined,
  /**
   * `guarded` is true ONLY for the status write.
   *
   * The terminal guard must not cover the payload writes below. The core write flips the
   * row to `succeeded`, so a guard applied to every write would then reject the very next
   * one — silently dropping `manifestKey`, `artifacts`, `bytesTransferred` on success and
   * `errorMessage` on failure. Caught by the payload-matrix E2E: a run reported
   * `succeeded` with `manifest_key` still null.
   */
  write: (values: Record<string, unknown>, guarded: boolean) => Promise<unknown>,
): Promise<boolean> {
  const core_result = await write(core, true);
  // An empty `returning()` means the guarded WHERE matched nothing: the row is already
  // terminal and this transition lost the race. Logged, never swallowed — the write being
  // dropped is exactly the information someone debugging a disagreeing run needs, and the
  // payload writes below are pointless once the core one did not land.
  if (Array.isArray(core_result) && core_result.length === 0) {
    console.warn(
      `[db] ${label} ${id}: refused transition to "${status}" — the row is already in a ` +
        `terminal state. Whoever finished it first owns the verdict; this write was dropped.`,
    );
    return false;
  }
  if (!patch) return true;
  // `status` never rides the payload — the core write above owns it.
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key !== "status") rest[key] = value;
  }
  const keys = Object.keys(rest);
  if (keys.length === 0) return true;

  try {
    await write(rest, false);
    return true;
  } catch (err) {
    console.error(
      `[db] ${label} ${id}: payload rejected (${detailOf(err)}) — status "${status}" is persisted; salvaging per column`,
    );
  }

  for (const key of keys) {
    try {
      await write({ [key]: rest[key] }, false);
      continue;
    } catch (err) {
      const detail = detailOf(err);
      if (typeof rest[key] === "string") {
        try {
          await write({ [key]: `[unstorable: ${detail}]` }, false);
          continue;
        } catch {
          // fall through to the log below
        }
      }
      console.error(`[db] ${label} ${id}: column ${key} rejected (${detail}) — left unset`);
    }
  }
  return true;
}

// ─── Destination repo ────────────────────────────────────────────────────────

export function createBackupDestinationRepo(db: Database) {
  return {
    /**
     * Org-scoped list — returns every destination in the org. Access is
     * already verified at the route boundary; this just scopes the rows.
     */
    async listByOrganization(organizationId: string): Promise<BackupDestination[]> {
      return db.query.backupDestination.findMany({
        where: and(
          eq(backupDestination.organizationId, organizationId),
          isNull(backupDestination.deletedAt),
        ),
        orderBy: (t, { asc }) => [asc(t.createdAt)],
      });
    },

    /** Org-scoped variant of `findByName`. Uniqueness is per-org now. */
    async findByNameInOrganization(
      organizationId: string,
      name: string,
    ): Promise<BackupDestination | undefined> {
      return db.query.backupDestination.findFirst({
        where: and(
          eq(backupDestination.organizationId, organizationId),
          eq(backupDestination.name, name),
          isNull(backupDestination.deletedAt),
        ),
      });
    },

    async findById(id: string): Promise<BackupDestination | undefined> {
      return db.query.backupDestination.findFirst({
        where: and(eq(backupDestination.id, id), isNull(backupDestination.deletedAt)),
      });
    },

    // findByName removed — use findByNameInOrganization. Name uniqueness
    // is per-org now (uq_backup_destination_org_name_active).

    async create(data: NewBackupDestination): Promise<BackupDestination> {
      const [row] = await db.insert(backupDestination).values(data).returning();
      return row;
    },

    async update(
      id: string,
      data: Partial<Omit<NewBackupDestination, "id" | "createdAt">>,
    ): Promise<BackupDestination | undefined> {
      const [row] = await db
        .update(backupDestination)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(backupDestination.id, id))
        .returning();
      return row;
    },

    async setLastVerified(id: string, ok: boolean, error?: string): Promise<void> {
      await db
        .update(backupDestination)
        .set({
          lastVerifiedAt: ok ? new Date() : backupDestination.lastVerifiedAt,
          lastVerifyError: ok ? null : (error ?? "Verification failed"),
          updatedAt: new Date(),
        })
        .where(eq(backupDestination.id, id));
    },

    /** Soft delete. Refuses if any active policy still references it —
     *  caller catches and surfaces the friendly error. */
    async softDelete(id: string): Promise<{ ok: true } | { ok: false; reason: string }> {
      const referencingCount = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(backupPolicy)
        .where(and(eq(backupPolicy.destinationId, id), isNull(backupPolicy.deletedAt)))
        .then((rows) => Number(rows[0]?.count ?? 0));

      if (referencingCount > 0) {
        return {
          ok: false,
          reason: `Destination is referenced by ${referencingCount} active backup ${
            referencingCount === 1 ? "policy" : "policies"
          }. Remove those policies first.`,
        };
      }

      await db
        .update(backupDestination)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(backupDestination.id, id));
      return { ok: true };
    },
  };
}

// ─── Policy repo ─────────────────────────────────────────────────────────────

export function createBackupPolicyRepo(db: Database) {
  return {
    async listByProject(projectId: string): Promise<BackupPolicy[]> {
      return db.query.backupPolicy.findMany({
        where: and(eq(backupPolicy.projectId, projectId), isNull(backupPolicy.deletedAt)),
      });
    },

    /** Every live policy that targets a destination — powers the destination
     *  detail page's "used by" view (which projects/services back up here). */
    async listByDestination(destinationId: string): Promise<BackupPolicy[]> {
      return db.query.backupPolicy.findMany({
        where: and(eq(backupPolicy.destinationId, destinationId), isNull(backupPolicy.deletedAt)),
      });
    },

    async findById(id: string): Promise<BackupPolicy | undefined> {
      return db.query.backupPolicy.findFirst({
        where: and(eq(backupPolicy.id, id), isNull(backupPolicy.deletedAt)),
      });
    },

    /** Project-level default — the row with serviceId IS NULL. */
    async findProjectDefault(projectId: string): Promise<BackupPolicy | undefined> {
      return db.query.backupPolicy.findFirst({
        where: and(
          eq(backupPolicy.projectId, projectId),
          isNull(backupPolicy.serviceId),
          isNull(backupPolicy.deletedAt),
        ),
      });
    },

    /** Per-service override — the row with serviceId = X. */
    async findServiceOverride(
      projectId: string,
      serviceId: string,
    ): Promise<BackupPolicy | undefined> {
      return db.query.backupPolicy.findFirst({
        where: and(
          eq(backupPolicy.projectId, projectId),
          eq(backupPolicy.serviceId, serviceId),
          isNull(backupPolicy.deletedAt),
        ),
      });
    },

    /**
     * Effective policy for (project, service) — picks ONE row.
     * Override wins; falls back to project default; null if neither.
     */
    async findEffective(
      projectId: string,
      serviceId: string | null,
    ): Promise<BackupPolicy | undefined> {
      if (serviceId) {
        const override = await this.findServiceOverride(projectId, serviceId);
        if (override) return override;
      }
      return this.findProjectDefault(projectId);
    },

    /** The single active policy for a mail server (mail_server source). */
    async findActiveByMailServer(mailServerId: string): Promise<BackupPolicy | undefined> {
      return db.query.backupPolicy.findFirst({
        where: and(eq(backupPolicy.mailServerId, mailServerId), isNull(backupPolicy.deletedAt)),
      });
    },

    async findByWebhookToken(token: string): Promise<BackupPolicy | undefined> {
      return db.query.backupPolicy.findFirst({
        where: and(eq(backupPolicy.webhookToken, token), isNull(backupPolicy.deletedAt)),
      });
    },

    /**
     * Every enabled policy with a non-null cron expression.
     *
     * Two access shapes:
     *   - `listEnabledScheduled()`            return everything in one
     *                                         batch. Convenient for
     *                                         small instances; can
     *                                         block boot under large
     *                                         policy counts.
     *   - `iterateEnabledScheduled(pageSize)` async generator that
     *                                         yields rows in batches.
     *                                         Cron boot should use
     *                                         this so a single org
     *                                         with thousands of
     *                                         policies doesn't delay
     *                                         every other org's
     *                                         schedule registration.
     */
    async listEnabledScheduled(): Promise<BackupPolicy[]> {
      return db.query.backupPolicy.findMany({
        where: and(
          isNull(backupPolicy.deletedAt),
          eq(backupPolicy.enabled, true),
          sql`${backupPolicy.cronExpression} IS NOT NULL`,
        ),
      });
    },

    async *iterateEnabledScheduled(pageSize = 100): AsyncIterableIterator<BackupPolicy> {
      let offset = 0;
      while (true) {
        const page = await db.query.backupPolicy.findMany({
          where: and(
            isNull(backupPolicy.deletedAt),
            eq(backupPolicy.enabled, true),
            sql`${backupPolicy.cronExpression} IS NOT NULL`,
          ),
          orderBy: (t, { asc }) => [asc(t.id)],
          limit: pageSize,
          offset,
        });
        if (page.length === 0) return;
        for (const row of page) yield row;
        if (page.length < pageSize) return;
        offset += pageSize;
      }
    },

    /**
     * Every enabled policy with retention configured, cron or not.
     *
     * The retention sweep used to walk `iterateEnabledScheduled`, on the theory
     * that a policy without a cron is manual-only and its owner opted into
     * fire-and-forget. That theory misses two triggers that produce runs
     * automatically: `trigger_on_pre_deploy` and the inbound webhook. Those
     * policies fill a destination on a schedule set by pushes rather than by
     * cron, and their runs were never pruned even with `retain_count` set —
     * which is exactly the case where the operator DID ask for a ceiling.
     *
     * Paginated because the sweep runs against every org on the instance.
     */
    async *iterateEnabledForRetention(pageSize = 100): AsyncIterableIterator<BackupPolicy> {
      let offset = 0;
      while (true) {
        const page = await db.query.backupPolicy.findMany({
          where: and(
            isNull(backupPolicy.deletedAt),
            eq(backupPolicy.enabled, true),
            or(
              sql`${backupPolicy.retainCount} IS NOT NULL`,
              sql`${backupPolicy.retainDays} IS NOT NULL`,
            ),
          ),
          orderBy: (t, { asc }) => [asc(t.id)],
          limit: pageSize,
          offset,
        });
        if (page.length === 0) return;
        for (const row of page) yield row;
        if (page.length < pageSize) return;
        offset += pageSize;
      }
    },

    /** Every enabled policy with `trigger_on_pre_deploy = true` for a
     *  given project. Used by the pre-deploy hook in the deployment
     *  lifecycle to fire backups before swapping the active deployment. */
    async listEnabledPreDeployByProject(projectId: string): Promise<BackupPolicy[]> {
      return db.query.backupPolicy.findMany({
        where: and(
          eq(backupPolicy.projectId, projectId),
          isNull(backupPolicy.deletedAt),
          eq(backupPolicy.enabled, true),
          eq(backupPolicy.triggerOnPreDeploy, true),
        ),
      });
    },

    async create(data: NewBackupPolicy): Promise<BackupPolicy> {
      const [row] = await db.insert(backupPolicy).values(data).returning();
      return row;
    },

    async update(
      id: string,
      data: Partial<Omit<NewBackupPolicy, "id" | "createdAt">>,
    ): Promise<BackupPolicy | undefined> {
      const [row] = await db
        .update(backupPolicy)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(backupPolicy.id, id))
        .returning();
      return row;
    },

    async markWebhookFired(id: string): Promise<void> {
      await db
        .update(backupPolicy)
        .set({ webhookLastFiredAt: new Date(), updatedAt: new Date() })
        .where(eq(backupPolicy.id, id));
    },

    async softDelete(id: string): Promise<void> {
      await db
        .update(backupPolicy)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(backupPolicy.id, id));
    },
  };
}

// ─── Run repo ────────────────────────────────────────────────────────────────

export function createBackupRunRepo(db: Database) {
  return {
    /**
     * Org-scoped list — returns every run for the org, optionally
     * narrowed by project/service. Access already verified at the
     * route boundary.
     */
    async listByOrganization(
      organizationId: string,
      opts?: {
        limit?: number;
        offset?: number;
        projectId?: string;
        serviceId?: string;
        mailServerId?: string;
      },
    ): Promise<BackupRun[]> {
      const conditions = [
        eq(backupRun.organizationId, organizationId),
        isNull(backupRun.deletedAt),
      ];
      if (opts?.projectId) conditions.push(eq(backupRun.projectId, opts.projectId));
      if (opts?.serviceId) conditions.push(eq(backupRun.serviceId, opts.serviceId));
      if (opts?.mailServerId) conditions.push(eq(backupRun.mailServerId, opts.mailServerId));
      return db.query.backupRun.findMany({
        where: and(...conditions),
        orderBy: (t, { desc }) => [desc(t.startedAt)],
        limit: opts?.limit ?? 100,
        offset: opts?.offset ?? 0,
      });
    },

    async findById(id: string): Promise<BackupRun | undefined> {
      return db.query.backupRun.findFirst({
        where: eq(backupRun.id, id),
      });
    },

    /** Most recent run for a policy (any status), newest first. Used by the
     *  read-only backup-schedule view in the Jobs tab to show last-run state. */
    async latestByPolicy(policyId: string): Promise<BackupRun | undefined> {
      return db.query.backupRun.findFirst({
        where: and(eq(backupRun.policyId, policyId), isNull(backupRun.deletedAt)),
        orderBy: (t, { desc }) => [desc(t.startedAt)],
      });
    },

    /** Storage rollup per destination for one org: bytes actually stored
     *  (succeeded, non-deleted runs), total run count, and the most recent run
     *  time. Powers the Backups page's per-destination size monitoring. */
    async statsByDestination(
      organizationId: string,
    ): Promise<
      Array<{
        destinationId: string | null;
        storedBytes: number;
        runCount: number;
        lastRunAt: Date | null;
      }>
    > {
      const rows = await db
        .select({
          destinationId: backupRun.destinationId,
          storedBytes: sql<number>`coalesce(sum(case when ${backupRun.status} = 'succeeded' then ${backupRun.bytesTransferred} else 0 end), 0)`,
          runCount: sql<number>`count(*)`,
          lastRunAt: sql<string | null>`max(${backupRun.startedAt})`,
        })
        .from(backupRun)
        .where(and(eq(backupRun.organizationId, organizationId), isNull(backupRun.deletedAt)))
        .groupBy(backupRun.destinationId);
      return rows.map((r) => ({
        destinationId: r.destinationId,
        storedBytes: Number(r.storedBytes) || 0,
        runCount: Number(r.runCount) || 0,
        lastRunAt: r.lastRunAt ? new Date(r.lastRunAt) : null,
      }));
    },

    /** Every run for a project still in a non-terminal state. Used by the
     *  atomic project-teardown gate to decide whether to reject or force. */
    async listInFlightByProject(projectId: string): Promise<BackupRun[]> {
      return db.query.backupRun.findMany({
        where: and(
          eq(backupRun.projectId, projectId),
          inArray(backupRun.status, IN_FLIGHT_RUN_STATUSES),
          isNull(backupRun.deletedAt),
        ),
      });
    },

    /** Queued runs awaiting a worker. Used by the in-process runner's
     *  boot requeue + periodic poll, both of which sweep work that a
     *  prior process left orphaned. Ordered oldest-first so we work
     *  through the backlog in FIFO order. */
    async listQueued(limit = 50): Promise<BackupRun[]> {
      return db.query.backupRun.findMany({
        where: eq(backupRun.status, "queued"),
        orderBy: (t, { asc }) => [asc(t.startedAt)],
        limit,
      });
    },

    async create(data: NewBackupRun): Promise<BackupRun> {
      const [row] = await db.insert(backupRun).values(data).returning();
      return row;
    },

    /** FSM state transition. Always bumps lastEventAt; sets finishedAt
     *  on terminal states. Status is written separately from the patch — see
     *  persistTransition for why the two must not fail as a unit. */
    async transition(
      id: string,
      status: BackupRunStatus,
      patch?: Partial<Omit<NewBackupRun, "id" | "startedAt">>,
    ): Promise<boolean> {
      const finishing = TERMINAL_RUN_STATUSES.includes(status);
      const now = new Date();
      return persistTransition(
        "backup_run",
        id,
        status,
        { status, lastEventAt: now, ...(finishing ? { finishedAt: now } : {}) },
        patch as Record<string, unknown> | undefined,
        (values, guarded) =>
          db
            .update(backupRun)
            .set(values as Partial<NewBackupRun>)
            // A terminal status is FINAL, and the guard is atomic rather than a
            // read-then-check because the writers genuinely race: the stale-heartbeat
            // sweep's ceiling can stamp `server_error` on a legitimately long upload
            // while `execute()` is still running, and the unguarded write then let
            // `succeeded` land on top of it — a run the system had already decided had
            // failed becoming a green restore point. One owner per verdict: whoever
            // reaches terminal first.
            .where(
              guarded
                ? and(eq(backupRun.id, id), notInArray(backupRun.status, TERMINAL_RUN_STATUSES))
                : eq(backupRun.id, id),
            )
            .returning(),
      );
    },

    /**
     * Mid-upload progress: cumulative `bytesTransferred` + a `lastEventAt`
     * heartbeat while a run sits in `uploading` between artifact boundaries.
     * Called throttled from the upload stream; NOT a transition — status is
     * untouched, `finishedAt` is untouched.
     *
     * Two guards, both in the WHERE so the check is atomic with the write:
     *   - only `uploading` accepts progress: a throttled write still in flight
     *     after any later state must not mutate or heartbeat that state;
     *   - the value must ADVANCE: writes are serialized by the orchestrator
     *     but the monotonic clause is what makes a reordered or duplicated
     *     delivery harmless instead of a backward-moving counter.
     *
     * A refused write is silent by design: progress is telemetry, and the only
     * information it carried (a later heartbeat) is stale once the row is no
     * longer uploading.
     */
    async recordUploadProgress(id: string, bytesTransferred: number): Promise<boolean> {
      const result = await db
        .update(backupRun)
        .set({ bytesTransferred, lastEventAt: new Date() })
        .where(
          and(
            eq(backupRun.id, id),
            eq(backupRun.status, "uploading"),
            or(
              isNull(backupRun.bytesTransferred),
              lt(backupRun.bytesTransferred, bytesTransferred),
            ),
          ),
        )
        .returning();
      return result.length > 0;
    },

    /**
     * Mark every RUNNING run as server_error. Called at boot to reconcile after a
     * crash: a run that was mid-execution has no worker any more, and its in-process
     * state died with the process, so it cannot be resumed.
     *
     * `queued` is excluded, because a queued row lost nothing when the process died —
     * it had not started. Both runners recover it: the in-process one calls
     * `requeueOrphanedRuns()` at boot and polls `listQueued()` every 30s, and BullMQ
     * holds the job in Redis. Terminalizing it here destroyed durable work and, since
     * the write is terminal and `transition()` guards terminal states, did so
     * permanently — an API restart during a backup window meant those backups never
     * ran and reported a crash that had not touched them.
     */
    async sweepStaleRuns(reason: string): Promise<number> {
      const result = await db
        .update(backupRun)
        .set({
          status: "server_error",
          finishedAt: new Date(),
          lastEventAt: new Date(),
          errorMessage: reason,
        })
        .where(
          and(
            inArray(
              backupRun.status,
              IN_FLIGHT_RUN_STATUSES.filter((s) => s !== "queued"),
            ),
            isNull(backupRun.finishedAt),
          ),
        )
        .returning();
      return result.length;
    },

    /**
     * Fail in-flight runs whose `lastEventAt` heartbeat has gone stale. Unlike
     * `sweepStaleRuns` (boot-only, marks everything in-flight), this is selective:
     *   - preparing/snapshotting/verifying with no transition within `idleCutoff`
     *     (brief hops between states — a stall there is genuinely stuck)
     *   - any in-flight row past the absolute `ceilingCutoff`
     *
     * `queued` is deliberately NOT swept on the idle window, and this is the whole
     * point of the state. `lastEventAt` is stamped once at row creation and bumped
     * only by `transition()`, so while a run WAITS for a worker slot the column does
     * not move — meaning an idle window applied to `queued` measures QUEUE DEPTH, not
     * health. Run concurrency is 2, so a project-level policy fanning out across a
     * handful of services, or a set of policies sharing one cron minute, puts ordinary
     * runs past any such window while they are still perfectly claimable.
     *
     * Sweeping them was unrecoverable, not merely early: the write is TERMINAL, the
     * guard in `transition()` then refuses every later write, and `execute()` bails on
     * any row that is no longer `queued`. So the nightly backups quietly stopped
     * happening and reported a timeout that had not occurred.
     *
     * A queued row also does not NEED this: it is never orphaned. The in-process
     * runner re-lists `listQueued()` every 30s (and at boot), and the BullMQ queue is
     * durable in Redis. The 6h `ceilingCutoff` still applies as the genuine backstop —
     * a row that has sat queued that long is a real anomaly, not a busy queue.
     *
     * `uploading` is deliberately NOT idle-swept even though it now heartbeats.
     * This repository can decide that a row is stale, but it cannot abort the
     * producer/destination promise holding the worker slot. Marking that row
     * terminal would therefore report recovery without actually releasing the
     * blocked work. Upload executors retain their in-process idle watchdogs; the
     * database sweep can include this state only when capture has an abort path.
     */
    async sweepRunsWithStaleHeartbeat(params: {
      idleCutoff: Date;
      ceilingCutoff: Date;
      reason: string;
    }): Promise<number> {
      const { idleCutoff, ceilingCutoff, reason } = params;
      const result = await db
        .update(backupRun)
        .set({
          status: "server_error",
          finishedAt: new Date(),
          lastEventAt: new Date(),
          errorMessage: reason,
        })
        .where(
          and(
            inArray(backupRun.status, IN_FLIGHT_RUN_STATUSES),
            isNull(backupRun.finishedAt),
            or(
              and(
                inArray(backupRun.status, ["preparing", "snapshotting", "verifying"]),
                lt(backupRun.lastEventAt, idleCutoff),
              ),
              lt(backupRun.lastEventAt, ceilingCutoff),
            ),
          ),
        )
        .returning();
      return result.length;
    },

    /** Used by the retention prune job (Chunk 2). */
    async listSucceededOlderThan(destinationId: string, cutoff: Date): Promise<BackupRun[]> {
      return db.query.backupRun.findMany({
        where: and(
          eq(backupRun.destinationId, destinationId),
          eq(backupRun.status, "succeeded"),
          isNull(backupRun.deletedAt),
          lt(backupRun.finishedAt, cutoff),
        ),
      });
    },

    /**
     * Runs holding a `custom_command` artifact whose `restoreCommand` is unusable —
     * i.e. an artifact that cannot be put back (D5). Filtered in SQL so an instance
     * with years of history doesn't page every row in to find a handful, and
     * matched on the ARTIFACT rather than the policy so runs whose policy was
     * since deleted still surface (those are unrecoverable, and the operator
     * needs to hear about them before they need the restore).
     *
     * Two shapes, because there are two ways the command went missing. EMPTY is the
     * original D5 defect (the orchestrator hand-picked payload keys and dropped it).
     * A `***` is the second: the recorded metadata was run through the build-log
     * credential scrubber, so a command carrying a DSN was stored with its userinfo
     * redacted — present, plausible, and guaranteed to fail authentication. New runs
     * no longer go through that path; this finds the ones already captured.
     *
     * The `***` match is deliberately BROAD (any occurrence) because this is only a
     * candidate list — the caller re-checks each entry against the narrow
     * `isRedactedCommand` shape before touching anything, so an operator's own `***`
     * costs one skipped row rather than a rewritten command.
     */
    async listCustomCommandMissingRestoreCommand(limit = 1000): Promise<BackupRun[]> {
      return db.query.backupRun.findMany({
        where: and(
          isNull(backupRun.deletedAt),
          sql`jsonb_typeof(${backupRun.artifacts}) = 'array'`,
          sql`exists (
            select 1 from jsonb_array_elements(${backupRun.artifacts}) as entry
            where entry->>'payloadKind' = 'custom_command'
              and (
                coalesce(entry->'metadata'->>'restoreCommand', '') = ''
                or entry->'metadata'->>'restoreCommand' like '%***%'
              )
          )`,
        ),
        orderBy: (t, { asc }) => [asc(t.startedAt)],
        limit,
      });
    },

    /** Rewrite the recorded artifact list. A run's artifacts are otherwise
     *  write-once at capture time — the D5 `restoreCommand` backfill is the only
     *  caller, and it touches nothing else on the row (status included). */
    async setArtifacts(id: string, artifacts: unknown[]): Promise<void> {
      await db.update(backupRun).set({ artifacts }).where(eq(backupRun.id, id));
    },

    async softDelete(id: string): Promise<void> {
      await db.update(backupRun).set({ deletedAt: new Date() }).where(eq(backupRun.id, id));
    },

    /** Toggle the "protect this backup" flag. When set, retention
     *  prune skips this run regardless of count/age caps. */
    async setRetentionLock(id: string, lockedUntil: Date | null): Promise<void> {
      await db
        .update(backupRun)
        .set({ retentionLockedUntil: lockedUntil })
        .where(eq(backupRun.id, id));
    },
  };
}

// ─── Restore repo ────────────────────────────────────────────────────────────

export function createBackupRestoreRepo(db: Database) {
  return {
    /** Org-scoped list of restores. */
    async listByOrganization(
      organizationId: string,
      opts?: { limit?: number },
    ): Promise<BackupRestore[]> {
      return db.query.backupRestore.findMany({
        where: eq(backupRestore.organizationId, organizationId),
        orderBy: (t, { desc }) => [desc(t.startedAt)],
        limit: opts?.limit ?? 100,
      });
    },

    async findById(id: string): Promise<BackupRestore | undefined> {
      return db.query.backupRestore.findFirst({
        where: eq(backupRestore.id, id),
      });
    },

    /** Every in-flight restore for a project. Used by atomic teardown to
     *  gate / force-cancel restore work before the project row is dropped. */
    async listInFlightByProject(projectId: string): Promise<BackupRestore[]> {
      return db.query.backupRestore.findMany({
        where: and(
          eq(backupRestore.projectId, projectId),
          inArray(backupRestore.status, IN_FLIGHT_RESTORE_STATUSES),
        ),
      });
    },

    /** Find any non-terminal restore for a given source run. Used when
     *  the user re-clicks Prepare on a row that's already prepared:
     *  we surface the existing restore instead of double-staging. */
    async findActiveByRunId(runId: string): Promise<BackupRestore | undefined> {
      return db.query.backupRestore.findFirst({
        where: and(
          eq(backupRestore.runId, runId),
          inArray(backupRestore.status, ["queued", "preparing", "prepared", "applying"]),
        ),
      });
    },

    async create(data: NewBackupRestore): Promise<BackupRestore> {
      const [row] = await db.insert(backupRestore).values(data).returning();
      return row;
    },

    /**
     * Give a restore row a confirmation token IF it has none, and report the token
     * that is actually in force.
     *
     * A null token there means apply can NEVER succeed: the compare demands an exact
     * match against the stored value and the route rejects an empty one before it gets
     * that far, so the row is prepared and unappliable. The update is conditional on
     * the column still being null, so a concurrent prepare cannot swap the token out
     * from under a client already holding one — hence the read-back for the losing
     * caller, which needs the winner's value, not its own.
     */
    async adoptConfirmationToken(id: string, token: string): Promise<string | null> {
      const [row] = await db
        .update(backupRestore)
        .set({ confirmationToken: token })
        .where(and(eq(backupRestore.id, id), isNull(backupRestore.confirmationToken)))
        .returning();
      if (row) return row.confirmationToken;
      const current = await db.query.backupRestore.findFirst({
        where: eq(backupRestore.id, id),
      });
      return current?.confirmationToken ?? null;
    },

    /**
     * Record a cancel request without transitioning — the running phase honors
     * it at its next checkpoint. Returns the updated row so the caller can read
     * back the FIRST press time, which `coalesce` preserves: a second press is
     * the force-terminal signal and must not reset its own window.
     */
    async requestCancel(id: string): Promise<BackupRestore | undefined> {
      const [row] = await db
        .update(backupRestore)
        .set({
          cancelRequested: true,
          cancelRequestedAt: sql`coalesce(${backupRestore.cancelRequestedAt}, now())`,
          lastEventAt: new Date(),
        })
        .where(eq(backupRestore.id, id))
        .returning();
      return row;
    },

    async transition(
      id: string,
      status: BackupRestoreStatus,
      patch?: Partial<Omit<NewBackupRestore, "id" | "userId" | "startedAt">>,
    ): Promise<void> {
      const TERMINAL: BackupRestoreStatus[] = ["succeeded", "failed", "cancelled", "server_error"];
      const finishing = TERMINAL.includes(status);
      const now = new Date();
      await persistTransition(
        "backup_restore",
        id,
        status,
        {
          status,
          lastEventAt: now,
          ...(finishing ? { finishedAt: now } : {}),
          ...(status === "cancelled" ? { cancelledAt: now } : {}),
        },
        patch as Record<string, unknown> | undefined,
        (values, guarded) =>
          db
            .update(backupRestore)
            .set(values as Partial<NewBackupRestore>)
            // Same rule as backup_run above. This table is where it was first observed:
            // "the operator watched a cancel undo itself" (restore.orchestrator.ts) was
            // patched with a read-then-check in the ORCHESTRATOR, leaving the repo write
            // unguarded — so the race stayed reachable from any other writer.
            .where(
              guarded
                ? and(eq(backupRestore.id, id), notInArray(backupRestore.status, TERMINAL))
                : eq(backupRestore.id, id),
            )
            .returning(),
      );
    },

    async sweepStaleRestores(reason: string): Promise<number> {
      const result = await db
        .update(backupRestore)
        .set({
          status: "server_error",
          finishedAt: new Date(),
          lastEventAt: new Date(),
          errorMessage: reason,
        })
        .where(
          and(
            inArray(backupRestore.status, IN_FLIGHT_RESTORE_STATUSES),
            isNull(backupRestore.finishedAt),
          ),
        )
        .returning();
      return result.length;
    },
  };
}
