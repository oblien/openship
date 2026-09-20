import type { UpdateDependencies } from "../../../updates";
import { audit, operationAuditContext } from "../../lib/audit-emitter";
import * as service from "./updates.service";
export const updatesDependencies: UpdateDependencies = {
  collection: {
    list: service.listOrganizationUpdates,
    async scan(ctx) {
      const result = await service.scanOrganizationUpdates(ctx, ctx.organizationId);
      audit.recordAsync(operationAuditContext(ctx), { eventType: "updates:write", resourceType: "updates", after: { operation: "scan", ...result } });
      return result;
    },
  },
  projects: { async apply(ctx, id) {
    const result = await service.applyProjectUpdate(ctx, id);
    audit.recordAsync(operationAuditContext(ctx), { eventType: "project:write", resourceType: "project", resourceId: id, after: { operation: "applyUpdate", deploymentId: result.deployment_id } });
    return result;
  } },
};
