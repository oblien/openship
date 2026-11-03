import { createHash } from "node:crypto";

export const SECURITY_INSPECTION_INTERVAL_MS = 6 * 3_600_000;
export const SECURITY_RETRY_MIN_MS = 5 * 60_000;
export const SECURITY_RETRY_MAX_MS = 3_600_000;

/** Stable per-resource jitter spreads a fleet across scheduler ticks. */
export function nextSecurityInspection(id: string, checkedAt: Date, failures: number): Date {
  const delay = failures
    ? Math.min(SECURITY_RETRY_MAX_MS, SECURITY_RETRY_MIN_MS * 2 ** Math.min(failures - 1, 4))
    : SECURITY_INSPECTION_INTERVAL_MS;
  const jitter = createHash("sha256").update(id).digest().readUInt16BE(0) / 65535;
  return new Date(checkedAt.getTime() + Math.round(delay * (1 + jitter * 0.1)));
}

export function securityObservationDue(
  row: { checkedAt?: Date | null; nextInspectionAt?: Date | null } | null | undefined,
): boolean {
  return !row?.checkedAt || !row.nextInspectionAt || row.nextInspectionAt.getTime() <= Date.now();
}
