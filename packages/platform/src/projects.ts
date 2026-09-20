import {
  AppError, CreateProjectBody, EnsureProjectBody, UpdateProjectBody, ListProjectsSchema,
  ResourceIdSchema, RuntimeLogsInputSchema, ServerLogsInputSchema, parseInput, isProject, isProjectHome,
  ProjectControlSchemas,
  ImportLocalProjectBody, ScanLocalProjectBody, isLocalProjectScan,
  type LocalProjectScan, type ImportLocalProjectInput,
  type Project, type ProjectOperations, type CreateProjectInput, type EnsureProjectInput,
  type EnsureProjectResult, type UpdateProjectInput, type ListProjectsInput, type ProjectLogStreams, type ServerLogsInput,
} from "@repo/contracts";
import type { Authorization } from "./authorization";
import type { ExecutionContext } from "./context";
import type { OperationResult } from "./deployments";
import { createResourceOperations, type ResourceServices } from "./resource-operations";
import { subscriptionEvents, type EventSubscription } from "./event-stream";

export type PlatformProjectOperations = {
  [K in Exclude<keyof ProjectOperations, keyof ProjectLogStreams>]: (ctx: ExecutionContext, ...args: Parameters<ProjectOperations[K]>) =>
    Promise<OperationResult<Awaited<ReturnType<ProjectOperations[K]>>>>;
} & {
  streamRuntimeLogs(ctx: ExecutionContext, ...args: Parameters<ProjectLogStreams["streamRuntimeLogs"]>): ReturnType<ProjectLogStreams["streamRuntimeLogs"]>;
  /** Raw provider bytes keep HTTP relay framing intact; SDK facades decode them with the shared SSE codec. */
  openServerLogStream(ctx: ExecutionContext, id: string, input?: ServerLogsInput, options?: { signal?: AbortSignal }): Promise<OperationResult<AsyncIterable<Uint8Array>>>;
};
export interface ProjectDependencies {
  controls?: ResourceServices<typeof ProjectControlSchemas>;
  home?(ctx: ExecutionContext): Promise<unknown>;
  subscribeLogs?(ctx: ExecutionContext, id: string, input: { tail?: number }): EventSubscription;
  openServerLogs?(ctx: ExecutionContext, id: string, input: ServerLogsInput, options: { signal?: AbortSignal }): Promise<AsyncIterable<Uint8Array>>;
  create(ctx: ExecutionContext, input: CreateProjectInput): Promise<unknown>;
  ensure(ctx: ExecutionContext, input: EnsureProjectInput): Promise<EnsureProjectResult>;
  list(ctx: ExecutionContext, input: ListProjectsInput): Promise<{ rows: unknown[]; total: number; page: number; perPage: number }>;
  get(ctx: ExecutionContext, id: string): Promise<unknown>;
  update(ctx: ExecutionContext, id: string, input: UpdateProjectInput): Promise<unknown>;
  local?: {
    scan(ctx: ExecutionContext, input: Parameters<ProjectOperations["scanLocal"]>[0]): Promise<LocalProjectScan>;
    import(ctx: ExecutionContext, input: ImportLocalProjectInput): Promise<{ project: unknown; serviceCount: number }>;
    list(ctx: ExecutionContext): Promise<unknown[]>;
  };
  recordAudit(ctx: ExecutionContext, event: { eventType: string; resourceType: "project"; resourceId: string; before?: unknown; after?: unknown }): void;
}

/** One public presentation for HTTP, native and remote project operations. */
export function presentProject(row: unknown): Project {
  const data = JSON.parse(JSON.stringify(row)) as Record<string, unknown>;
  delete data.cloneTokenEncrypted;
  delete data.webhookSecret;
  if (!isProject(data)) throw new AppError("Invalid project presentation", 500, "INVALID_PROJECT_RESPONSE");
  return data;
}

