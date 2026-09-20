import { AppError, NotFoundError, safeErrorMessage } from "@repo/core";
import { OperationError, ProjectTransferSchemas } from "@repo/contracts";
import type { ResourceServices } from "../../../resource-operations";
import type { ProjectDependencies } from "../../../projects";
import type { ExecutionContext } from "../../../context";
import { env } from "../../config/index";

function assertTransferScope(ctx: ExecutionContext) {
  if (env.CLOUD_MODE) throw new NotFoundError("Transfer");
  // Owner-account sessions do not prove a mapping to the SDK's fixed tenant.
  if (ctx.scopeMode === "fixed")
    throw new AppError("This cloud link has no tenant mapping. Connect directly with the cloud organizationId.", 409, "CLOUD_SCOPE_UNAVAILABLE");
}

async function transferFailure(error: unknown, fallback: string): Promise<never> {
  if (error instanceof AppError) throw error;
  const service = await import("./transfer.service");
  if (error instanceof service.TransferAlreadyOnTargetError)
    throw new OperationError(error.message, 409, error.code, { side: error.side });
  if (error instanceof service.TransferConflictError)
    throw new OperationError(error.message, 409, error.code, { conflictKind: error.conflictKind, conflictValue: error.conflictValue });
  if (error instanceof service.TransferNotConnectedError)
    throw new OperationError(error.message, 412, error.code);
  if (error instanceof service.TransferCloudCallFailedError)
    throw new OperationError(error.message, 502, error.code);
  if (error instanceof service.TransferProjectNotFoundError)
    throw new OperationError(error.message, 404, error.code);
  throw new OperationError(error instanceof Error ? safeErrorMessage(error) : fallback, 500, "TRANSFER_FAILED");
}

export function createProjectTransferOperations(recordAudit: ProjectDependencies["recordAudit"]): ResourceServices<typeof ProjectTransferSchemas> {
  const record = (ctx: ExecutionContext, id: string, direction: string, data: unknown) => recordAudit(ctx, {
    eventType: "project.updated", resourceType: "project", resourceId: id,
    after: { action: "transfer", direction, result: data },
  });
  return {
    async transferToCloud(ctx, id) {
      assertTransferScope(ctx);
      try {
        const result = await (await import("./transfer.service")).promoteProjectToCloud(ctx, id);
        const data = !result.localRemoved
          ? { ok: false, code: "PROMOTE_LOCAL_CLEANUP_FAILED", projectId: result.projectId, imported: result.imported,
              message: "Promoted to cloud, but local cleanup failed. Retry to remove the local copy." }
          : { ok: true, projectId: result.projectId, imported: result.imported,
              ...(result.unrecoverableSteps > 0 && { warning: "Promoted to cloud; some local resources need manual cleanup." }) };
        record(ctx, id, "cloud", data);
        return data;
      } catch (error) { return transferFailure(error, "Project transfer to cloud failed"); }
    },
    async transferToSelfHosted(ctx, id) {
      assertTransferScope(ctx);
      try {
        const result = await (await import("./transfer.service")).transferProjectToSelfHosted({ projectId: id, organizationId: ctx.organizationId });
        const data = { ok: true, projectId: result.projectId, cloudWorkspaceId: null, imported: result.imported };
        record(ctx, id, "self-hosted", data);
        return data;
      } catch (error) { return transferFailure(error, "Project transfer to self-hosted failed"); }
    },
  };
}
