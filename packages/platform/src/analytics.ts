import { AnalyticsProjectSchemas, AnalyticsServerSchemas, AnalyticsCollectionSchemas, AppError, ResourceIdSchema, parseInput, type DeploymentEvent } from "@repo/contracts";
import type { Authorization } from "./authorization";
import type { ExecutionContext } from "./context";
import type { OperationResult } from "./deployments";
import { guardedStream } from "./guarded-stream";
import { createResourceOperations, createScopedOperations, type ResourceServices, type ScopedServices, type PlatformResourceOperations, type PlatformScopedOperations } from "./resource-operations";

export interface AnalyticsDependencies {
  projects: ResourceServices<typeof AnalyticsProjectSchemas>;
  servers: ResourceServices<typeof AnalyticsServerSchemas>;
  collection: ScopedServices<typeof AnalyticsCollectionSchemas>;
  openUsageStream(ctx: ExecutionContext, id: string, signal?: AbortSignal): Promise<AsyncIterable<DeploymentEvent>>;
}
export type PlatformAnalyticsOperations = PlatformResourceOperations<typeof AnalyticsProjectSchemas> & PlatformResourceOperations<typeof AnalyticsServerSchemas> & PlatformScopedOperations<typeof AnalyticsCollectionSchemas> & {
  openUsageStream(ctx: ExecutionContext, id: string, options?: { signal?: AbortSignal }): Promise<OperationResult<AsyncIterable<DeploymentEvent>>>;
};
export function createAnalyticsOperations(authorization: Authorization, deps?: AnalyticsDependencies): PlatformAnalyticsOperations {
  return Object.freeze({
    ...createResourceOperations(AnalyticsProjectSchemas, authorization, "project", deps?.projects),
    ...createResourceOperations(AnalyticsServerSchemas, authorization, "server", deps?.servers),
    ...createScopedOperations(AnalyticsCollectionSchemas, authorization, "analytics", deps?.collection),
    async openUsageStream(ctx, value, options = {}) {
      const id = parseInput(ResourceIdSchema, value);
      const context = await authorization.authorize(ctx, { resourceType: "project", resourceId: id, action: "read" });
      await authorization.authorize(context, { resourceType: "analytics", resourceId: "*", action: "read" });
      if (!deps) throw new AppError("Analytics operations are not configured", 501, "CAPABILITY_UNAVAILABLE");
      const source = await deps.openUsageStream(context, id, options.signal);
      return { context, data: guardedStream(source, { check: async () => {
        await authorization.authorize(context, { resourceType: "project", resourceId: id, action: "read" });
        await authorization.authorize(context, { resourceType: "analytics", resourceId: "*", action: "read" });
      } }) };
    },
  } satisfies PlatformAnalyticsOperations);
}
