import type { BackupRun } from "./api/backups";

export function isBackupRunning(run: BackupRun): boolean {
  return !["succeeded", "failed", "cancelled", "server_error"].includes(run.status);
}

/** A completed durable row must never be hidden by an older live snapshot. */
export function latestBackupRun(a: BackupRun | null, b: BackupRun | null): BackupRun | null {
  if (!a) return b;
  if (!b) return a;
  if (isBackupRunning(a) !== isBackupRunning(b)) return isBackupRunning(a) ? b : a;
  return Date.parse(a.lastEventAt ?? a.startedAt) > Date.parse(b.lastEventAt ?? b.startedAt)
    ? a
    : b;
}

export function mergeBackupRuns(current: BackupRun[], incoming: BackupRun[]): BackupRun[] {
  const runs = new Map(current.map((run) => [run.id, run]));
  for (const run of incoming) runs.set(run.id, latestBackupRun(runs.get(run.id) ?? null, run)!);
  return [...runs.values()];
}
