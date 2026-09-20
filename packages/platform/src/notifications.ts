import { NotificationCollectionSchemas, NotificationResourceSchemas } from "@repo/contracts";
import type { Authorization } from "./authorization";
import { createResourceOperations, createScopedOperations, type ResourceServices, type ScopedServices, type PlatformResourceOperations, type PlatformScopedOperations } from "./resource-operations";

export interface NotificationDependencies {
  collection: ScopedServices<typeof NotificationCollectionSchemas>;
  resources: ResourceServices<typeof NotificationResourceSchemas>;
}
export type PlatformNotificationOperations = PlatformScopedOperations<typeof NotificationCollectionSchemas> & PlatformResourceOperations<typeof NotificationResourceSchemas>;
export function createNotificationOperations(authorization: Authorization, deps?: NotificationDependencies): PlatformNotificationOperations {
  return Object.freeze({
    ...createScopedOperations(NotificationCollectionSchemas, authorization, "notifications", deps?.collection),
    ...createResourceOperations(NotificationResourceSchemas, authorization, "notifications", deps?.resources, "organization"),
  });
}
