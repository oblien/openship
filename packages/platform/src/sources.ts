import { AppError, FolderSessionBody, ResourceIdSchema, RevealSourceSchema, SourceScanOptionsSchema, parseInput, isStagedSource, isFolderSessionResult, isSourceScan,
  type SourceOperations, type StageSourceInput, type StagedSource, type SourceScan, type SourceScanOptions, type FolderSessionResult } from "@repo/contracts";
import type { Authorization } from "./authorization";
import type { ExecutionContext } from "./context";
import type { OperationResult } from "./deployments";

export interface SourceDependencies {
  open(ctx: ExecutionContext, input: { projectId?: string; name?: string; stack?: string; packageManager?: string }, apiBaseUrl?: string): Promise<FolderSessionResult>;
  projectForSession(ctx: ExecutionContext, id: string): string | undefined;
  stage(ctx: ExecutionContext, input: StageSourceInput): Promise<StagedSource>;
  scan(ctx: ExecutionContext, id: string, options: SourceScanOptions): Promise<SourceScan>;
  reveal(ctx: ExecutionContext, id: string, input: { service: string; keys: string[] }): Promise<Record<string, string>>;
  upload(ctx: ExecutionContext, id: string, ticket: string, body: ReadableStream<Uint8Array>): Promise<void>;
  recordAudit(ctx: ExecutionContext, operation: string, id: string, after?: unknown): void;
}
export interface PlatformSourceOperations {
  open(ctx: ExecutionContext, input?: { projectId?: string; name?: string; stack?: string; packageManager?: string }, options?: { apiBaseUrl?: string }): Promise<OperationResult<FolderSessionResult>>;
  stage(ctx: ExecutionContext, input: StageSourceInput): Promise<OperationResult<StagedSource>>;
  scan(ctx: ExecutionContext, id: string, options?: SourceScanOptions): Promise<OperationResult<SourceScan>>;
  reveal(ctx: ExecutionContext, id: string, input: Parameters<SourceOperations["reveal"]>[1]): Promise<OperationResult<Record<string, string>>>;
  upload(ctx: ExecutionContext, id: string, ticket: string, body: ReadableStream<Uint8Array>): Promise<OperationResult<{ success: boolean }>>;
}

export function createSourceOperations(authorization: Authorization, dependencies?: SourceDependencies): PlatformSourceOperations {
  const resources = () => {
    if (!dependencies) throw new AppError("Source operations are not configured", 501, "CAPABILITY_UNAVAILABLE");
    return dependencies;
  };
  const authorize = (ctx: ExecutionContext, projectId?: string) => authorization.authorize(ctx, { resourceType: "project", resourceId: projectId ?? "*", action: "write" });
  return Object.freeze({
    async open(ctx, value = {}, options = {}) {
      const input = parseInput(FolderSessionBody, value);
      const context = await authorize(ctx, input.projectId);
      const data = await resources().open(context, input, options.apiBaseUrl);
      if (!isFolderSessionResult(data)) throw new AppError("Invalid upload session response", 500, "INVALID_SOURCE_RESPONSE");
      resources().recordAudit(context, "source.open", data.sessionId);
      return { context, data };
    },
    async stage(ctx, value) {
      const input = structuredClone(value);
      const hints = parseInput(FolderSessionBody, input);
      const context = await authorize(ctx, hints.projectId);
      const data = await resources().stage(context, input);
      if (!isStagedSource(data)) throw new AppError("Invalid staged source response", 500, "INVALID_SOURCE_RESPONSE");
      resources().recordAudit(context, "source.stage", data.sessionId);
      return { context, data };
    },
    async scan(ctx, value, options = {}) {
      const input = parseInput(SourceScanOptionsSchema, options);
      const id = parseInput(ResourceIdSchema, value), context = await authorize(ctx, resources().projectForSession(ctx, id));
      const data = await resources().scan(context, id, input);
      if (!isSourceScan(data)) throw new AppError("Invalid source scan response", 500, "INVALID_SOURCE_RESPONSE");
      resources().recordAudit(context, "source.scan", id, input.includeEnv ? { includeEnv: true } : undefined);
      return { context, data };
    },
    async reveal(ctx, value, command) {
      const id = parseInput(ResourceIdSchema, value), input = parseInput(RevealSourceSchema, command);
      const context = await authorize(ctx, resources().projectForSession(ctx, id));
      const data = await resources().reveal(context, id, input);
      resources().recordAudit(context, "source.reveal", id, { service: input.service, revealedEnvKeys: Object.keys(data) });
      return { context, data };
    },
    async upload(ctx, value, ticket, body) {
      const id = parseInput(ResourceIdSchema, value), context = await authorize(ctx, resources().projectForSession(ctx, id));
      await resources().upload(context, id, ticket, body);
      resources().recordAudit(context, "source.upload", id);
      return { context, data: { success: true } };
    },
  } satisfies PlatformSourceOperations);
}
