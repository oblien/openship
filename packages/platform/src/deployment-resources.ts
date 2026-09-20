import {
  AppError, parseInput, ResourceIdSchema, ListDeploymentsSchema, DeploymentLogsSchema,
  RedeploySchema, RespondSchema, PinSchema, SkipPortCheckSchema,
  DeploymentControlSchemas, DeploymentSslSchemas,
  type CancellationResult, type CreateDeploymentResult, type Deployment,
  type DeploymentBuildStatus, type DeploymentRestorePlan, type DeploymentEventOptions,
  type ListDeploymentsInput, type LogEntry,
} from "@repo/contracts";
import type { ExecutionContext } from "./context";
import type { DeploymentDependencies, PlatformDeploymentOperations, StoredDeployment } from "./deployments";
import { subscriptionEvents, type EventSubscription } from "./event-stream";
import { createResourceOperations, createScopedOperations, type ResourceServices, type ScopedServices } from "./resource-operations";

/** Ports over the existing engine. All policy and presentation stay in this operation layer. */
export interface DeploymentResourceDependencies {
  controls?: ResourceServices<typeof DeploymentControlSchemas>;
  ssl?: ScopedServices<typeof DeploymentSslSchemas>;
  get(id: string, organizationId: string): Promise<StoredDeployment>;
  list(organizationId: string, input: ListDeploymentsInput): Promise<{ rows: StoredDeployment[]; total: number; page: number; perPage: number; projects?: Array<{ id: string; name: string }> }>;
  logs(id: string, organizationId: string, tail?: number): Promise<LogEntry[]>;
  buildStatus(id: string): Promise<DeploymentBuildStatus>;
  reconcile(id: string): void;
  restorePlan(id: string, organizationId: string): Promise<DeploymentRestorePlan>;
  assertRepositoryAccess(ctx: ExecutionContext, id: string, organizationId: string): Promise<void>;
  rollback(id: string, organizationId: string): Promise<StoredDeployment>;
  cancel(id: string): Promise<CancellationResult>;
  respond(id: string, action: string): Promise<boolean>;
  redeploy(ctx: ExecutionContext, id: string, input: { useExistingCommit?: boolean }): Promise<CreateDeploymentResult>;
  pin(id: string, organizationId: string, pinned: boolean): Promise<StoredDeployment>;
  keep(id: string, organizationId: string): Promise<{ success: boolean; deployment: StoredDeployment }>;
  reject(id: string, organizationId: string): Promise<{ success: boolean; restoredDeploymentId: string | null }>;
  remove(id: string, organizationId: string): Promise<void>;
  restart(id: string, organizationId: string): Promise<StoredDeployment>;
  skipPortCheck(id: string, organizationId: string, target: string | number): Promise<{ success: boolean }>;
  subscribe(id: string, write: Parameters<EventSubscription>[0], since?: number): ReturnType<EventSubscription>;
}

