import { AuditOperationSchemas } from "@repo/contracts";
import type { Authorization } from "./authorization";
import { createScopedOperations, type ScopedServices, type PlatformScopedOperations } from "./resource-operations";
export interface AuditDependencies { collection: ScopedServices<typeof AuditOperationSchemas> }
export type PlatformAuditOperations = PlatformScopedOperations<typeof AuditOperationSchemas>;
export function createAuditOperations(authorization: Authorization, deps?: AuditDependencies): PlatformAuditOperations {
  return createScopedOperations(AuditOperationSchemas, authorization, "audit", deps?.collection);
}
