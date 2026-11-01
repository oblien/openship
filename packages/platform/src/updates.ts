import { UpdateCollectionSchemas, UpdateProjectSchemas } from "@repo/contracts";
import type { Authorization } from "./authorization";
import { createResourceOperations, createScopedOperations, type ResourceServices, type ScopedServices, type PlatformResourceOperations, type PlatformScopedOperations } from "./resource-operations";
export interface UpdateDependencies { collection: ScopedServices<typeof UpdateCollectionSchemas>; projects: ResourceServices<typeof UpdateProjectSchemas> }
export type PlatformUpdateOperations = PlatformScopedOperations<typeof UpdateCollectionSchemas> & PlatformResourceOperations<typeof UpdateProjectSchemas>;
export function createUpdateOperations(authorization: Authorization, deps?: UpdateDependencies): PlatformUpdateOperations {
  return Object.freeze({ ...createScopedOperations(UpdateCollectionSchemas, authorization, "updates", deps?.collection), ...createResourceOperations(UpdateProjectSchemas, authorization, "project", deps?.projects) });
}
