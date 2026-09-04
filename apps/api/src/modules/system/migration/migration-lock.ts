/**
 * Transactional quiesce for team-mode migrations.
 *
 * Every migration entry point (start, start-cloud, start-tunnel, switch-back)
 * wraps its work in withMigrationLock so the local instance refuses
 * mutations and pauses background workers during the cutover window.
 *
 * Why this exists:
 *   The cutover takes 30-90s — long enough for a teammate's deploy job to
 *   land in BullMQ, or for the operator to click "save" on a settings
 *   form, AFTER the dump was taken but BEFORE the remote takes over.
 *   Without quiesce those writes either silently disappear (data loss)
 *   or land in a DB that's no longer authoritative (data divergence).
 *
 * Acquire is a compare-and-swap on instance_settings.migration_in_progress.
 * Two operators clicking Migrate at the same moment will see exactly one
 * succeed and the other get MigrationAlreadyInProgressError (409).
 *
 * Stale-lock recovery: if migration_started_at is older than 10 minutes,
 * the next acquire attempt steals the lock — protects against a previous
 * migration process that crashed mid-flight and left the flag set.
 *
 * The finally block ALWAYS releases. On success the dashboard switches
 * to the MigratedLauncher anyway; on failure the operator can retry.
 * Workers always resume — on Path C (tunnel) the local API stays live
 * and needs them, on Paths A/B teamMode flips so the launcher takes
 * over before any worker would actually do anything.
 */

import { db, sql, type DatabaseTransaction } from "@repo/db";
import { getJobRunner } from "../../../lib/job-runner";

export class MigrationAlreadyInProgressError extends Error {
  readonly code = "MIGRATION_IN_PROGRESS" as const;
  constructor() {
    super(
      "Another migration is already in flight on this instance. Wait for it to finish, or try again in 10 minutes if you think it's stuck.",
    );
    this.name = "MigrationAlreadyInProgressError";
  }
}

export class MigrationLockAcquireError extends Error {
  readonly code = "MIGRATION_LOCK_ACQUIRE_FAILED" as const;
  constructor(reason: string) {
    super(`Could not acquire the migration lock: ${reason}`);
    this.name = "MigrationLockAcquireError";
  }
}

const STALE_LOCK_THRESHOLD = "10 minutes";

/**
 * Compare-and-swap acquire. Returns true iff THIS call obtained the lock.
 * Atomically takes the lock when either:
 *   - migration_in_progress is false, OR
 *   - migration_in_progress is true but migration_started_at is stale
 *     (older than STALE_LOCK_THRESHOLD — recovers from a crashed process).
 */
