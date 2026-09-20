import {
  AppError,
  NotFoundError,
  ResourceIdSchema,
  RuntimeLogsInputSchema,
  ServiceCollectionSchemas,
  ServiceResourceSchemas,
  parseInput,
  type ServiceOperations,
} from "@repo/contracts";
import type { Authorization } from "./authorization";
import type { ExecutionContext } from "./context";
import {
  createResourceOperations,
  createChildResourceOperations,
  type ResourceServices,
  type ChildResourceServices,
  type PlatformResourceOperations,
  type PlatformChildResourceOperations,
} from "./resource-operations";
import { subscriptionEvents, type EventSubscription } from "./event-stream";

export interface ServiceDependencies {
  collection: ResourceServices<typeof ServiceCollectionSchemas>;
  resources: ChildResourceServices<typeof ServiceResourceSchemas>;
  parentFor(ctx: ExecutionContext, id: string): Promise<string | null | undefined>;
  subscribe(
    ctx: ExecutionContext,
    projectId: string,
    serviceId: string,
    input: { tail?: number },
  ): EventSubscription;
}
export interface PlatformServiceOperations
  extends
    PlatformResourceOperations<typeof ServiceCollectionSchemas>,
    PlatformChildResourceOperations<typeof ServiceResourceSchemas> {
  streamLogs(
    ctx: ExecutionContext,
    ...args: Parameters<ServiceOperations["streamLogs"]>
  ): ReturnType<ServiceOperations["streamLogs"]>;
}

export function createServiceOperations(
  authorization: Authorization,
  deps?: ServiceDependencies,
): PlatformServiceOperations {
  return Object.freeze({
    ...createResourceOperations(
      ServiceCollectionSchemas,
      authorization,
      "project",
      deps?.collection,
    ),
    ...createChildResourceOperations(
      ServiceResourceSchemas,
      authorization,
      "service",
      deps?.resources,
      deps?.parentFor,
    ),
    async *streamLogs(ctx, parent, id, value = {}, options = {}) {
      const projectId = parseInput(ResourceIdSchema, parent);
      const serviceId = parseInput(ResourceIdSchema, id);
      const input = parseInput(RuntimeLogsInputSchema, value);
      const context = await authorization.authorize(ctx, {
        resourceType: "service",
        resourceId: serviceId,
        action: "read",
      });
      if (!deps)
        throw new AppError(
          "Service log streaming is not configured",
          501,
          "CAPABILITY_UNAVAILABLE",
        );
      if ((await deps.parentFor(context, serviceId)) !== projectId)
        throw new NotFoundError("service", serviceId);
      for await (const event of subscriptionEvents(
        deps.subscribe(context, projectId, serviceId, input),
        options.signal,
      )) {
        await authorization.authorize(context, {
          resourceType: "service",
          resourceId: serviceId,
          action: "read",
        });
        yield event;
      }
    },
  } satisfies PlatformServiceOperations);
}
