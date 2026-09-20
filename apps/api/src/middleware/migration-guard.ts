/**
 * Refuses mutation requests (POST/PATCH/PUT/DELETE) while a team-mode
 * migration is in flight on this instance. Reads the lock from
 * instance_settings.migration_in_progress, set by withMigrationLock.
 *
 * Self-hosted only. The SaaS side (CLOUD_MODE=true) is the *destination*
 * of migrations — nothing ever calls withMigrationLock there, so the
 * flag would always be false. Short-circuiting at module load skips the
 * per-mutation DB read on cloud instances entirely.
 *
 * Exemptions during the window:
 *   - Anything under /api/system/migration/ (operator must be able to
 *     finish, abort, or run the next step of the wizard)
 *   - Anything under /api/auth/ (session refresh / re-auth must still
 *     work; auth itself is read-mostly and the routes that DO mutate
 *     state — invite, accept — are not catastrophic to delay)
 *   - GET / HEAD / OPTIONS (read-only, safe by definition)
 *
 * Response: 503 with code "MIGRATION_IN_PROGRESS". Dashboard treats
 * this as "show in-progress launcher" if it sees it during a refresh.
 *
 * Stale-lock recovery happens in withMigrationLock's tryAcquireLock,
 * not here — this middleware just reflects the current flag. Worst
 * case: an orphan flag locks writes for 10 min until the next
 * acquire steals it. That's the trade for not running a background
 * sweeper that could itself crash.
 */

import type { MiddlewareHandler } from "hono";
import { env } from "@repo/platform/engine/config/env";
import { isMigrationInProgress } from "../modules/system/migration/migration-lock";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Path prefixes exempt from the guard. Match against the path that
 * Hono sees (e.g. "/api/system/migration/start-tunnel").
 */
const EXEMPT_PREFIXES = [
  "/api/system/migration/",
  "/api/auth/",
] as const;

function isExemptPath(path: string): boolean {
  return EXEMPT_PREFIXES.some((prefix) => path.startsWith(prefix));
}

// SaaS instances are the *destination* of migrations, never the source —
// nothing ever calls withMigrationLock on the cloud side. Evaluate once
// at module load so the guard is a pure pass-through on cloud-mode and
// we skip the per-mutation DB read entirely.
const GUARD_ACTIVE = !env.CLOUD_MODE;

export const migrationGuard: MiddlewareHandler = async (c, next) => {
  if (!GUARD_ACTIVE) {
    return next();
  }
  const method = c.req.method.toUpperCase();
  if (SAFE_METHODS.has(method)) {
    return next();
  }
  const path = c.req.path;
  if (isExemptPath(path)) {
    return next();
  }

  // DB hit per request. The check is one row by primary key — fast
  // path, no JOIN. If this becomes hot we can swap to a 5s in-memory
  // cache here without changing semantics.
  let locked = false;
  try {
    locked = await isMigrationInProgress();
  } catch (err) {
    // If the read fails we err on the side of allowing the request —
    // a permanent lockout on a DB blip would be worse than letting a
    // mutation slip through during the cutover window.
    console.warn("[migration-guard] flag read failed; allowing request:", err);
  }

  if (!locked) {
    return next();
  }

  return c.json(
    {
      error:
        "A team-mode migration is in progress on this instance. Writes are paused until the cutover completes.",
      code: "MIGRATION_IN_PROGRESS",
    },
    503,
  );
};
