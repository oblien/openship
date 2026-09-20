import { IssueCollectionSchemas, IssueJobSchemas } from "@repo/contracts";
import type { Authorization } from "./authorization";
import { createScopedOperations, type ScopedServices, type PlatformScopedOperations } from "./resource-operations";

export interface IssueDependencies {
  collection: ScopedServices<typeof IssueCollectionSchemas>;
  jobs: ScopedServices<typeof IssueJobSchemas>;
}
export type PlatformIssueOperations = PlatformScopedOperations<typeof IssueCollectionSchemas> & PlatformScopedOperations<typeof IssueJobSchemas>;
export function createIssueOperations(authorization: Authorization, deps?: IssueDependencies): PlatformIssueOperations {
  return Object.freeze({
    ...createScopedOperations(IssueCollectionSchemas, authorization, "project", deps?.collection),
    ...createScopedOperations(IssueJobSchemas, authorization, "job", deps?.jobs),
  });
}
