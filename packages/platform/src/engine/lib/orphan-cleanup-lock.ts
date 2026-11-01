import { createProvisionLock } from "./provision-lock";

/** Recovery retires cleanup intent; GC must never replay a pre-recovery snapshot. */
export const ORPHAN_CLEANUP_LOCK = "projects:orphan-gc";
export const orphanCleanupLock = createProvisionLock(ORPHAN_CLEANUP_LOCK);
