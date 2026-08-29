/**
 * Shared throttle for the auto-scan-infra behaviour. When the operator has
 * auto-scan on, opening the Infrastructure tab OR the home page fires ONE
 * detect-only container scan — but only if the cached drift state is stale, so a
 * quick tab→home→tab hop doesn't re-probe every server over SSH each time.
 *
 * The "last auto-scanned" stamp lives in localStorage, shared across both
 * surfaces (and browser tabs), so the throttle holds regardless of where the
 * scan fired. Detect-only: this never applies an update, it only refreshes the
 * cache that the attention dot + issue list read from.
 */

const KEY = "openship:infraAutoScanAt";
/** Re-scan at most this often per browser, across all surfaces. */
const STALE_MS = 30 * 60 * 1000;

/** True when no auto-scan has run within the throttle window (or storage is off). */
export function infraScanStale(): boolean {
  try {
    const v = localStorage.getItem(KEY);
    if (!v) return true;
    return Date.now() - Number(v) > STALE_MS;
  } catch {
    return true;
  }
}

/** Stamp "auto-scanned now" so the next surface load inside the window skips it. */
export function markInfraScanned(): void {
  try {
    localStorage.setItem(KEY, String(Date.now()));
  } catch {
    /* storage disabled — the scan simply isn't throttled */
  }
}
