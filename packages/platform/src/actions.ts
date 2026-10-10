import { ActionCollectionSchemas, ActionResourceSchemas } from "@repo/contracts";
import type { Authorization } from "./authorization";
import {
  createResourceOperations,
  createScopedOperations,
  type ResourceServices,
  type ScopedServices,
  type PlatformResourceOperations,
  type PlatformScopedOperations,
} from "./resource-operations";

export interface ActionDependencies {
  collection: ScopedServices<typeof ActionCollectionSchemas>;
  resources: ResourceServices<typeof ActionResourceSchemas>;
}
export type PlatformActionOperations = PlatformScopedOperations<typeof ActionCollectionSchemas> &
  PlatformResourceOperations<typeof ActionResourceSchemas>;
export function createActionOperations(
  authorization: Authorization,
  deps?: ActionDependencies,
): PlatformActionOperations {
  return Object.freeze({
    ...createScopedOperations(ActionCollectionSchemas, authorization, "job", deps?.collection),
    ...createResourceOperations(
      ActionResourceSchemas,
      authorization,
      "job",
      deps?.resources,
      "organization",
    ),
  });
}
