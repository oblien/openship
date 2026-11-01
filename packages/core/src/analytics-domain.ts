/** Hostname key used by Edge traffic counters and persisted analytics. */
export function normalizeTrackedDomain(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^www\./, "");
}
