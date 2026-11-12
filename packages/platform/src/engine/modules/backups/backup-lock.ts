import { createProvisionLock } from "../../lib/provision-lock";

/** Incremental capture and retention share ownership of the same stored blocks. */
export function withBackupPolicyLock<T>(policyId: string, work: () => Promise<T>): Promise<T> {
  return createProvisionLock(`backup-retention:${policyId}`).run(work);
}

/** Admission to restore/protect must not race deletion of the source objects. */
export function withBackupRunLock<T>(runId: string, work: () => Promise<T>): Promise<T> {
  return createProvisionLock(`backup-run:${runId}`).run(work);
}

/** Serializes backup execution per destination to prevent SSH/SFTP connection exhaustion. */
export function withBackupDestinationLock<T>(destinationId: string, work: () => Promise<T>): Promise<T> {
  return createProvisionLock(`backup-destination:${destinationId}`).run(work);
}

/** Capture and restore must never independently stop/resume the same mail writers. */
export function withMailBackupLock<T>(serverId: string, work: () => Promise<T>): Promise<T> {
  return createProvisionLock(`mail-backup:${serverId}`).run(work);
}
