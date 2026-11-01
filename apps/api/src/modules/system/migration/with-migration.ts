/**
 * `withMigration` — the audit/lock/upsert invariant wrapper for every
 * team-mode migration entry point.
 *
 * ─── Why this exists ──────────────────────────────────────────────────
 *
 * Every migration service (migrate-instance, migrate-to-cloud,
 * migrate-to-tunnel, switch-back) has the same
 * surrounding ceremony:
 *
 *   1. acquire the migration lock (compare-and-swap quiesce)
 *   2. read previousMode atomically inside the lock so the audit's
 *      `before` reflects the actual committed state at the moment we
 *      took the lock (not whatever the controller saw a few ms earlier)
 *   3. run the path-specific body (dump / scp / restore / call SaaS / …)
 *   4. on success — upsert instance_settings with the new teamMode
 *      + migrationTargetUrl + migrationServerId + …
 *   5. on success — emit an "instance.migrated" or "instance.switched-back"
 *      audit event REFLECTING the upserted state (so the audit row's
 *      `after` is what the DB actually holds, never what we *meant* to
 *      write)
 *   6. on failure — emit a failure audit event with the typed error
 *      code + message and re-throw; lock is always released by the inner
 *      withMigrationLock's finally block
 *
 * The audit's "invariants, not shape" principle:
 *
 *   The five services each have very different SHAPES — VPS SSH dance,
 *   SaaS HTTP ingest, tunnel provisioning, reverse data pull, raw db
 *   restore — and trying to abstract their internals into one
 *   "migration engine" would force every path into an awkward fit.
 *
 *   What they DO share is a fixed set of INVARIANTS at the boundary:
 *
 *     - exactly one lock acquire per attempt (no double-acquire, no
 *       missed-release)
 *     - exactly one settings upsert per success (so the launcher
 *       flips at a single, observable instant)
 *     - exactly one success-or-failure audit event per attempt
 *       (so the audit log is a complete, gap-free record of every
 *       cutover the operator initiates — required for the 30-day
 *       grace-period purge job that reads this log to decide what
 *       remote data is safe to delete)
 *     - the audit's `after` block reflects the COMMITTED settings row
 *       (upsert happens BEFORE the success audit emit)
 *
 *   `withMigration` enforces those invariants without touching the
 *   per-path body. The services keep their typed errors, their custom
 *   dump/restore logic, their wizard-specific result shapes — only the
 *   wrapping moves into one place.
 *
 * Services opt in INDIVIDUALLY — there's no controller-level magic and
 * no change to their public signatures. The helper is internal
 * infrastructure that each service composes the way it composes
 * `withMigrationLock` today.
 */

import type { Context } from "hono";
import { audit, auditContextFrom, type AuditContext } from "../../../lib/audit";
import { withMigrationLock } from "./migration-lock";
import { repos } from "@repo/db";
import type { NewInstanceSettings } from "@repo/db/repos";

// ─── Discriminators ─────────────────────────────────────────────────────────

/**
 * Direction of the cutover. Drives the audit `eventType`:
 *
 *   forward → "instance.migrated"      (single_user → multi-user target)
 *   reverse → "instance.switched-back" (multi-user target → single_user)
 *
 * Forward includes all three forward paths (A self-hosted, B cloud,
 * C tunneled); reverse handles the corresponding switch-back regardless
 * of which forward path put the instance into its current mode.
 */
export type MigrationDirection = "forward" | "reverse";

/**
 * Which physical path is being run. Embedded in the audit payload so
 * the purge job (and any future analytics) can distinguish a SSH-based
 * VPS migration from a SaaS ingest from a tunnel flip without parsing
 * the before/after teamMode pair.
 */
export type MigrationVariant =
  | "self-hosted-remote"
  | "cloud-hosted"
  | "tunneled";

/** Mirrors instance_settings.team_mode — kept local to avoid a cross-pkg type churn. */
export type TeamMode =
  | "single_user"
  | "self_hosted_remote"
  | "cloud_hosted"
  | "tunneled";

// ─── Audit event types ──────────────────────────────────────────────────────

/**
 * The two audit event types this helper ever emits, exported so call
 * sites and the purge job can refer to them by symbol rather than by
 * stringly-typed literal.
 */
