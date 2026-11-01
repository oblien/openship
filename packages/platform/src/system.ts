import { Value } from "@sinclair/typebox/value";
import { AppError, SystemOperationSchemas, SystemInfoSchema, type SystemInfo } from "@repo/contracts";
import type { Authorization } from "./authorization";
import type { InstanceAuthorization } from "./instance-authorization";
import type { ExecutionContext } from "./context";
import type { OperationResult } from "./deployments";
import { createScopedOperations, type ScopedServices, type PlatformScopedOperations } from "./resource-operations";

export interface SystemDependencies {
  instanceAuthorization: InstanceAuthorization;
  operations: ScopedServices<typeof SystemOperationSchemas>;
  info(): Promise<SystemInfo>;
}
export type PlatformSystemOperations = PlatformScopedOperations<typeof SystemOperationSchemas> & {
  info(ctx: ExecutionContext): Promise<OperationResult<SystemInfo>>;
};

export function createSystemOperations(authorization: Authorization, deps?: SystemDependencies): PlatformSystemOperations {
  const services = deps && Object.fromEntries(Object.entries(SystemOperationSchemas).map(([name, spec]) => [name,
    async (ctx: ExecutionContext, input: unknown) => {
      if ("instance" in spec) await deps.instanceAuthorization.assert(ctx, spec.action === "read" ? "read" : "write");
      const service = deps.operations[name as keyof typeof deps.operations] as (ctx: ExecutionContext, input: unknown) => Promise<unknown>;
      return service(ctx, input);
    },
  ])) as ScopedServices<typeof SystemOperationSchemas> | undefined;
  return Object.freeze({
    ...createScopedOperations(SystemOperationSchemas, authorization, "settings", services),
    async info(ctx: ExecutionContext) {
      if (!deps) throw new AppError("System information is not configured", 501, "CAPABILITY_UNAVAILABLE");
      const data: unknown = JSON.parse(JSON.stringify(await deps.info()));
      if (!Value.Check(SystemInfoSchema, data)) throw new AppError("Invalid system information response", 500, "INVALID_OPERATION_RESPONSE");
      return { context: ctx, data };
    },
  });
}