export function createDeploymentResourceOperations(deps: DeploymentDependencies): Omit<PlatformDeploymentOperations, "create" | keyof import("@repo/contracts").BuildOperations> {
  const resources = () => {
    if (!deps.resources) throw new AppError("Deployment resources are not configured", 501, "CAPABILITY_UNAVAILABLE");
    return deps.resources;
  };
  async function authorize(ctx: ExecutionContext, value: unknown, action: "read" | "write" | "admin") {
    const id = parseInput(ResourceIdSchema, value);
    const context = await deps.authorization.authorize(ctx, { resourceType: "deployment", resourceId: id, action });
    // Match the engine's double ownership check: both the deployment row and
    // its parent must still belong to this organization before any side effect.
    const deployment = await resources().get(id, context.organizationId);
    return { context, id, deployment };
  }
  function complete<T>(context: ExecutionContext, id: string, data: T, audit?: "write" | "admin") {
    const presented = JSON.parse(JSON.stringify(data)) as T;
    if (audit) deps.recordAudit(context, { eventType: `deployment:${audit}`, resourceType: "deployment", resourceId: id });
    return { context, data: presented };
  }
  return Object.freeze({
    ...createResourceOperations(DeploymentControlSchemas, deps.authorization, "deployment", deps.resources?.controls),
    ...createScopedOperations(DeploymentSslSchemas, deps.authorization, "deployment", deps.resources?.ssl),
    async get(ctx: ExecutionContext, id: string) {
      const checked = await authorize(ctx, id, "read");
      if (checked.deployment.status === "reconciling") resources().reconcile(checked.id);
      return complete(checked.context, id, deps.present(checked.deployment));
    },
    async list(ctx: ExecutionContext, value: ListDeploymentsInput = {}) {
      const input = parseInput(ListDeploymentsSchema, value);
      const context = await deps.authorization.authorize(ctx, { resourceType: "deployment", resourceId: "*", action: "read", scope: "list" });
      if (input.projectId) await deps.authorization.authorize(context, { resourceType: "project", resourceId: input.projectId, action: "read" });
      const result = await resources().list(context.organizationId, input);
      return { context, data: {
        data: result.rows.map(deps.present), total: result.total, page: result.page, perPage: result.perPage,
        ...(result.projects ? { projects: result.projects } : {}),
      } };
    },
    async logs(ctx: ExecutionContext, id: string, value: { tail?: number } = {}) {
      const input = parseInput(DeploymentLogsSchema, value);
      const checked = await authorize(ctx, id, "read");
      return complete(checked.context, id, await resources().logs(id, checked.context.organizationId, input.tail));
    },
    async buildStatus(ctx: ExecutionContext, id: string) {
      const checked = await authorize(ctx, id, "read");
      return complete(checked.context, id, await resources().buildStatus(id));
    },
    async restorePlan(ctx: ExecutionContext, id: string) {
      const checked = await authorize(ctx, id, "read");
      return complete(checked.context, id, await resources().restorePlan(id, checked.context.organizationId));
    },
    async rollback(ctx: ExecutionContext, id: string) {
      const { context } = await authorize(ctx, id, "admin");
      const preview = await resources().restorePlan(id, context.organizationId);
      if (preview.needsRepository) await resources().assertRepositoryAccess(context, id, context.organizationId);
      return complete(context, id, deps.present(await resources().rollback(id, context.organizationId)), "write");
    },
    async cancel(ctx: ExecutionContext, id: string) {
      const { context } = await authorize(ctx, id, "admin");
      return complete(context, id, await resources().cancel(id), "write");
    },
    async respond(ctx: ExecutionContext, id: string, value: { action: string }) {
      const input = parseInput(RespondSchema, value);
      const { context } = await authorize(ctx, id, "write");
      const data = { success: await resources().respond(id, input.action) };
      return complete(context, id, data, "write");
    },
    async redeploy(ctx: ExecutionContext, id: string, value: { useExistingCommit?: boolean } = {}) {
      const input = parseInput(RedeploySchema, value);
      const { context } = await authorize(ctx, id, "write");
      return complete(context, id, await resources().redeploy(context, id, input), "write");
    },
    async pin(ctx: ExecutionContext, id: string, value: { pinned?: boolean } = {}) {
      const input = parseInput(PinSchema, value);
      const { context } = await authorize(ctx, id, "write");
      return complete(context, id, deps.present(await resources().pin(id, context.organizationId, input.pinned !== false)), "write");
    },
    async keep(ctx: ExecutionContext, id: string) {
      const { context } = await authorize(ctx, id, "write");
      const result = await resources().keep(id, context.organizationId);
      return complete(context, id, { success: result.success, deployment: deps.present(result.deployment) }, "write");
    },
    async reject(ctx: ExecutionContext, id: string) {
      const { context } = await authorize(ctx, id, "write");
      return complete(context, id, await resources().reject(id, context.organizationId), "write");
    },
    async remove(ctx: ExecutionContext, id: string) {
      const { context } = await authorize(ctx, id, "admin");
      await resources().remove(id, context.organizationId);
      return complete(context, id, { success: true, message: "Deployment deleted" }, "admin");
    },
    async restart(ctx: ExecutionContext, id: string) {
      const { context } = await authorize(ctx, id, "write");
      return complete(context, id, deps.present(await resources().restart(id, context.organizationId)), "write");
    },
    async skipPortCheck(ctx: ExecutionContext, id: string, value: { target: number | string }) {
      const input = parseInput(SkipPortCheckSchema, value);
      const { context } = await authorize(ctx, id, "write");
      return complete(context, id, await resources().skipPortCheck(id, context.organizationId, input.target), "write");
    },
    async *events(ctx: ExecutionContext, id: string, options: DeploymentEventOptions = {}) {
      const { since, signal } = options;
      if (since !== undefined && (!Number.isSafeInteger(since) || since < 0))
        throw new AppError("since must be a nonnegative event cursor", 400, "VALIDATION_ERROR");
      signal?.throwIfAborted();
      const { context } = await authorize(ctx, id, "read");
      for await (const event of subscriptionEvents((write) => resources().subscribe(id, write, since), signal)) {
        // An open stream must not preserve revoked resource grants.
        await deps.authorization.authorize(context, { resourceType: "deployment", resourceId: id, action: "read" });
        yield event;
      }
    },
  });
}
