import { AppCollectionSchemas, AppResourceSchemas } from "@repo/contracts";
import type { Authorization } from "./authorization";
import { createResourceOperations, createScopedOperations,
  type ResourceServices, type ScopedServices, type PlatformResourceOperations, type PlatformScopedOperations } from "./resource-operations";

export interface AppDependencies {
  collection: ScopedServices<typeof AppCollectionSchemas>;
  resources: ResourceServices<typeof AppResourceSchemas>;
}
export type PlatformAppOperations = PlatformScopedOperations<typeof AppCollectionSchemas> & PlatformResourceOperations<typeof AppResourceSchemas>;
export function createAppOperations(authorization: Authorization, deps?: AppDependencies): PlatformAppOperations {
  return Object.freeze({
    ...createScopedOperations(AppCollectionSchemas, authorization, "project", deps?.collection),
    // Catalog identifiers belong to the organization, rather than naming project rows.
    ...createResourceOperations(AppResourceSchemas, authorization, "project", deps?.resources, "organization"),
  });
}