export const MIGRATION_AUDIT_EVENT = {
  forward: "instance.migrated",
  reverse: "instance.switched-back",
} as const;

export type MigrationAuditEventType =
  (typeof MIGRATION_AUDIT_EVENT)[keyof typeof MIGRATION_AUDIT_EVENT];

// ─── Public types ───────────────────────────────────────────────────────────

/**
 * The fields a body is allowed to overwrite on instance_settings as
 * part of a successful migration. Constrained to the migration-related
 * columns so a body can't accidentally clobber unrelated settings.
 */
export type MigrationSettingsPatch = Pick<
  NewInstanceSettings,
  | "teamMode"
  | "migrationTargetUrl"
  | "migrationServerId"
  | "migratedAt"
  | "tunnelSlug"
  | "tunnelId"
>;

/**
 * What every migration service hands to `withMigration` to identify
 * itself. The helper uses these to:
 *   - resolve the audit `eventType` (from `direction`)
 *   - tag the audit `after` block with the path (`variant`)
 *   - build the `AuditContext` from the Hono Context + actor/org ids
 */
export interface MigrationInvocation<TInput> {
  /**
   * Forward (single_user → target) or reverse (target → single_user).
   * Drives the eventType the helper emits.
   */
  direction: MigrationDirection;
  /**
   * Which physical path this is. Goes into the audit payload — does
   * NOT need to match the teamMode the body writes (tunneled forward
   * and tunneled reverse both use "tunneled" here).
   */
  variant: MigrationVariant;
  /**
   * Hono Context for the originating HTTP request — used to extract
   * the IP + user-agent for the audit row.
   */
  c: Context;
  organizationId: string;
  userId: string;
  /**
   * The service's typed input row, surfaced back to the body via
   * `ctx.input` so the body doesn't have to thread it through manually.
   * Carrying it here also means the helper can include selected input
   * fields in the audit if we choose to extend the schema later.
   */
  input: TInput;
}

/**
 * The context the body receives. `previousMode` is read INSIDE the
 * lock — the body MUST use this value rather than re-reading
 * instance_settings, so the audit's `before` matches what the rest of
 * the body saw.
 */
export interface MigrationContext<TInput> {
  /** teamMode at the moment we acquired the lock. */
  previousMode: TeamMode;
  /** The full settings row read inside the lock (may be undefined on a fresh install). */
  previousSettings: Awaited<ReturnType<typeof repos.instanceSettings.get>>;
  /** The service's typed input — same object the caller passed in. */
  input: TInput;
  /** Pre-built audit context — kept on the ctx so bodies don't re-derive it. */
  auditCtx: AuditContext;
}

/**
 * What the body returns on success. The `settings` patch is upserted
 * BEFORE the success audit event is emitted, so the audit's `after`
 * block always reflects committed DB state.
 */
