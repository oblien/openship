import {
  ActionCollectionSchemas,
  ActionResourceSchemas,
  ActionCollectionRoutes,
  ActionResourceRoutes,
  type ActionOperations,
} from "@repo/contracts";
import type { HttpClient } from "./http";
import { createRemoteResourceOperations, createRemoteScopedOperations } from "./resource-client";

export function createRemoteActionOperations(http: HttpClient): ActionOperations {
  return Object.freeze({
    ...createRemoteScopedOperations(http, ActionCollectionSchemas, ActionCollectionRoutes),
    ...createRemoteResourceOperations(http, ActionResourceSchemas, ActionResourceRoutes),
  });
}
