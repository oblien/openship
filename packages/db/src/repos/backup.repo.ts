/**
 * Repos for the four backup tables. Single file because they're
 * conceptually one feature and the cross-references are tight.
 *
 *   destination  — per-user storage targets
 *   policy       — per-project (+ per-service override) rules
 *   run          — execution history (orchestrator FSM owns it)
 *   restore      — restore history (sibling of run)
 */

import { and, desc, eq, inArray, isNotNull, isNull, lt, ne, notInArray, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Database } from "../client";
import {
  backupDestination,
  backupPolicy,
  backupRestore,
  backupRun,
  clusterDatabase,
  mailServers,
  project,
  service,
  servers,
} from "../schema";
import { AppError, backupArtifactObjects, type StoredBackupArtifact } from "@repo/core";
import { detailOf } from "./storable-detail";
import { withProjectWorkAdmission } from "./project-work-admission";

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

export interface PolicyLastRunSummary {
  id: string;
  status: string;
  startedAt: Date;
  finishedAt: Date | null;
  bytesTransferred: number | null;
}

/** Result of atomically admitting one queued backup worker. */
export type BackupRunExecutionClaim = "claimed" | "project_unavailable" | "state_changed";

/**
 * Restore FSM: queued → preparing → prepared → applying → terminal.
 *
 *   preparing  Verifies the remote artifact and target while leaving the
 *              service untouched. Nothing is staged locally today.
 *   prepared   Verification complete. Waiting for user confirmation; this
 *              state may sit indefinitely and is safe to cancel immediately.
 *   applying   Destructive phase: stop service → stream into the target →
 *              start service → verify health.
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

/** Result of atomically admitting the destructive half of a restore. */
export type BackupRestoreApplyClaim =
  | "claimed"
  | "project_unavailable"
  | "target_unavailable"
  | "target_busy"
  | "state_changed";

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