export interface MigrationFinale<TResult> {
  /**
   * Fields to write on instance_settings. Helper performs the upsert
   * — body must NOT upsert itself, or the success audit will race the
   * write.
   */
  settings: MigrationSettingsPatch;
  /**
   * The service's typed result, returned verbatim to the caller of
   * `withMigration`.
   */
  result: TResult;
  /**
   * Optional extra fields merged into the audit `after` payload
   * (e.g. rowsRestored, importedTables, strippedEncryptedFields).
   * Helper always includes the settings patch + variant; this is for
   * service-specific forensics on top.
   */
  auditAfter?: Record<string, unknown>;
  /**
   * Optional extra fields merged into the audit `before` payload on
   * top of `{ teamMode: previousMode }`. Useful when the service wants
   * to record the URL the instance USED to point at (switch-back does
   * this with `previousUrl`).
   */
  auditBefore?: Record<string, unknown>;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function errorCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ─── The wrapper ────────────────────────────────────────────────────────────

/**
 * Run a migration body under the lock, with previousMode captured
 * atomically, the settings upsert committed before the success audit
 * fires, and a failure audit emitted on any thrown error.
 *
 * Order on success:
 *   1. withMigrationLock acquires + quiesces
 *   2. read previousMode + previousSettings inside the lock
 *   3. emit "started" sub-audit (best-effort, fire-and-forget)
 *   4. body runs with typed ctx
 *   5. repos.instanceSettings.upsert(finale.settings)
 *   6. emit success audit with the COMMITTED settings as `after`
 *   7. withMigrationLock's finally releases the lock + resumes workers
 *   8. helper returns finale.result
 *
 * Order on body failure:
 *   1-4 as above
 *   5. emit failure audit with the typed error code + message
 *   6. withMigrationLock's finally releases the lock
 *   7. error is re-thrown to the caller (preserving its type so the
 *      controller's existing error-mapping still works)
 *
 * The wrapper deliberately does NOT swallow errors and does NOT catch
 * the upsert failure separately — if the upsert throws, the operator's
 * remote work is still done but the local row is out of sync, and the
 * loud failure is the right signal (vs silently leaving the operator
 * thinking the migration succeeded). The thrown error from the upsert
 * is captured in the failure audit before being re-thrown.
 */
export async function withMigration<TInput, TResult>(
  invocation: MigrationInvocation<TInput>,
  body: (ctx: MigrationContext<TInput>) => Promise<MigrationFinale<TResult>>,
): Promise<TResult> {
  const eventType = MIGRATION_AUDIT_EVENT[invocation.direction];
  const auditCtx = auditContextFrom(
    invocation.c,
    invocation.organizationId,
    invocation.userId,
  );

  return withMigrationLock(async () => {
    // ── 1. Read previousMode atomically inside the lock. The body MUST
    //       consume `ctx.previousMode` rather than re-reading, so the
    //       audit's `before` and the body's branching see the same value.
    const previousSettings = await repos.instanceSettings.get();
    const previousMode = (previousSettings?.teamMode ?? "single_user") as TeamMode;

    // ── 2. Best-effort "started" breadcrumb. Fire-and-forget so a
    //       failed audit insert can't take down the migration.
    audit.recordAsync(auditCtx, {
      eventType,
      resourceType: "instance-settings",
      resourceId: "default",
      before: { teamMode: previousMode, phase: "started", variant: invocation.variant },
    });

    let finale: MigrationFinale<TResult>;
    try {
      finale = await body({
        previousMode,
        previousSettings,
        input: invocation.input,
        auditCtx,
      });
    } catch (err) {
      // ── 3a. Body failed. Emit a failure audit with whatever typed
      //        error info we can extract, then re-throw so the
      //        controller maps it to the right HTTP status.
      audit.recordAsync(auditCtx, {
        eventType,
        resourceType: "instance-settings",
        resourceId: "default",
        before: { teamMode: previousMode, variant: invocation.variant },
        after: {
          phase: "failed",
          variant: invocation.variant,
          errorCode: errorCode(err) ?? "UNKNOWN",
          errorMessage: errorMessage(err),
        },
      });
      throw err;
    }

    // ── 3b. Body succeeded. Commit the settings upsert FIRST so the
    //        success audit's `after` block reflects DB state, not
    //        intent. If this throws, capture the failure in the audit
    //        before re-raising — the remote/cloud work is already done
    //        but the local row is out of sync, and a loud failure is
    //        the right signal.
    try {
      await repos.instanceSettings.upsert(finale.settings);
    } catch (err) {
      audit.recordAsync(auditCtx, {
        eventType,
        resourceType: "instance-settings",
        resourceId: "default",
        before: { teamMode: previousMode, variant: invocation.variant },
        after: {
          phase: "settings-upsert-failed",
          variant: invocation.variant,
          attemptedSettings: finale.settings,
          errorCode: errorCode(err) ?? "UNKNOWN",
          errorMessage: errorMessage(err),
        },
      });
      throw err;
    }

    // ── 4. Success audit. `after` carries the committed settings
    //       patch + the variant + any service-specific extras.
    audit.recordAsync(auditCtx, {
      eventType,
      resourceType: "instance-settings",
      resourceId: "default",
      before: {
        teamMode: previousMode,
        ...(finale.auditBefore ?? {}),
      },
      after: {
        variant: invocation.variant,
        ...finale.settings,
        ...(finale.auditAfter ?? {}),
      },
    });

    return finale.result;
  });
}
