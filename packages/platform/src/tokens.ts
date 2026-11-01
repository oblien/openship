import { TokenCollectionSchemas, TokenResourceSchemas } from "@repo/contracts";
import type { Authorization } from "./authorization";
import { createScopedOperations, createResourceOperations, type ScopedServices, type ResourceServices, type PlatformScopedOperations, type PlatformResourceOperations } from "./resource-operations";
export interface TokenDependencies { collection: ScopedServices<typeof TokenCollectionSchemas>; tokens: ResourceServices<typeof TokenResourceSchemas> }
export type PlatformTokenOperations = PlatformScopedOperations<typeof TokenCollectionSchemas> & PlatformResourceOperations<typeof TokenResourceSchemas>;
export function createTokenOperations(authorization: Authorization, deps?: TokenDependencies): PlatformTokenOperations {
  return Object.freeze({
    ...createScopedOperations(TokenCollectionSchemas, authorization, "settings", deps?.collection),
    ...createResourceOperations(TokenResourceSchemas, authorization, "settings", deps?.tokens, "organization"),
  });
}
