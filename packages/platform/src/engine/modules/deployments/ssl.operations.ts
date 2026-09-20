import { AppError, OperationError, type DeploymentSslSchemas } from "@repo/contracts";
import type { ScopedServices } from "../../../resource-operations";
import type { ExecutionContext } from "../../../context";
import { authorization } from "../../lib/authorization";
import { audit, operationAuditContext } from "../../lib/audit-emitter";
import { domainExecution } from "../domains/domain.operations";
import * as service from "./ssl.service";

function access(ctx: ExecutionContext, action: "read" | "write") {
  return async (domainId: string) => {
    const context = await authorization.authorize({ ...ctx, scopeMode: "fixed" }, { resourceType: "domain", resourceId: domainId, action });
    if (action === "write") await domainExecution(context, domainId);
  };
}

function failure(error: unknown, message: string): never {
  // Preserve explicit authorization/provider policy refusals. The legacy SSL
  // endpoints otherwise report a failed certificate operation as HTTP 400.
  if (error instanceof AppError && error.statusCode === 403) throw error;
  const reason = error instanceof Error ? error.message : message;
  throw new OperationError(reason, 400, "SSL_OPERATION_FAILED", { success: false });
}

export const deploymentSslOperations: ScopedServices<typeof DeploymentSslSchemas> = {
  async sslStatus(ctx, input) {
    try { return { success: true, ...await service.getStatus(input.domain, ctx.organizationId, access(ctx, "read")) }; }
    catch (error) { failure(error, "Failed to check SSL status"); }
  },
  async renewSsl(ctx, input) {
    try {
      const result = await service.renew(input.domain, ctx.organizationId, input.includeWww, access(ctx, "write"));
      audit.recordAsync(operationAuditContext(ctx), { eventType: "deployment:write", resourceType: "deployment", resourceId: "*",
        after: { operation: "renewSsl", domain: input.domain, includeWww: input.includeWww === true, results: result.results } });
      return result;
    } catch (error) { failure(error, "Failed to renew SSL"); }
  },
};
