import { createProvisionLock } from "../../lib/provision-lock";

/** Incremental capture and retention share ownership of the same stored blocks. */
export function withBackupPolicyLock<T>(policyId: string, work: () => Promise<T>): Promise<T> {
  return createProvisionLock(`backup-retention:${policyId}`).run(work);
}

/** Admission to restore/protect must not race deletion of the source objects. */
export function withBackupRunLock<T>(runId: string, work: () => Promise<T>): Promise<T> {
  return createProvisionLock(`backup-run:${runId}`).run(work);
}
