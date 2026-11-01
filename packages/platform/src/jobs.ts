import { AppError, JobCollectionSchemas, JobResourceSchemas, ResourceIdSchema, parseInput, type DeploymentEvent } from "@repo/contracts";
import type { Authorization } from "./authorization";
import type { ExecutionContext } from "./context";
import type { OperationResult } from "./deployments";
import { createResourceOperations, createScopedOperations, type ResourceServices, type ScopedServices, type PlatformResourceOperations, type PlatformScopedOperations } from "./resource-operations";

export interface JobDependencies {
  collection: ScopedServices<typeof JobCollectionSchemas>;
  resources: ResourceServices<typeof JobResourceSchemas>;
  openRunStream(ctx: ExecutionContext, id: string, signal?: AbortSignal): Promise<AsyncIterable<DeploymentEvent>>;
}
export type PlatformJobOperations = PlatformScopedOperations<typeof JobCollectionSchemas> & PlatformResourceOperations<typeof JobResourceSchemas> & {
  openRunStream(ctx: ExecutionContext, id: string, options?: { signal?: AbortSignal }): Promise<OperationResult<AsyncIterable<DeploymentEvent>>>;
};
export function createJobOperations(authorization: Authorization, deps?: JobDependencies): PlatformJobOperations {
  return Object.freeze({
    ...createScopedOperations(JobCollectionSchemas, authorization, "job", deps?.collection),
    ...createResourceOperations(JobResourceSchemas, authorization, "job", deps?.resources, "organization"),
    async openRunStream(ctx, value, options = {}) {
      const id = parseInput(ResourceIdSchema, value);
      const context = await authorization.authorize(ctx, { resourceType: "job", resourceId: "*", action: "read" });
      if (!deps) throw new AppError("Job operations are not configured", 501, "CAPABILITY_UNAVAILABLE");
      const stream = await deps.openRunStream(context, id, options.signal);
      async function* authorized() {
        for await (const event of stream) {
          await authorization.authorize(context, { resourceType: "job", resourceId: "*", action: "read" });
          // Re-read the job/targets for every event, including after edits or deletion.
          await deps!.resources.getRun(context, id);
          yield event;
        }
      }
      return { context, data: authorized() };
    },
  } satisfies PlatformJobOperations);
}
