import { createProvisionLock } from "./provision-lock";

/** Volume admission and disabling storage must serialize across API processes. */
export const clusterStorageLock = (organizationId: string, clusterId: string) =>
  createProvisionLock(`cluster-storage:${organizationId}:${clusterId}`);
