import {
  parseCreateDeploymentInput,
  type CreateDeploymentInput,
  type CreateDeploymentResult,
  type Deployment,
  type DeploymentOperations,
} from "@repo/contracts";
import type { Authorization } from "./authorization";
import type { ExecutionContext } from "./context";
import {
  createDeploymentResourceOperations,
  type DeploymentResourceDependencies,
} from "./deployment-resources";
import { createBuildOperations, type BuildDependencies } from "./builds";

/** Existing persistence representation; the presenter converts dates and masks secrets. */
export type StoredDeployment = Omit<
  Deployment,
  "createdAt" | "updatedAt" | "artifactRetainedAt"
> & {
  /** Internal rollback/build snapshot. Public presenters must omit this map. */
  envVars: unknown;
  createdAt: Date;
  updatedAt: Date;
  artifactRetainedAt: Date | null;
};

/** Trusted transport compatibility metadata. Not exposed on the native facade. */
export interface DeploymentExecutionOptions {
  trigger?: "webhook";
  projectSource?: "local" | "cloud";
}

export interface DeploymentDependencies {
  authorization: Authorization;
  resources?: DeploymentResourceDependencies;
  builds?: BuildDependencies;
  trigger(
    ctx: ExecutionContext,
    input: CreateDeploymentInput & { trigger?: "webhook" },
  ): Promise<{ deployment: StoredDeployment; skipped?: boolean }>;
  present(deployment: StoredDeployment): Deployment;
  /** Typed external gateway; never a request to this same process's HTTP server. */
  forward?(
    ctx: ExecutionContext,
    input: CreateDeploymentInput,
    options: DeploymentExecutionOptions,
  ): Promise<CreateDeploymentResult | null>;
  /** Same best-effort audit semantics as the existing HTTP deployment route. */
  recordAudit(
    ctx: ExecutionContext,
    event: {
      eventType: "deployment:write" | "deployment:admin";
      resourceType: "deployment";
      resourceId: string;
    },
  ): void;
}

export interface OperationResult<T> {
  readonly context: ExecutionContext;
  readonly data: T;
}

/** The public contracts with an authorized context at the application boundary. */
export type PlatformDeploymentOperations = {
  [K in Exclude<keyof DeploymentOperations, "create">]: (
    ctx: ExecutionContext,
    ...args: Parameters<DeploymentOperations[K]>
  ) => ReturnType<DeploymentOperations[K]> extends Promise<infer T>
    ? Promise<OperationResult<T>>
    : ReturnType<DeploymentOperations[K]>;
} & {
  create(
    ctx: ExecutionContext,
    input: unknown,
    options?: DeploymentExecutionOptions,
  ): Promise<OperationResult<CreateDeploymentResult>>;
};

export function createDeploymentOperations(
  deps: DeploymentDependencies,
): PlatformDeploymentOperations {
  return Object.freeze({
    ...createDeploymentResourceOperations(deps),
    ...createBuildOperations(deps.authorization, deps.builds),
    async create(
      ctx: ExecutionContext,
      value: unknown,
      options: DeploymentExecutionOptions = {},
    ): Promise<OperationResult<CreateDeploymentResult>> {
      const input = parseCreateDeploymentInput(value);
      const authorized = await deps.authorization.authorize(ctx, {
        resourceType: "project",
        resourceId: input.projectId,
        action: "write",
      });
      // The existing engine validates registered-server ownership and runtime
      // admission using this resolved organization, along with source access,
      // billing, preflight, and build locks.
      let result = await deps.forward?.(authorized, input, options);
      if (!result) {
        const triggered = await deps.trigger(authorized, { ...input, trigger: options.trigger });
        result = {
          deployment_id: triggered.deployment.id,
          project_id: triggered.deployment.projectId,
          deployment: deps.present(triggered.deployment),
          ...(triggered.skipped !== undefined && { skipped: triggered.skipped }),
        };
      }
      deps.recordAudit(authorized, {
        eventType: "deployment:write",
        resourceType: "deployment",
        resourceId: result.deployment_id,
      });
      return { context: authorized, data: result };
    },
  });
}
