import { Value } from "@sinclair/typebox/value";
import {
  AppError, OperationError, ResourceIdSchema, parseInput, ServerCollectionSchemas, ServerResourceSchemas,
  ServerInstallSessionInputSchema, ServerInstallResponseInputSchema, ServerInstallSessionSchema, InstallServerComponentsInputSchema,
  type DeploymentEvent, type ServerInstallSession, type ServerInstallSessionInput, type ServerInstallResponseInput, type InstallServerComponentsInput,
  ApplyServerContainerInputSchema, ServerContainerInputSchema, type ApplyServerContainerInput, type ServerContainerInput,
} from "@repo/contracts";
import type { Authorization } from "./authorization";
import type { ExecutionContext } from "./context";
import type { OperationResult } from "./deployments";
import { createScopedOperations, createResourceOperations, type ScopedServices, type ResourceServices, type PlatformScopedOperations, type PlatformResourceOperations } from "./resource-operations";

export interface ServerDependencies {
  collection: ScopedServices<typeof ServerCollectionSchemas>;
  resources: ResourceServices<typeof ServerResourceSchemas>;
  networks?: {
    events(ctx: ExecutionContext, kind: "preparation" | "operation" | "overview", id?: string, signal?: AbortSignal): Promise<AsyncIterable<DeploymentEvent>>;
  };
  containers?: {
    start(ctx: ExecutionContext, serverId: string, input: ApplyServerContainerInput, signal?: AbortSignal): Promise<AsyncIterable<DeploymentEvent>>;
    events(ctx: ExecutionContext, serverId: string, input: ServerContainerInput, signal?: AbortSignal): Promise<AsyncIterable<DeploymentEvent>>;
  };
  installations?: {
    lookup(input: ServerInstallSessionInput): Promise<ServerInstallSession>;
    respond(ctx: ExecutionContext, sessionId: string, action: string): Promise<{ ok: true }>;
    start(ctx: ExecutionContext, serverId: string, input: InstallServerComponentsInput, signal?: AbortSignal): Promise<AsyncIterable<DeploymentEvent>>;
    events(ctx: ExecutionContext, sessionId: string, signal?: AbortSignal): AsyncIterable<DeploymentEvent>;
    monitor(ctx: ExecutionContext, serverId: string, signal?: AbortSignal): Promise<AsyncIterable<DeploymentEvent>>;
  };
}
export type PlatformServerOperations = PlatformScopedOperations<typeof ServerCollectionSchemas> & PlatformResourceOperations<typeof ServerResourceSchemas> & {
  openManagedNetworkPreparationEvents(ctx: ExecutionContext, id: string, options?: { signal?: AbortSignal }): Promise<OperationResult<AsyncIterable<DeploymentEvent>>>;
  openManagedNetworkOperationEvents(ctx: ExecutionContext, id: string, options?: { signal?: AbortSignal }): Promise<OperationResult<AsyncIterable<DeploymentEvent>>>;
  openClusterEvents(ctx: ExecutionContext, options?: { signal?: AbortSignal }): Promise<OperationResult<AsyncIterable<DeploymentEvent>>>;
  openContainerApplyStream(ctx: ExecutionContext, id: string, input: ApplyServerContainerInput, options?: { signal?: AbortSignal }): Promise<OperationResult<AsyncIterable<DeploymentEvent>>>;
  openContainerApplyEvents(ctx: ExecutionContext, id: string, input: ServerContainerInput, options?: { signal?: AbortSignal }): Promise<OperationResult<AsyncIterable<DeploymentEvent>>>;
  getInstallSession(ctx: ExecutionContext, input?: ServerInstallSessionInput): Promise<OperationResult<ServerInstallSession>>;
  respondToInstall(ctx: ExecutionContext, input: ServerInstallResponseInput): Promise<OperationResult<{ ok: true }>>;
  openInstallStream(ctx: ExecutionContext, id: string, input: InstallServerComponentsInput, options?: { signal?: AbortSignal }): Promise<OperationResult<AsyncIterable<DeploymentEvent>>>;
  openInstallEvents(ctx: ExecutionContext, input?: ServerInstallSessionInput, options?: { signal?: AbortSignal }): Promise<OperationResult<AsyncIterable<DeploymentEvent>>>;
  openMonitor(ctx: ExecutionContext, id: string, options?: { signal?: AbortSignal }): Promise<OperationResult<AsyncIterable<DeploymentEvent>>>;
};
export function createServerOperations(authorization: Authorization, deps?: ServerDependencies): PlatformServerOperations {
  function installations() {
    if (!deps?.installations) throw new AppError("Server installations are not configured", 501, "CAPABILITY_UNAVAILABLE");
    return deps.installations;
  }
  async function session(ctx: ExecutionContext, command?: ServerInstallSessionInput) {
    const input = parseInput(ServerInstallSessionInputSchema, command ?? {});
    const data: unknown = JSON.parse(JSON.stringify(await installations().lookup(input)));
    if (!Value.Check(ServerInstallSessionSchema, data)) throw new AppError("Invalid installation session response", 500, "INVALID_OPERATION_RESPONSE");
    const context = await authorization.authorize(ctx, {
      resourceType: "server", resourceId: data.active ? data.serverId : "*", action: data.active ? "admin" : "read",
    });
    return { context, data };
  }
  async function* authorizedEvents(ctx: ExecutionContext, id: string, action: "read" | "write" | "admin", source: AsyncIterable<DeploymentEvent>) {
    for await (const event of source) {
      await authorization.authorize(ctx, { resourceType: "server", resourceId: id, action, ...(id === "*" ? { scope: "all" as const } : {}) });
      yield event;
    }
  }
  async function containerStream(ctx: ExecutionContext, value: string, command: unknown, options: { signal?: AbortSignal }, apply: boolean) {
    const id = parseInput(ResourceIdSchema, value);
    const input = parseInput(apply ? ApplyServerContainerInputSchema : ServerContainerInputSchema, command);
    options.signal?.throwIfAborted();
    const action = apply ? "write" : "read";
    const context = await authorization.authorize(ctx, { resourceType: "server", resourceId: id, action });
    if (!deps?.containers) throw new AppError("Managed containers are not configured", 501, "CAPABILITY_UNAVAILABLE");
    const source = await (apply ? deps.containers.start : deps.containers.events)(context, id, input, options.signal);
    return { context, data: authorizedEvents(context, id, action, source) };
  }
  async function networkStream(ctx: ExecutionContext, kind: "preparation" | "operation" | "overview", value: string | undefined, options: { signal?: AbortSignal }) {
    const id = kind === "overview" ? undefined : parseInput(ResourceIdSchema, value);
    options.signal?.throwIfAborted();
    const context = await authorization.authorize(ctx, { resourceType: "server", resourceId: "*", action: "read", scope: "all" });
    if (!deps?.networks) throw new AppError("Network progress is not configured", 501, "CAPABILITY_UNAVAILABLE");
    const source = await deps.networks.events(context, kind, id, options.signal);
    return { context, data: authorizedEvents(context, "*", "read", source) };
  }
  return Object.freeze({
    ...createScopedOperations(ServerCollectionSchemas, authorization, "server", deps?.collection),
    ...createResourceOperations(ServerResourceSchemas, authorization, "server", deps?.resources),
    openManagedNetworkPreparationEvents: (ctx, id, options = {}) => networkStream(ctx, "preparation", id, options),
    openManagedNetworkOperationEvents: (ctx, id, options = {}) => networkStream(ctx, "operation", id, options),
    openClusterEvents: (ctx, options = {}) => networkStream(ctx, "overview", undefined, options),
    openContainerApplyStream: (ctx, id, input, options = {}) => containerStream(ctx, id, input, options, true),
    openContainerApplyEvents: (ctx, id, input, options = {}) => containerStream(ctx, id, input, options, false),
    getInstallSession: session,
    async respondToInstall(ctx, command) {
      const input = parseInput(ServerInstallResponseInputSchema, command);
      const result = await session(ctx, { sessionId: input.sessionId });
      if (!result.data.active) throw new OperationError("no_active_session", 404, "NOT_FOUND");
      return { context: result.context, data: await installations().respond(result.context, result.data.sessionId, input.action) };
    },
    async openInstallStream(ctx, value, command, options = {}) {
      const id = parseInput(ResourceIdSchema, value);
      const input = parseInput(InstallServerComponentsInputSchema, command);
      options.signal?.throwIfAborted();
      const context = await authorization.authorize(ctx, { resourceType: "server", resourceId: id, action: "admin" });
      const source = await installations().start(context, id, input, options.signal);
      return { context, data: authorizedEvents(context, id, "admin", source) };
    },
    async openInstallEvents(ctx, input, options = {}) {
      options.signal?.throwIfAborted();
      const result = await session(ctx, input);
      if (!result.data.active) throw new OperationError("No active session", 404, "NOT_FOUND");
      const source = installations().events(result.context, result.data.sessionId, options.signal);
      return { context: result.context, data: authorizedEvents(result.context, result.data.serverId, "admin", source) };
    },
    async openMonitor(ctx, value, options = {}) {
      const id = parseInput(ResourceIdSchema, value);
      options.signal?.throwIfAborted();
      const context = await authorization.authorize(ctx, { resourceType: "server", resourceId: id, action: "read" });
      const source = await installations().monitor(context, id, options.signal);
      return { context, data: authorizedEvents(context, id, "read", source) };
    },
  });
}
