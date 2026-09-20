/**
 * How many past releases stay restorable — the "rollback window".
 *
 * Lives in core because both sides need the same arithmetic: the API resolves
 * and enforces the window, and the dashboard renders + clamps the same numbers
 * (a second hand-written `Math.min(20, …)` in a settings component is how the
 * two drift).
 *
 * Two ways a project gets its window:
 *
 *   explicit — the operator typed a number. Honored as-is (clamped).
 *   default  — no override (`project.rollbackWindow IS NULL`): inherit the
 *              instance default, which starts at five past releases.
 */

export const DEFAULT_ROLLBACK_WINDOW = 5;
export const MAX_ROLLBACK_WINDOW = 20;

/**
 * Legacy disk estimate, retained for API compatibility. These constants do
 * not control retention; the configured number of past releases does.
 */
export const ROLLBACK_DISK_BUDGET_FRACTION = 0.25;
/** Never dedicate more than this to rollback history, however big the disk. */
export const ROLLBACK_DISK_BUDGET_CAP_BYTES = 20 * 1024 * 1024 * 1024; // 20 GiB
/** Keep at least this many restorable releases whenever we can measure at all,
 *  so "instant rollback" exists even on a cramped host. */
export const MIN_AUTO_ROLLBACK_WINDOW = 2;

export function normalizeRollbackWindow(
  value: unknown,
  fallback = DEFAULT_ROLLBACK_WINDOW,
): number {
  const parsed =
    typeof value === "number"
      ? value
      : // A BLANK string is "not set", not zero. `Number("")` is 0, which would
        // silently mean "retain nothing" — one cleared form field and the next
        // deploy purges every restorable release.
        typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  const whole = Math.trunc(parsed);
  // `<= 0` (not `< 0`) also normalizes Math.trunc's -0 to plain 0.
  if (whole <= 0) return 0;
  if (whole > MAX_ROLLBACK_WINDOW) return MAX_ROLLBACK_WINDOW;
  return whole;
}

export interface AutoRollbackWindowInput {
  /** Free bytes on the filesystem holding the runtime's images/releases. */
  diskFreeBytes?: number | null;
  /** Measured bytes for ONE retained release of this project. */
  snapshotSizeBytes?: number | null;
  /** Returned when there isn't enough information to size anything. */
  fallback?: number;
}

/**
 * @deprecated Informational estimate only. Retention never uses disk sizing to
 * override the configured window. Kept for compatibility with existing imports.
 */
export function computeAutoRollbackWindow(input: AutoRollbackWindowInput): number {
  const fallback = normalizeRollbackWindow(input.fallback ?? DEFAULT_ROLLBACK_WINDOW);
  const free = input.diskFreeBytes;
  const snapshot = input.snapshotSizeBytes;

  if (!free || !Number.isFinite(free) || free <= 0) return fallback;
  if (!snapshot || !Number.isFinite(snapshot) || snapshot <= 0) return fallback;

  const budget = Math.min(free * ROLLBACK_DISK_BUDGET_FRACTION, ROLLBACK_DISK_BUDGET_CAP_BYTES);
  const fits = Math.floor(budget / snapshot);
  return normalizeRollbackWindow(Math.max(fits, MIN_AUTO_ROLLBACK_WINDOW));
}
