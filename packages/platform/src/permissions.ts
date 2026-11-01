import { PermissionCollectionSchemas, PermissionResourceSchemas } from "@repo/contracts";
import type { Authorization } from "./authorization";
import { createIdentityAuthorization } from "./identity-authorization";
import { createScopedOperations, createResourceOperations, type ScopedServices, type ResourceServices, type PlatformScopedOperations, type PlatformResourceOperations } from "./resource-operations";
export interface PermissionDependencies { collection: ScopedServices<typeof PermissionCollectionSchemas>; resources: ResourceServices<typeof PermissionResourceSchemas> }
export type PlatformPermissionOperations = PlatformScopedOperations<typeof PermissionCollectionSchemas> & PlatformResourceOperations<typeof PermissionResourceSchemas>;

/** Account/roster operations first refresh identity and membership; each service
 * enforces the relevant admin, invitation-recipient, or self-management gate. */
export function createPermissionOperations(authorization: Authorization, deps?: PermissionDependencies): PlatformPermissionOperations {
  const identityGate = createIdentityAuthorization(authorization);
  return Object.freeze({
    ...createScopedOperations(PermissionCollectionSchemas, identityGate, "permissions", deps?.collection),
    ...createResourceOperations(PermissionResourceSchemas, identityGate, "permissions", deps?.resources, "organization"),
  });
}
