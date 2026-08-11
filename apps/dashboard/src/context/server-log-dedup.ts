/**
 * Dedup + ordering for the project Server Logs tab.
 *
 * Two producers feed the same list: `/logs/recent` (history, backfilled on mount) and the
 * live SSE tail. Both now read the edge's one ring buffer, which stamps a deterministic
 * `{host}:{seq}` id, so the same request arrives with the same id from either path and must
 * collapse to a single row. The list is also assembled from opposite ends — a live hit is
 * prepended, a backfill appended — so it needs an explicit newest-first sort or the
 * just-hit endpoint lands wherever it happened to be inserted (the reported "unsorted" bug).
 *
 * Kept pure and out of the context component so it can be unit-tested directly.
 */

export const MAX_SERVER_LOGS = 100;

export function getServerLogKey(log: any): string {
  if (!log || typeof log !== "object") return String(log);
  // The edge stamps a deterministic `{host}:{seq}` id into the ring, so the same request
  // carries the same id whether it arrived via /logs/recent or the live stream — keying on
  // it collapses the two into one row. A `req-` id is the client's random stand-in for a
  // producer that minted none (see normalizeRequestLog); it can't dedup anything, so fall
  // through to content.
  if (typeof log.id === "string" && log.id && !log.id.startsWith("req-")) {
    return `id:${log.id}`;
  }
  // Full-precision content key — do NOT round the timestamp: two distinct requests in the
  // same second are separate rows, and one request never changes its own millisecond.
  const parsedTimestamp = typeof log.timestamp === "string" ? Date.parse(log.timestamp) : Number.NaN;
  const timestampKey = Number.isFinite(parsedTimestamp) ? parsedTimestamp : String(log.timestamp ?? "");

  return [
    timestampKey,
    log.ip,
    log.method,
    log.path,
    log.statusCode,
    log.responseTime,
    log.requestSize,
    log.responseSize,
  ].join("|");
}

export function serverLogTs(log: any): number {
  const raw = log?.timestamp;
  const n = typeof raw === "string" ? Date.parse(raw) : Number(raw);
  return Number.isFinite(n) ? n : 0;
}

export function dedupeServerLogs(logs: any[]): any[] {
  const seen = new Set<string>();
  const merged: any[] = [];

  for (const log of logs) {
    const key = getServerLogKey(log);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(log);
  }

  // Newest-first regardless of which path delivered a row. Cap AFTER sorting so we keep the
  // newest MAX_SERVER_LOGS, not the first inserted.
  merged.sort((a, b) => serverLogTs(b) - serverLogTs(a));
  return merged.slice(0, MAX_SERVER_LOGS);
}
