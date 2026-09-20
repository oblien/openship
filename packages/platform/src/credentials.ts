import { CredentialCollectionSchemas, CredentialResourceSchemas } from "@repo/contracts";
import type { Authorization } from "./authorization";
import type { ExecutionContext } from "./context";
import { createScopedOperations, createResourceOperations, type ScopedServices, type ResourceServices, type PlatformScopedOperations, type PlatformResourceOperations } from "./resource-operations";

export interface CredentialDependencies {
  collection: ScopedServices<typeof CredentialCollectionSchemas>;
  resources: ResourceServices<typeof CredentialResourceSchemas>;
  requireAdmin(ctx: ExecutionContext): Promise<void>;
}
export type PlatformCredentialOperations = PlatformScopedOperations<typeof CredentialCollectionSchemas> & PlatformResourceOperations<typeof CredentialResourceSchemas>;
export function createCredentialOperations(authorization: Authorization, deps?: CredentialDependencies): PlatformCredentialOperations {
  return Object.freeze({
    ...createScopedOperations(CredentialCollectionSchemas, authorization, "settings", deps && {
      ...deps.collection,
      async create(ctx, input) { await deps.requireAdmin(ctx); return deps.collection.create(ctx, input); },
    }),
    // IDs identify credentials within the org; settings permission is still the wildcard.
    ...createResourceOperations(CredentialResourceSchemas, authorization, "settings", deps && {
      ...deps.resources,
      async update(ctx, id, input) { await deps.requireAdmin(ctx); return deps.resources.update(ctx, id, input); },
      async remove(ctx, id) { await deps.requireAdmin(ctx); return deps.resources.remove(ctx, id); },
      async verify(ctx, id) { await deps.requireAdmin(ctx); return deps.resources.verify(ctx, id); },
    }, "organization"),
  });
}