export function createProjectOperations(authorization: Authorization, dependencies?: ProjectDependencies): PlatformProjectOperations {
  const resources = () => {
    if (!dependencies) throw new AppError("Project operations are not configured", 501, "CAPABILITY_UNAVAILABLE");
    return dependencies;
  };
  const authorize = (ctx: ExecutionContext, id: string, action: "read" | "write", projectCreate = false) =>
    authorization.authorize(ctx, { resourceType: "project", resourceId: id, action, projectCreate });
  function audit(ctx: ExecutionContext, id: string, created: boolean, after: unknown) {
    resources().recordAudit(ctx, { eventType: created ? "project.created" : "project.updated", resourceType: "project", resourceId: id, after });
  }
  const local = () => {
    const implementation = resources().local;
    if (!implementation) throw new AppError("Local project operations are not configured", 501, "CAPABILITY_UNAVAILABLE");
    return implementation;
  };
  return Object.freeze({
    ...createResourceOperations(ProjectControlSchemas, authorization, "project", dependencies?.controls),
    async getHome(ctx) {
      const context = await authorization.authorize(ctx, { resourceType: "project", resourceId: "*", action: "read", scope: "list" });
      const home = resources().home;
      if (!home) throw new AppError("Project overview is not configured", 501, "CAPABILITY_UNAVAILABLE");
      const data: unknown = JSON.parse(JSON.stringify(await home(context)));
      if (!isProjectHome(data)) throw new AppError("Invalid project overview response", 500, "INVALID_PROJECT_RESPONSE");
      // Apply the same secret projection even to custom platform compositions.
      return { context, data: { ...data, projects: data.projects.map(presentProject) } };
    },
    async *streamRuntimeLogs(ctx, value, command = {}, options = {}) {
      const id = parseInput(ResourceIdSchema, value);
      const input = parseInput(RuntimeLogsInputSchema, command);
      const context = await authorize(ctx, id, "read");
      const subscribe = resources().subscribeLogs;
      if (!subscribe) throw new AppError("Project log streaming is not configured", 501, "CAPABILITY_UNAVAILABLE");
      for await (const event of subscriptionEvents(subscribe(context, id, input), options.signal)) {
        await authorize(context, id, "read");
        yield event;
      }
    },
    async openServerLogStream(ctx, value, command = {}, options = {}) {
      const id = parseInput(ResourceIdSchema, value);
      const input = parseInput(ServerLogsInputSchema, command);
      options.signal?.throwIfAborted();
      const context = await authorize(ctx, id, "read");
      const open = resources().openServerLogs;
      if (!open) throw new AppError("Project traffic streaming is not configured", 501, "CAPABILITY_UNAVAILABLE");
      const source = await open(context, id, input, options);
      return { context, data: (async function* () {
        for await (const chunk of source) {
          options.signal?.throwIfAborted();
          await authorize(context, id, "read");
          yield chunk;
        }
      })() };
    },
    async scanLocal(ctx, value) {
      const input = parseInput(ScanLocalProjectBody, value);
      const context = await authorize(ctx, "*", "write");
      const data = await local().scan(context, input);
      if (!isLocalProjectScan(data)) throw new AppError("Invalid local scan response", 500, "INVALID_SOURCE_RESPONSE");
      resources().recordAudit(context, { eventType: "project:write", resourceType: "project", resourceId: "*", after: { operation: "local.scan", path: input.path, ...(input.includeEnv && { includeEnv: true }) } });
      return { context, data };
    },
    async importLocal(ctx, value) {
      const input = parseInput(ImportLocalProjectBody, value);
      const context = await authorize(ctx, "*", "write", true);
      const result = await local().import(context, input);
      const data = presentProject(result.project);
      audit(context, data.id, true, { source: "local", localPath: input.localPath, serviceCount: result.serviceCount });
      return { context, data };
    },
    async listLocal(ctx) {
      const context = await authorization.authorize(ctx, { resourceType: "project", resourceId: "*", action: "read", scope: "list" });
      return { context, data: { success: true, projects: (await local().list(context)).map(presentProject) } };
    },
    async create(ctx, value) {
      const input = parseInput(CreateProjectBody, value);
      const context = await authorize(ctx, "*", "write", true);
      const data = presentProject(await resources().create(context, input));
      audit(context, data.id, true, { name: data.name, slug: data.slug, framework: data.framework ?? null, gitProvider: data.gitProvider ?? null, gitOwner: data.gitOwner ?? null, gitRepo: data.gitRepo ?? null, gitBranch: data.gitBranch ?? null });
      return { context, data };
    },
    async ensure(ctx, value) {
      const input = parseInput(EnsureProjectBody, value);
      // Name matching can mutate an existing project. A create-only grant is
      // deliberately insufficient; callers can use create then deploy its id.
      const context = await authorize(ctx, input.projectId ?? "*", "write");
      const data = await resources().ensure(context, input);
      audit(context, data.project_id, data.created, { name: input.name, slug: input.slug ?? null, gitBranch: input.gitBranch ?? null, port: input.port ?? null });
      return { context, data };
    },
    async list(ctx, value = {}) {
      const input = parseInput(ListProjectsSchema, value);
      const context = await authorization.authorize(ctx, { resourceType: "project", resourceId: "*", action: "read", scope: "list" });
      const result = await resources().list(context, input);
      return { context, data: { data: result.rows.map(presentProject), total: result.total, page: result.page, perPage: result.perPage } };
    },
    async get(ctx, value) {
      const id = parseInput(ResourceIdSchema, value);
      const context = await authorize(ctx, id, "read");
      return { context, data: presentProject(await resources().get(context, id)) };
    },
    async update(ctx, value, command) {
      const id = parseInput(ResourceIdSchema, value);
      const input = parseInput(UpdateProjectBody, command);
      const context = await authorize(ctx, id, "write");
      const data = presentProject(await resources().update(context, id, input));
      audit(context, id, false, { name: data.name, slug: data.slug, gitOwner: data.gitOwner ?? null, gitRepo: data.gitRepo ?? null, gitBranch: data.gitBranch ?? null });
      return { context, data };
    },
  } satisfies PlatformProjectOperations);
}