/** A terminal-looking outcome is still active until its winning worker exits. */
const liveBackupExecution = and(
  isNotNull(backupRun.executionStartedAt),
  isNull(backupRun.executionFinishedAt),
);

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
  const runReferences = (id: string) => and(
    eq(backupRun.destinationId, id), isNull(backupRun.deletedAt),
    or(eq(backupRun.status, "succeeded"), inArray(backupRun.status, IN_FLIGHT_RUN_STATUSES), liveBackupExecution),
  );
  const clusterReferences = (id: string) => and(
    sql`${clusterDatabase.status} <> 'deleted'`,
    or(sql`${clusterDatabase.config}->'backup'->>'destinationId' = ${id}`, sql`${clusterDatabase.restoreSource}->>'destinationId' = ${id}`),
  );
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
      return db.transaction(async (tx) => {
        const [current] = await tx.select().from(backupDestination).where(eq(backupDestination.id, id)).for("update");
        if (!current) return undefined;
        const moved = (["kind", "endpoint", "region", "bucket", "pathPrefix"] as const).some((key) => data[key] !== undefined && data[key] !== current[key]);
        if (moved && (await tx.select({ id: clusterDatabase.id }).from(clusterDatabase).where(clusterReferences(id)).limit(1)).length)
          throw new AppError("This destination contains a cluster database's recovery archives. Its storage address cannot be changed while that database or retained data exists.", 409, "CLUSTER_DATABASE_BACKUP_DESTINATION");
        const storageMoved = moved || (["serverId", "sshHost", "sshPort", "sshUser"] as const).some(key => data[key] !== undefined && data[key] !== current[key]);
        if (storageMoved && (await tx.select({ id: backupRun.id }).from(backupRun).where(runReferences(id)).limit(1)).length)
          throw new AppError("This destination contains backups or has a backup in progress. Create another destination and update the policy to use it; existing backups must keep their original storage address.", 409, "BACKUP_DESTINATION_IN_USE");
        const [row] = await tx.update(backupDestination).set({ ...data, updatedAt: new Date() }).where(eq(backupDestination.id, id)).returning();
        return row;
      });
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
      return db.transaction(async (tx) => {
        await tx.select({ id: backupDestination.id }).from(backupDestination).where(eq(backupDestination.id, id)).for("update");
        if ((await tx.select({ id: clusterDatabase.id }).from(clusterDatabase).where(clusterReferences(id)).limit(1)).length)
          return { ok: false, reason: "This destination is used by cluster database backups or a retained database. Remove those databases and retained data first." };
        if ((await tx.select({ id: backupRun.id }).from(backupRun).where(runReferences(id)).limit(1)).length)
          return { ok: false, reason: "This destination still holds retained backups or has a backup in progress. Keep it available so those backups can be restored." };
        const referencingCount = await tx
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

        await tx
          .update(backupDestination)
          .set({ deletedAt: new Date(), updatedAt: new Date() })
          .where(eq(backupDestination.id, id));
        return { ok: true };
      });
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
      const destination = await db.query.backupDestination.findFirst({ where: eq(backupDestination.id, data.destinationId) });
      if (!destination || destination.deletedAt)
        throw new AppError("Backup destination is no longer available", 409, "BACKUP_DESTINATION_UNAVAILABLE");
      const row = await withProjectWorkAdmission(db, data.projectId, destination.organizationId, async (tx) => {
        const [current] = await tx.select().from(backupDestination).where(eq(backupDestination.id, data.destinationId)).for("update");
        if (!current || current.deletedAt)
          throw new AppError("Backup destination is no longer available", 409, "BACKUP_DESTINATION_UNAVAILABLE");
        // Postgres considers NULL service IDs distinct. The project admission
        // lock also serializes creation of its single default policy, without
        // deleting any pre-existing rules to add a database constraint.
        if (data.projectId && !data.serviceId) {
          const [existing] = await tx.select({ id: backupPolicy.id }).from(backupPolicy).where(and(
            eq(backupPolicy.projectId, data.projectId), isNull(backupPolicy.serviceId), isNull(backupPolicy.deletedAt),
          )).limit(1);
          if (existing) throw new AppError("This project already has a backup policy. Edit the existing policy instead.", 409, "BACKUP_POLICY_EXISTS");
        }
        return (await tx.insert(backupPolicy).values(data).returning())[0]!;
      });
      if (!row) throw new AppError("Cannot create a backup policy: project is being deleted or no longer exists", 409, "PROJECT_UNAVAILABLE");
      return row;
    },

    async update(
      id: string,
      data: Partial<Omit<NewBackupPolicy, "id" | "createdAt">>,
    ): Promise<BackupPolicy | undefined> {
      return db.transaction(async (tx) => {
        if (data.destinationId !== undefined) {
          const [owner] = await tx
            .select({ organizationId: backupDestination.organizationId })
            .from(backupPolicy)
            .innerJoin(backupDestination, eq(backupDestination.id, backupPolicy.destinationId))
            .where(and(eq(backupPolicy.id, id), isNull(backupPolicy.deletedAt)));
          if (!owner) return undefined;
          // Destination deletion uses the same row lock. A service-level
          // precheck alone can otherwise save a policy onto deleted storage.
          const [destination] = await tx
            .select()
            .from(backupDestination)
            .where(eq(backupDestination.id, data.destinationId))
            .for("update");
          if (!destination || destination.deletedAt || destination.organizationId !== owner.organizationId) {
            throw new AppError("Backup destination is no longer available", 409, "BACKUP_DESTINATION_UNAVAILABLE");
          }
        }
        const [row] = await tx
          .update(backupPolicy)
          .set({ ...data, updatedAt: new Date() })
          .where(and(eq(backupPolicy.id, id), isNull(backupPolicy.deletedAt)))
          .returning();
        return row;
      });
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

export interface BackupRunListOptions {
  limit?: number;
  offset?: number;
  projectId?: string;
  serviceId?: string;
  mailServerId?: string;
  destinationId?: string;
  before?: string;
  active?: boolean;
}

export function createBackupRunRepo(db: Database) {
  return {
    /**
     * Org-scoped list — returns every run for the org, optionally
     * narrowed by project/service. Access already verified at the
     * route boundary.
     */
    async listByOrganization(
      organizationId: string,
      opts?: BackupRunListOptions,
    ): Promise<BackupRun[]> {
      const conditions = [
        eq(backupRun.organizationId, organizationId),
        isNull(backupRun.deletedAt),
      ];
      if (opts?.projectId) conditions.push(eq(backupRun.projectId, opts.projectId));
      if (opts?.serviceId) conditions.push(eq(backupRun.serviceId, opts.serviceId));
      if (opts?.mailServerId) conditions.push(eq(backupRun.mailServerId, opts.mailServerId));
      if (opts?.destinationId) conditions.push(eq(backupRun.destinationId, opts.destinationId));
      if (opts?.active) conditions.push(inArray(backupRun.status, IN_FLIGHT_RUN_STATUSES));
      if (opts?.before) {
        const cursorRun = alias(backupRun, "backup_cursor");
        const cursor = db.select({ startedAt: cursorRun.startedAt, id: cursorRun.id }).from(cursorRun).where(and(
          eq(cursorRun.id, opts.before), eq(cursorRun.organizationId, organizationId),
          opts.projectId ? eq(cursorRun.projectId, opts.projectId) : undefined,
          opts.serviceId ? eq(cursorRun.serviceId, opts.serviceId) : undefined,
          opts.mailServerId ? eq(cursorRun.mailServerId, opts.mailServerId) : undefined,
          opts.destinationId ? eq(cursorRun.destinationId, opts.destinationId) : undefined,
        ));
        // Keep the timestamp comparison in Postgres (including its precision).
        // A pruned cursor still works: retention soft-deletes its history row.
        conditions.push(sql`(${backupRun.startedAt}, ${backupRun.id}) < (${cursor})`);
      }
      return db.query.backupRun.findMany({
        where: and(...conditions),
        orderBy: (t, { desc }) => [desc(t.startedAt), desc(t.id)],
        limit: opts?.limit ?? 100,
        offset: opts?.offset ?? 0,
      });
    },

    /** Names for a bounded history page, even when its policy was removed or moved.
     *  Pagination and ownership use the same query as project backup history. */
    async listWithSources(organizationId: string, opts?: BackupRunListOptions) {
      const runs = await this.listByOrganization(organizationId, opts);
      if (!runs.length) return [];
      const sources = await db.select({
        id: backupRun.id,
        projectName: project.name,
        serviceName: service.name,
        mailServerName: mailServers.domain,
        destinationName: backupDestination.name,
      }).from(backupRun)
        .leftJoin(project, and(eq(project.id, backupRun.projectId), eq(project.organizationId, organizationId)))
        .leftJoin(service, and(eq(service.id, backupRun.serviceId), eq(service.projectId, project.id)))
        .leftJoin(servers, and(eq(servers.id, backupRun.mailServerId), eq(servers.organizationId, organizationId)))
        .leftJoin(mailServers, eq(mailServers.serverId, servers.id))
        .leftJoin(backupDestination, and(eq(backupDestination.id, backupRun.destinationId), eq(backupDestination.organizationId, organizationId)))
        .where(and(eq(backupRun.organizationId, organizationId), inArray(backupRun.id, runs.map((r) => r.id))));
      const names = new Map(sources.map((s) => [s.id, s]));
      return runs.map((run) => ({
        ...run,
        projectName: names.get(run.id)?.projectName ?? null,
        serviceName: names.get(run.id)?.serviceName ?? null,
        mailServerName: names.get(run.id)?.mailServerName ?? null,
        destinationName: names.get(run.id)?.destinationName ?? null,
      }));
    },

    async findById(id: string): Promise<BackupRun | undefined> {
      return db.query.backupRun.findFirst({
        where: eq(backupRun.id, id),
      });
    },

    async latestSucceededForSource(policyId: string, destinationId: string, serviceId: string | null, mailServerId: string | null): Promise<BackupRun | undefined> {
      return db.query.backupRun.findFirst({
        where: and(
          eq(backupRun.policyId, policyId), eq(backupRun.destinationId, destinationId),
          serviceId ? eq(backupRun.serviceId, serviceId) : isNull(backupRun.serviceId),
          mailServerId ? eq(backupRun.mailServerId, mailServerId) : isNull(backupRun.mailServerId),
          eq(backupRun.status, "succeeded"), isNull(backupRun.deletedAt),
        ),
        orderBy: [desc(backupRun.finishedAt), desc(backupRun.id)],
      });
    },

    /**
     * Most recent run (or aggregated batch summary for multi-service project policies)
     * for a policy, newest first. Used by the read-only backup-schedule view in the Jobs tab
     * and the Destination detail page to show last-run state.
     *
     * When a policy targets an entire project, triggering it fans out into multiple child
     * runs with the same batchId. This method finds the newest run, gathers only its exact
     * siblings, and returns a consolidated summary with total transferred bytes and batch
     * status. Legacy rows have no batchId and retain the former single-run behavior because
     * timestamp proximity cannot safely distinguish concurrent triggers.
     */
    async latestByPolicy(policyId: string, destinationId?: string): Promise<PolicyLastRunSummary | undefined> {
      const latest = await db.query.backupRun.findFirst({
        where: and(
          eq(backupRun.policyId, policyId), isNull(backupRun.deletedAt),
          destinationId ? eq(backupRun.destinationId, destinationId) : undefined,
        ),
        orderBy: (t, { desc }) => [desc(t.startedAt), desc(t.id)],
      });
      if (!latest) return undefined;

      const singleRunSummary = (): PolicyLastRunSummary => ({
        id: latest.id,
        status: latest.status,
        startedAt: latest.startedAt,
        finishedAt: latest.finishedAt,
        bytesTransferred: latest.bytesTransferred,
      });
      const batchId = latest.batchId;
      if (!batchId) return singleRunSummary();

      const batchRuns = await db.query.backupRun.findMany({
        where: and(
          eq(backupRun.policyId, policyId),
          eq(backupRun.batchId, batchId),
          isNull(backupRun.deletedAt),
          destinationId ? eq(backupRun.destinationId, destinationId) : undefined,
        ),
      });

      if (batchRuns.length <= 1) return singleRunSummary();

      const earliestStartedAt = new Date(Math.min(...batchRuns.map((r) => r.startedAt.getTime())));

      // Pick the least-advanced live child so the summary does not imply that
      // the whole batch has progressed farther than its slowest member.
      const inFlightStatus = IN_FLIGHT_RUN_STATUSES.find((status) =>
        batchRuns.some((r) => r.status === status),
      );
      const hasUnfinishedRun = !!inFlightStatus || batchRuns.some((r) => !r.finishedAt);

      const latestFinishedAt = hasUnfinishedRun
        ? null
        : new Date(Math.max(...batchRuns.map((r) => r.finishedAt!.getTime())));

      let batchStatus: string;
      if (inFlightStatus) {
        batchStatus = inFlightStatus;
      } else if (batchRuns.every((r) => r.status === "succeeded")) {
        batchStatus = "succeeded";
      } else {
        batchStatus =
          (["server_error", "failed", "cancelled"] as const).find((status) =>
            batchRuns.some((r) => r.status === status),
          ) ?? latest.status;
      }

      const knownByteCounts = batchRuns
        .map((r) => r.bytesTransferred)
        .filter((bytes): bytes is number => bytes !== null);
      const totalBytes =
        knownByteCounts.length > 0
          ? knownByteCounts.reduce((sum, bytes) => sum + Number(bytes), 0)
          : null;

      return {
        id: latest.id,
        status: batchStatus,
        startedAt: earliestStartedAt,
        finishedAt: latestFinishedAt,
        bytesTransferred: totalBytes,
      };
    },

    /** Storage and run outcomes per destination for one org. Retained successful
     *  backups are distinct from attempts, which may still be running or failed. */
    async statsByDestination(organizationId: string): Promise<
      Array<{
        destinationId: string | null;
        storedBytes: number;
        runCount: number;
        lastRunAt: Date | null;
        savedCount: number;
        activeCount: number;
        failedCount: number;
        cancelledCount: number;
      }>
    > {
      const rows = await db
        .select({
          destinationId: backupRun.destinationId,
          storedBytes: sql<number>`coalesce(sum(case when ${backupRun.status} = 'succeeded' then ${backupRun.bytesTransferred} else 0 end), 0)`,
          runCount: sql<number>`count(*)`,
          // Use the column's UTC decoder. Parsing a raw timestamp string with
          // new Date() shifts it by the control-plane machine's local timezone.
          lastRunAt: sql<Date | null>`max(${backupRun.startedAt})`.mapWith(backupRun.startedAt),
          savedCount: sql<number>`count(*) filter (where ${backupRun.status} = 'succeeded')`,
          activeCount: sql<number>`count(*) filter (where ${inArray(backupRun.status, IN_FLIGHT_RUN_STATUSES)})`,
          failedCount: sql<number>`count(*) filter (where ${backupRun.status} in ('failed', 'server_error'))`,
          cancelledCount: sql<number>`count(*) filter (where ${backupRun.status} = 'cancelled')`,
        })
        .from(backupRun)
        .where(and(eq(backupRun.organizationId, organizationId), isNull(backupRun.deletedAt)))
        .groupBy(backupRun.destinationId);
      // Blocks may outlive the run that first uploaded them. Count physical
      // objects referenced by live snapshots, once per destination, rather
      // than summing transfer counters from runs that retention has removed.
      const objects = new Map<string, Map<string, number>>();
      const legacyBytes = new Map<string, number>();
      for (let offset = 0; ; offset += 500) {
        const page = await db.select({ destinationId: backupRun.destinationId, artifacts: backupRun.artifacts, bytesTransferred: backupRun.bytesTransferred })
          .from(backupRun)
          .where(and(eq(backupRun.organizationId, organizationId), eq(backupRun.status, "succeeded"), isNull(backupRun.deletedAt)))
          .orderBy(backupRun.id).limit(500).offset(offset);
        for (const run of page) {
          if (!run.destinationId) continue;
          // Older runs may only have the transfer counter. Keep that estimate
          // alongside the physical-object total for newer restore points.
          if (!run.artifacts?.length) {
            legacyBytes.set(run.destinationId, (legacyBytes.get(run.destinationId) ?? 0) + (Number(run.bytesTransferred) || 0));
            continue;
          }
          const stored = objects.get(run.destinationId) ?? new Map<string, number>();
          for (const artifact of (run.artifacts ?? []) as StoredBackupArtifact[]) {
            for (const [key, size] of backupArtifactObjects(artifact)) stored.set(key, Number(size) || 0);
          }
          objects.set(run.destinationId, stored);
        }
        if (page.length < 500) break;
      }
      return rows.map((r) => ({
        destinationId: r.destinationId,
        storedBytes: r.destinationId && objects.has(r.destinationId)
          ? [...objects.get(r.destinationId)!.values()].reduce((sum, bytes) => sum + bytes, legacyBytes.get(r.destinationId) ?? 0)
          : Number(r.storedBytes) || 0,
        runCount: Number(r.runCount) || 0,
        lastRunAt: r.lastRunAt ?? null,
        savedCount: Number(r.savedCount) || 0,
        activeCount: Number(r.activeCount) || 0,
        failedCount: Number(r.failedCount) || 0,
        cancelledCount: Number(r.cancelledCount) || 0,
      }));
    },

    /**
     * Every run that can still mutate project resources.
     *
     * The execution lease intentionally outlives a terminal FSM outcome. A
     * heartbeat sweep may record `server_error` while the original upload is
     * still unwinding; teardown must continue to see that worker until its
     * outermost finally acknowledges completion.
     */
    async listInFlightByProject(projectId: string): Promise<BackupRun[]> {
      return db.query.backupRun.findMany({
        where: and(
          eq(backupRun.projectId, projectId),
          or(inArray(backupRun.status, IN_FLIGHT_RUN_STATUSES), liveBackupExecution),
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
        where: and(eq(backupRun.status, "queued"), isNull(backupRun.executionStartedAt)),
        orderBy: (t, { asc }) => [asc(t.startedAt)],
        limit,
      });
    },

    async create(data: NewBackupRun): Promise<BackupRun> {
      return (await this.createBatch([data]))[0]!;
    },

    /** All services in one request are admitted before any worker can start. */
    async createBatch(data: NewBackupRun[]): Promise<BackupRun[]> {
      if (data.length === 0) return [];
      const organizationId = data[0]!.organizationId;
      if (data.some(row => row.organizationId !== organizationId))
        throw new AppError("A backup batch must belong to one organization", 400, "BACKUP_SCOPE_MISMATCH");
      const rows = await withProjectWorkAdmission(
        db,
        data.flatMap(row => row.projectId ? [row.projectId] : []),
        organizationId,
        async (tx) => {
          const ids = [...new Set(data.flatMap(row => row.destinationId ? [row.destinationId] : []))].sort();
          if (ids.length) {
            const destinations = await tx.select().from(backupDestination).where(inArray(backupDestination.id, ids))
              .orderBy(backupDestination.id).for("update");
            if (destinations.length !== ids.length || destinations.some(row => row.deletedAt || row.organizationId !== organizationId))
              throw new AppError("Backup destination is no longer available", 409, "BACKUP_DESTINATION_UNAVAILABLE");
          }
          return tx.insert(backupRun).values(data).returning();
        },
      );
      if (!rows) {
        throw new Error("Cannot start backup: project is being deleted or no longer exists");
      }
      return rows;
    },

    /**
     * Atomically give exactly one worker ownership of a queued run.
     *
     * The project row is locked through the same admission gate used by run
     * creation. If execution wins, project deletion waits and then observes the
     * newly-opened lease. If deletion wins, its predicate is re-evaluated after
     * the wait and no worker starts. The backup-row predicates also make an
     * in-process fast path, poller, BullMQ retry, and inline enqueue fallback all
     * converge on one owner.
     */
    async claimExecution(
      id: string,
      projectId: string | null,
      organizationId: string,
    ): Promise<BackupRunExecutionClaim> {
      const claimed = await withProjectWorkAdmission(db, projectId, organizationId, async (tx) => {
        const now = new Date();
        const projectMatches = projectId
          ? eq(backupRun.projectId, projectId)
          : isNull(backupRun.projectId);
        const [row] = await tx
          .update(backupRun)
          .set({
            status: "preparing",
            executionStartedAt: now,
            executionFinishedAt: null,
            lastEventAt: now,
          })
          .where(
            and(
              eq(backupRun.id, id),
              eq(backupRun.organizationId, organizationId),
              projectMatches,
              eq(backupRun.status, "queued"),
              isNull(backupRun.executionStartedAt),
              isNull(backupRun.executionFinishedAt),
              isNull(backupRun.deletedAt),
            ),
          )
          .returning();
        return Boolean(row);
      });
      if (claimed === undefined) return "project_unavailable";
      return claimed ? "claimed" : "state_changed";
    },

    /**
     * Cancel a queued run before any worker owns it.
     *
     * Project teardown has already closed work admission when it calls this.
     * This CAS races safely with `claimExecution`: exactly one side can change
     * the queued/unclaimed row. A claimed capture is deliberately untouched;
     * teardown must wait for that worker's execution lease to close.
     */
    async cancelQueuedBeforeExecution(
      id: string,
      projectId: string,
      organizationId: string,
    ): Promise<boolean> {
      const now = new Date();
      const [cancelled] = await db
        .update(backupRun)
        .set({
          status: "cancelled",
          finishedAt: now,
          lastEventAt: now,
        })
        .where(
          and(
            eq(backupRun.id, id),
            eq(backupRun.projectId, projectId),
            eq(backupRun.organizationId, organizationId),
            eq(backupRun.status, "queued"),
            isNull(backupRun.executionStartedAt),
            isNull(backupRun.executionFinishedAt),
            isNull(backupRun.deletedAt),
          ),
        )
        .returning();
      return Boolean(cancelled);
    },

    /**
     * Close the durable execution lease. This is intentionally separate from
     * every status transition and is called only by the worker's outermost
     * finally, after all source/destination cleanup and notifications return.
     */
    async acknowledgeExecutionFinished(id: string): Promise<void> {
      await db
        .update(backupRun)
        .set({ executionFinishedAt: new Date() })
        .where(and(eq(backupRun.id, id), liveBackupExecution));
    },

    /** FSM state transition. Always bumps lastEventAt; sets finishedAt
     *  on terminal states. Status is written separately from the patch — see
     *  persistTransition for why the two must not fail as a unit. */
    async transition(
      id: string,
      status: BackupRunStatus,
      patch?: Partial<
        Omit<NewBackupRun, "id" | "startedAt" | "executionStartedAt" | "executionFinishedAt">
      >,
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
      return db.transaction(async (tx) => {
        const now = new Date();
        const terminalized = await tx
          .update(backupRun)
          .set({
            status: "server_error",
            finishedAt: now,
            lastEventAt: now,
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

        // This method is boot-only and only called for a self-hosted,
        // single-process installation. Process start is therefore proof that
        // the previous in-process worker is gone. Unlike heartbeat sweeps, this
        // is allowed to close an orphaned execution lease. Preserve any terminal
        // verdict that landed just before the crash by keeping this a separate
        // lease-only write.
        const acknowledged = await tx
          .update(backupRun)
          .set({ executionFinishedAt: now })
          .where(liveBackupExecution)
          .returning();

        return new Set([...terminalized, ...acknowledged].map((row) => row.id)).size;
      });
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
      const row = await withProjectWorkAdmission(
        db,
        data.projectId,
        data.organizationId,
        async (tx) => (await tx.insert(backupRestore).values(data).returning())[0]!,
      );
      if (!row) {
        throw new Error("Cannot start restore: project is being deleted or no longer exists");
      }
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

    /**
     * Atomically admit one destructive restore per target. Project services
     * share a gate because they may share volumes. Mail restores lock the actual
     * target server, including when the backup originated on another server.
     *
     * A restore row is created during prepare, potentially hours before the
     * operator applies it, so creation-time work admission is not enough. This
     * update must take the same project-row lock as `project.claimDeletion()`:
     * if apply wins, teardown's in-lock active query sees `applying`; if delete
     * wins, apply is refused. The cancel predicate also prevents a durable
     * cancel request from being crossed by a late apply transition.
     */
    async claimApply(
      id: string,
      projectId: string | null,
      organizationId: string,
    ): Promise<BackupRestoreApplyClaim> {
      const projectMatches = projectId
        ? eq(backupRestore.projectId, projectId)
        : isNull(backupRestore.projectId);
      const eligible = and(
        eq(backupRestore.id, id),
        eq(backupRestore.organizationId, organizationId),
        projectMatches,
        eq(backupRestore.status, "prepared"),
        eq(backupRestore.cancelRequested, false),
      );
      // Match resolveTarget's mode semantics: a missing fork must never fall
      // back to overwriting the source server, nor may an unused fork redirect
      // an in-place restore's gate.
      const mailTarget = sql<string | null>`case when ${backupRestore.mode} = 'to_fork'
        then ${backupRestore.forkMailServerId} else ${backupRun.mailServerId} end`;
      const claim = await withProjectWorkAdmission<BackupRestoreApplyClaim>(
        db,
        projectId,
        organizationId,
        async (tx) => {
          const [candidate] = await tx
            .select({
              mailServerId: mailTarget,
              sourceKind: backupRun.sourceKind,
              sourceOrganizationId: backupRun.organizationId,
            })
            .from(backupRestore)
            .leftJoin(backupRun, eq(backupRun.id, backupRestore.runId))
            .where(eligible);
          if (!candidate) return "state_changed";

          if (!projectId) {
            if (
              candidate.sourceKind !== "mail_server" ||
              candidate.sourceOrganizationId !== organizationId ||
              !candidate.mailServerId
            ) {
              return "target_unavailable";
            }
            const [target] = await tx
              .select({ id: mailServers.serverId })
              .from(mailServers)
              .innerJoin(servers, eq(servers.id, mailServers.serverId))
              .where(
                and(
                  eq(mailServers.serverId, candidate.mailServerId),
                  eq(servers.organizationId, organizationId),
                ),
              )
              .for("update", { of: mailServers });
            if (!target) return "target_unavailable";
          }

          // The project/mail row lock MUST precede this read. Locking only the
          // requested restore would still admit two different backup rows.
          const [active] = await tx
            .select({ id: backupRestore.id })
            .from(backupRestore)
            .leftJoin(backupRun, eq(backupRun.id, backupRestore.runId))
            .where(
              and(
                eq(backupRestore.status, "applying"),
                ne(backupRestore.id, id),
                projectId
                  ? eq(backupRestore.projectId, projectId)
                  : and(
                      eq(backupRun.sourceKind, "mail_server"),
                      eq(mailTarget, candidate.mailServerId!),
                    ),
              ),
            )
            .limit(1);
          if (active) return "target_busy";

          const rows = await tx
            .update(backupRestore)
            .set({ status: "applying", lastEventAt: new Date() })
            .where(eligible)
            .returning();
          return rows.length === 1 ? "claimed" : "state_changed";
        },
      );
      return claim ?? "project_unavailable";
    },

    async transition(
      id: string,
      status: BackupRestoreStatus,
      patch?: Partial<Omit<NewBackupRestore, "id" | "userId" | "startedAt">>,
    ): Promise<boolean> {
      const TERMINAL: BackupRestoreStatus[] = ["succeeded", "failed", "cancelled", "server_error"];
      const finishing = TERMINAL.includes(status);
      const now = new Date();
      return persistTransition(
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
