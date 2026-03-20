export const DEFAULT_ROLLBACK_WINDOW = 5;
export const MAX_ROLLBACK_WINDOW = 20;

export function normalizeRollbackWindow(
  value: unknown,
  fallback = DEFAULT_ROLLBACK_WINDOW,
): number {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string"
      ? Number(value)
      : Number.NaN;

  if (!Number.isFinite(parsed)) return fallback;
  const whole = Math.trunc(parsed);
  if (whole < 0) return 0;
  if (whole > MAX_ROLLBACK_WINDOW) return MAX_ROLLBACK_WINDOW;
  return whole;
}