async function tryAcquireLock(): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE instance_settings
    SET migration_in_progress = true,
        migration_started_at = NOW(),
        updated_at = NOW()
    WHERE id = 'default'
      AND (
        migration_in_progress = false
        OR migration_started_at < NOW() - INTERVAL '${sql.raw(STALE_LOCK_THRESHOLD)}'
      )
    RETURNING id
  `);
  // drizzle wraps pg result; the rows array has length 1 if we took the lock.
  const rows = (result as unknown as { rows?: unknown[] }).rows ?? (result as unknown as unknown[]);
  return Array.isArray(rows) ? rows.length > 0 : false;
}

/** Best-effort release. Idempotent — safe to call even if the row was never locked. */
async function releaseLock(): Promise<void> {
  await db.execute(sql`
    UPDATE instance_settings
    SET migration_in_progress = false,
        migration_started_at = NULL,
        updated_at = NOW()
    WHERE id = 'default'
  `);
}

/**
 * Keep the quiesce flag alive when a destructive restore replaces the
 * instance_settings row that originally held it. Call this as the final write
 * in the restore transaction: once that transaction commits, mutation requests
 * must remain blocked until post-commit process state has been reconciled.
 */
export async function reassertMigrationLockAfterRestore(tx: DatabaseTransaction): Promise<void> {
  const result = await tx.execute(sql`
    UPDATE instance_settings
    SET migration_in_progress = true,
        migration_started_at = NOW(),
        updated_at = NOW()
    WHERE id = 'default'
    RETURNING id
  `);
  const rows = (result as unknown as { rows?: unknown[] }).rows ?? (result as unknown as unknown[]);
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new Error("The restored instance settings row is missing; the migration lock was lost.");
  }
}

/**
 * Wrap a migration body in the quiesce protocol.
 *
 * Order of operations:
 *   1. Compare-and-swap acquire — throw if another migration is live.
 *   2. Pause the job runner so background workers stop picking new jobs.
 *      (In-flight jobs finish — pause is graceful, not abrupt.)
 *   3. Run the body.
 *   4. ALWAYS resume workers and release the lock (finally), so a
 *      partial failure can't leave the operator permanently locked out.
 *
 * Throws MigrationAlreadyInProgressError if the lock can't be obtained.
 * Re-throws whatever the body throws.
 *
 * NOTE on the pause/resume feature-check below:
 *   The current JobRunner interface (apps/api/src/lib/job-runner/types.ts)
 *   does not expose pause/resume — backup jobs are the only workload it
 *   manages and they're rare enough that mid-migration interference is
 *   unlikely. We still feature-check pauseAll/pause and resumeAll/resume
 *   at runtime so a future runner extension automatically gets
 *   quiesced without touching this file, and so that today's no-op
 *   degrades gracefully (the mutation-guard middleware is the real
 *   defense — this is belt-and-braces).
 */
export async function withMigrationLock<T>(fn: () => Promise<T>): Promise<T> {
  let acquired: boolean;
  try {
    acquired = await tryAcquireLock();
  } catch (err) {
    // The compare-and-swap UPDATE never committed, so no lock leak.
    // Wrap the raw drizzle/pg error in a typed error so the controller
    // surfaces a clean 503 instead of a raw 500 with a stack trace.
    throw new MigrationLockAcquireError(err instanceof Error ? err.message : String(err));
  }
  if (!acquired) {
    throw new MigrationAlreadyInProgressError();
  }

  let pausedRunner: Awaited<ReturnType<typeof getJobRunner>> | null = null;
  try {
    try {
      pausedRunner = await getJobRunner();
      // Today's JobRunner interface has neither pauseAll nor pause; the
      // typeof checks make this a safe no-op. Left in place so a future
      // pause/resume extension to the runner gets picked up automatically.
      if (typeof (pausedRunner as { pauseAll?: () => Promise<void> }).pauseAll === "function") {
        await (pausedRunner as unknown as { pauseAll: () => Promise<void> }).pauseAll();
      } else if (typeof (pausedRunner as { pause?: () => Promise<void> }).pause === "function") {
        await (pausedRunner as unknown as { pause: () => Promise<void> }).pause();
      }
    } catch (err) {
      // Don't fail the migration just because pause didn't take — the
      // mutation-guard already keeps user-driven writes out, and
      // BullMQ jobs writing during migration are rare (no deploys mid-flight).
      console.warn("[migration-lock] job-runner pause failed:", err);
    }

    return await fn();
  } finally {
    if (pausedRunner) {
      try {
        if (typeof (pausedRunner as { resumeAll?: () => Promise<void> }).resumeAll === "function") {
          await (pausedRunner as unknown as { resumeAll: () => Promise<void> }).resumeAll();
        } else if (
          typeof (pausedRunner as { resume?: () => Promise<void> }).resume === "function"
        ) {
          await (pausedRunner as unknown as { resume: () => Promise<void> }).resume();
        }
      } catch (err) {
        console.warn("[migration-lock] job-runner resume failed:", err);
      }
    }
    try {
      await releaseLock();
    } catch (err) {
      // Stale-lock recovery on the NEXT acquire saves us here, so
      // we don't crash the migration response just because the
      // release UPDATE failed.
      console.warn("[migration-lock] release failed; relying on stale-lock recovery:", err);
    }
  }
}

/** Read-only check — used by the guard middleware. */
export async function isMigrationInProgress(): Promise<boolean> {
  const row = await db.execute(sql`
    SELECT migration_in_progress AS in_progress
    FROM instance_settings
    WHERE id = 'default'
  `);
  const rows =
    (row as unknown as { rows?: Array<{ in_progress?: boolean }> }).rows ??
    (row as unknown as Array<{ in_progress?: boolean }>);
  if (!Array.isArray(rows) || rows.length === 0) return false;
  return rows[0]?.in_progress === true;
}
