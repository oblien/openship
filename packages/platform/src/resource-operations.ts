import {
  AppError,
  NotFoundError,
  ResourceIdSchema,
  parseInput,
  isResourceOutput,
  type ResourceOperationSchema,
  type ResourceOperations,
  type ChildResourceOperations,
  type ScopedOperations,
} from "@repo/contracts";
import type { Authorization } from "./authorization";
import type { ExecutionContext } from "./context";
import type { OperationResult } from "./deployments";
import type { ResourceType } from "@repo/core";

export type ResourceServices<S extends Record<string, ResourceOperationSchema>> = {
  [K in keyof S]: (
    ctx: ExecutionContext,
    ...args: Parameters<ResourceOperations<S>[K]>
  ) => Promise<unknown>;
};
export type PlatformResourceOperations<S extends Record<string, ResourceOperationSchema>> = {
  [K in keyof S]: (
    ctx: ExecutionContext,
    ...args: Parameters<ResourceOperations<S>[K]>
  ) => Promise<OperationResult<Awaited<ReturnType<ResourceOperations<S>[K]>>>>;
};
export type ChildResourceServices<S extends Record<string, ResourceOperationSchema>> = {
  [K in keyof S]: (
    ctx: ExecutionContext,
    ...args: Parameters<ChildResourceOperations<S>[K]>
  ) => Promise<unknown>;
};
export type PlatformChildResourceOperations<S extends Record<string, ResourceOperationSchema>> = {
  [K in keyof S]: (
    ctx: ExecutionContext,
    ...args: Parameters<ChildResourceOperations<S>[K]>
  ) => Promise<OperationResult<Awaited<ReturnType<ChildResourceOperations<S>[K]>>>>;
};
export type ScopedServices<S extends Record<string, ResourceOperationSchema>> = {
  [K in keyof S]: (ctx: ExecutionContext, ...args: Parameters<ScopedOperations<S>[K]>) => Promise<unknown>;
};
export type PlatformScopedOperations<S extends Record<string, ResourceOperationSchema>> = {
  [K in keyof S]: (ctx: ExecutionContext, ...args: Parameters<ScopedOperations<S>[K]>) =>
    Promise<OperationResult<Awaited<ReturnType<ScopedOperations<S>[K]>>>>;
};

async function executeResourceOperation(
  ctx: ExecutionContext,
  value: string,
  command: unknown,
  name: string,
  spec: ResourceOperationSchema,
  authorization: Authorization,
  resourceType: ResourceType,
  service?: (ctx: ExecutionContext, id: string, input?: unknown) => Promise<unknown>,
  authorizationScope: "resource" | "organization" = "resource",
): Promise<OperationResult<unknown>> {
  const id = parseInput(ResourceIdSchema, value);
  const input = spec.input
    ? parseInput(spec.input, command === undefined && spec.optionalInput ? {} : command)
    : undefined;
  const context = await authorization.authorize(ctx, {
    resourceType,
    resourceId: authorizationScope === "organization" ? "*" : id,
    action: spec.action,
    scope: spec.scope,
    projectCreate: spec.projectCreate,
  });
  if (!service)
    throw new AppError(
      `Operation ${resourceType}.${name} is not configured`,
      501,
      "CAPABILITY_UNAVAILABLE",
    );
  const result = await service(context, id, input);
  return { context, data: presentOperationOutput(spec, result, `${resourceType}.${name}`) };
}

/** JSON presentation shared by tenant, public, and explicit operator capabilities. */
export function presentOperationOutput(spec: ResourceOperationSchema, result: unknown, name: string): unknown {
  let data: unknown;
  try {
    data = JSON.parse(JSON.stringify(result));
  } catch {
    throw new AppError(
      `Invalid ${name} response`,
      500,
      "INVALID_OPERATION_RESPONSE",
    );
  }
  if (!isResourceOutput(spec, data)) {
    throw new AppError(
      `Invalid ${name} response`,
      500,
      "INVALID_OPERATION_RESPONSE",
    );
  }
  return data;
}

/** One validation/authorization/presentation boundary for JSON resource calls. */
export function createResourceOperations<S extends Record<string, ResourceOperationSchema>>(
  schemas: S,
  authorization: Authorization,
  resourceType: ResourceType,
  services?: ResourceServices<S>,
  authorizationScope: "resource" | "organization" = "resource",
): PlatformResourceOperations<S> {
  const operations = Object.fromEntries(
    Object.entries(schemas).map(([name, spec]) => [
      name,
      async (ctx: ExecutionContext, value: string, command?: unknown) => {
        const service = services?.[name] as
          | ((ctx: ExecutionContext, id: string, input?: unknown) => Promise<unknown>)
          | undefined;
        return executeResourceOperation(
          ctx,
          value,
          command,
          name,
          spec,
          authorization,
          resourceType,
          service,
          authorizationScope,
        );
      },
    ]),
  );
  // The schemas define the full public method set and validate each result.
  return Object.freeze(operations) as PlatformResourceOperations<S>;
}

/** Singleton and collection operations still pass through the same policy boundary. */
export function createScopedOperations<S extends Record<string, ResourceOperationSchema>>(
  schemas: S,
  authorization: Authorization,
  resourceType: ResourceType,
  services?: ScopedServices<S>,
): PlatformScopedOperations<S> {
  return Object.freeze(Object.fromEntries(Object.entries(schemas).map(([name, spec]) => [
    name,
    async (ctx: ExecutionContext, command?: unknown) => {
      const service = services?.[name] as
        | ((ctx: ExecutionContext, input?: unknown) => Promise<unknown>)
        | undefined;
      return executeResourceOperation(ctx, "*", command, name, spec, authorization, resourceType,
        service ? (context, _id, input) => service(context, input) : undefined);
    },
  ]))) as unknown as PlatformScopedOperations<S>;
}

/** A child grant never authorizes a forged parent/child pair, even within one organization. */
export function createChildResourceOperations<S extends Record<string, ResourceOperationSchema>>(
  schemas: S,
  authorization: Authorization,
  resourceType: ResourceType,
  services?: ChildResourceServices<S>,
  parentFor?: (ctx: ExecutionContext, id: string) => Promise<string | null | undefined>,
  options: { authorizeParent?: boolean } = {},
): PlatformChildResourceOperations<S> {
  const operations = Object.fromEntries(
    Object.entries(schemas).map(([name, spec]) => [
      name,
      async (ctx: ExecutionContext, parent: string, value: string, command?: unknown) => {
        const parentId = parseInput(ResourceIdSchema, parent);
        const childId = parseInput(ResourceIdSchema, value);
        const service = services?.[name] as
          | ((
              ctx: ExecutionContext,
              parentId: string,
              id: string,
              input?: unknown,
            ) => Promise<unknown>)
          | undefined;
        return executeResourceOperation(
          ctx,
          options.authorizeParent ? parentId : childId,
          command,
          name,
          spec,
          authorization,
          resourceType,
          service && parentFor
            ? async (context, _id, input) => {
                if ((await parentFor(context, childId)) !== parentId)
                  throw new NotFoundError(resourceType, childId);
                return service(context, parentId, childId, input);
              }
            : undefined,
        );
      },
    ]),
  );
  return Object.freeze(operations) as unknown as PlatformChildResourceOperations<S>;
}
