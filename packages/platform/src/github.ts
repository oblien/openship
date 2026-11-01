import { GitHubCollectionSchemas, GitHubResourceSchemas } from "@repo/contracts";
import type { Authorization } from "./authorization";
import { createIdentityAuthorization } from "./identity-authorization";
import { createScopedOperations, createResourceOperations, type ScopedServices, type ResourceServices, type PlatformScopedOperations, type PlatformResourceOperations } from "./resource-operations";

export interface GitHubDependencies { collection: ScopedServices<typeof GitHubCollectionSchemas>; resources: ResourceServices<typeof GitHubResourceSchemas> }
export type PlatformGitHubOperations = PlatformScopedOperations<typeof GitHubCollectionSchemas> & PlatformResourceOperations<typeof GitHubResourceSchemas>;
export function createGitHubOperations(authorization: Authorization, deps?: GitHubDependencies): PlatformGitHubOperations {
  const identity = createIdentityAuthorization(authorization);
  return Object.freeze({
    ...createScopedOperations(GitHubCollectionSchemas, identity, "github", deps?.collection),
    ...createResourceOperations(GitHubResourceSchemas, identity, "github", deps?.resources, "organization"),
  });
}
