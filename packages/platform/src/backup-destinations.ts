import { BackupDestinationCollectionSchemas, BackupDestinationResourceSchemas } from "@repo/contracts";
import type { Authorization } from "./authorization";
import { createScopedOperations, createResourceOperations, type ScopedServices, type ResourceServices, type PlatformScopedOperations, type PlatformResourceOperations } from "./resource-operations";

export interface BackupDestinationDependencies {
  collection: ScopedServices<typeof BackupDestinationCollectionSchemas>;
  resources: ResourceServices<typeof BackupDestinationResourceSchemas>;
}
export type PlatformBackupDestinationOperations = PlatformScopedOperations<typeof BackupDestinationCollectionSchemas> & PlatformResourceOperations<typeof BackupDestinationResourceSchemas>;
export function createBackupDestinationOperations(authorization: Authorization, deps?: BackupDestinationDependencies): PlatformBackupDestinationOperations {
  return Object.freeze({
    ...createScopedOperations(BackupDestinationCollectionSchemas, authorization, "backup_destination", deps?.collection),
    ...createResourceOperations(BackupDestinationResourceSchemas, authorization, "backup_destination", deps?.resources),
  });
}
