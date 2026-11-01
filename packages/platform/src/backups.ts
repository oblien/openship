import { AppError, BackupProjectSchemas, BackupPolicySchemas, BackupRunSchemas, BackupRestoreSchemas, ResourceIdSchema, parseInput, type DeploymentEvent } from "@repo/contracts";
import type { Authorization } from "./authorization";
import type { ExecutionContext } from "./context";
import type { OperationResult } from "./deployments";
import { createResourceOperations, type ResourceServices, type PlatformResourceOperations } from "./resource-operations";

export interface BackupDependencies {
  projects: ResourceServices<typeof BackupProjectSchemas>;
  policies: ResourceServices<typeof BackupPolicySchemas>;
  runs: ResourceServices<typeof BackupRunSchemas>;
  restores: ResourceServices<typeof BackupRestoreSchemas>;
  events(ctx: ExecutionContext, kind: "run" | "restore", id: string, signal?: AbortSignal): AsyncIterable<DeploymentEvent>;
}
export type PlatformBackupOperations = PlatformResourceOperations<typeof BackupProjectSchemas> &
  PlatformResourceOperations<typeof BackupPolicySchemas> & PlatformResourceOperations<typeof BackupRunSchemas> &
  PlatformResourceOperations<typeof BackupRestoreSchemas> & {
    openRunStream(ctx: ExecutionContext, id: string, options?: { signal?: AbortSignal }): Promise<OperationResult<AsyncIterable<DeploymentEvent>>>;
    openRestoreStream(ctx: ExecutionContext, id: string, options?: { signal?: AbortSignal }): Promise<OperationResult<AsyncIterable<DeploymentEvent>>>;
  };
export function createBackupOperations(authorization: Authorization, deps?: BackupDependencies): PlatformBackupOperations {
  async function open(ctx: ExecutionContext, kind: "run" | "restore", value: string, signal?: AbortSignal) {
    const id = parseInput(ResourceIdSchema, value);
    const resourceType = kind === "run" ? "backup_run" : "backup_restore";
    const context = await authorization.authorize(ctx, { resourceType, resourceId: id, action: "read" });
    if (!deps) throw new AppError("Backup operations are not configured", 501, "CAPABILITY_UNAVAILABLE");
    const source = deps.events(context, kind, id, signal);
    async function* events() {
      for await (const event of source) {
        await authorization.authorize(context, { resourceType, resourceId: id, action: "read" });
        yield event;
      }
    }
    return { context, data: events() };
  }
  return Object.freeze({
    ...createResourceOperations(BackupProjectSchemas, authorization, "project", deps?.projects),
    ...createResourceOperations(BackupPolicySchemas, authorization, "backup_policy", deps?.policies),
    ...createResourceOperations(BackupRunSchemas, authorization, "backup_run", deps?.runs),
    ...createResourceOperations(BackupRestoreSchemas, authorization, "backup_restore", deps?.restores),
    openRunStream: (ctx, id, options = {}) => open(ctx, "run", id, options.signal),
    openRestoreStream: (ctx, id, options = {}) => open(ctx, "restore", id, options.signal),
  });
}
