import {
  AppError, DomainCollectionSchemas, DomainResourceSchemas, DomainScopedSchemas,
  ResourceIdSchema, VerifyDomainInputSchema, parseInput, type DomainOperations,
} from "@repo/contracts";
import type { Authorization } from "./authorization";
import type { ExecutionContext } from "./context";
import {
  createResourceOperations, createScopedOperations,
  type ResourceServices, type ScopedServices,
  type PlatformResourceOperations, type PlatformScopedOperations,
} from "./resource-operations";
import { subscriptionEvents, type EventSubscription } from "./event-stream";

export interface DomainDependencies {
  collection: ResourceServices<typeof DomainCollectionSchemas>;
  resources: ResourceServices<typeof DomainResourceSchemas>;
  scoped: ScopedServices<typeof DomainScopedSchemas>;
  subscribe(ctx: ExecutionContext, id: string, input: { force?: boolean }): EventSubscription;
}
export interface PlatformDomainOperations extends
  PlatformResourceOperations<typeof DomainCollectionSchemas>,
  PlatformResourceOperations<typeof DomainResourceSchemas>,
  PlatformScopedOperations<typeof DomainScopedSchemas> {
  verifyStream(ctx: ExecutionContext, ...args: Parameters<DomainOperations["verifyStream"]>):
    ReturnType<DomainOperations["verifyStream"]>;
}

export function createDomainOperations(authorization: Authorization, deps?: DomainDependencies): PlatformDomainOperations {
  return Object.freeze({
    ...createResourceOperations(DomainCollectionSchemas, authorization, "project", deps?.collection),
    ...createResourceOperations(DomainResourceSchemas, authorization, "domain", deps?.resources),
    ...createScopedOperations(DomainScopedSchemas, authorization, "domain", deps?.scoped),
    async *verifyStream(ctx, value, command = {}, options = {}) {
      const id = parseInput(ResourceIdSchema, value);
      const input = parseInput(VerifyDomainInputSchema, command);
      const context = await authorization.authorize(ctx, { resourceType: "domain", resourceId: id, action: "write" });
      if (!deps) throw new AppError("Domain verification is not configured", 501, "CAPABILITY_UNAVAILABLE");
      for await (const event of subscriptionEvents(deps.subscribe(context, id, input), options.signal, "complete")) {
        await authorization.authorize(context, { resourceType: "domain", resourceId: id, action: "write" });
        yield event;
      }
    },
  } satisfies PlatformDomainOperations);
}
