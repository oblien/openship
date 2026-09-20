import { WebhookProjectSchemas, WebhookResourceSchemas, WebhookCollectionSchemas } from "@repo/contracts";
import type { Authorization } from "./authorization";
import type { ExecutionContext } from "./context";
import { createResourceOperations, createChildResourceOperations, createScopedOperations, type ResourceServices, type ChildResourceServices, type ScopedServices, type PlatformResourceOperations, type PlatformChildResourceOperations, type PlatformScopedOperations } from "./resource-operations";

export interface WebhookDependencies {
  projects: ResourceServices<typeof WebhookProjectSchemas>;
  hooks: ChildResourceServices<typeof WebhookResourceSchemas>;
  collection: ScopedServices<typeof WebhookCollectionSchemas>;
  projectFor(ctx: ExecutionContext, hookId: string): Promise<string | null | undefined>;
}
export type PlatformWebhookOperations = PlatformResourceOperations<typeof WebhookProjectSchemas> & PlatformChildResourceOperations<typeof WebhookResourceSchemas> & PlatformScopedOperations<typeof WebhookCollectionSchemas>;
export function createWebhookOperations(authorization: Authorization, deps?: WebhookDependencies): PlatformWebhookOperations {
  return Object.freeze({
    ...createResourceOperations(WebhookProjectSchemas, authorization, "project", deps?.projects),
    ...createChildResourceOperations(WebhookResourceSchemas, authorization, "project", deps?.hooks, deps?.projectFor, { authorizeParent: true }),
    ...createScopedOperations(WebhookCollectionSchemas, authorization, "settings", deps?.collection),
  });
}
