import { GitCollectionSchemas } from "@repo/contracts";
import type { Authorization } from "./authorization";
import { createIdentityAuthorization } from "./identity-authorization";
import {
  createScopedOperations,
  type ScopedServices,
  type PlatformScopedOperations,
} from "./resource-operations";

export type GitDependencies = ScopedServices<typeof GitCollectionSchemas>;
export type PlatformGitOperations = PlatformScopedOperations<typeof GitCollectionSchemas>;
export function createGitOperations(
  authorization: Authorization,
  services?: GitDependencies,
): PlatformGitOperations {
  return createScopedOperations(
    GitCollectionSchemas,
    createIdentityAuthorization(authorization),
    "git",
    services,
  );
}
