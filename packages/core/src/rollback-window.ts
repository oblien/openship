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
 *   auto     — nothing typed (`project.rollbackWindow IS NULL`). Sized from the
 *              deploy host's FREE DISK and the project's own measured snapshot
 *              size, so a small VPS keeps a couple of releases and a roomy box
 *              keeps many, without anyone having to reason about image sizes.
 */

export const DEFAULT_ROLLBACK_WINDOW = 5;
export const MAX_ROLLBACK_WINDOW = 20;

/**
 * Auto-sizing policy. Retained releases are dead weight most of the time, so
 * they get a MINORITY of the free space: a build needs transient room, volumes
 * grow, and a full disk breaks deploys rather than merely rollback.
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
 * The auto window, or `fallback` when we can't measure (host unreachable, never
 * deployed, zero-size images). Never returns 0 from a real measurement: a host
 * too full for even one snapshot still reports MIN_AUTO_ROLLBACK_WINDOW, because
 * the window is a retention TARGET — the images that already exist are kept
 * until they age out, and refusing to keep any would make rollback impossible
 * exactly when a bad deploy needs it most.
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
