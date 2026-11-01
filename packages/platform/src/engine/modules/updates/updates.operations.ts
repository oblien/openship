import type { UpdateDependencies } from "../../../updates";
import { audit, operationAuditContext } from "../../lib/audit-emitter";
import * as service from "./updates.service";
import { updateProjectRuntime } from "./runtime-update";
import { checkProjectRuntimeImages } from "./runtime-image-check";
import { organizationAdvisories } from "./security-overview";
import {
  projectSecurityStatus,
  setProjectSecurityPolicy,
  applySecurityAdvisory,
} from "./security.service";
export const updatesDependencies: UpdateDependencies = {
  collection: {
    advisories: organizationAdvisories,
    list: service.listOrganizationUpdates,
    async scan(ctx) {
      const result = await service.scanOrganizationUpdates(ctx, ctx.organizationId);
      audit.recordAsync(operationAuditContext(ctx), {
        eventType: "updates:write",
        resourceType: "updates",
        after: { operation: "scan", ...result },
      });
      return result;
    },
  },
  projects: {
    security: (ctx, id) => projectSecurityStatus(ctx, id),
    checkSecurity: (ctx, id) => projectSecurityStatus(ctx, id, undefined, true),
    securityPolicy: setProjectSecurityPolicy,
    async applySecurity(ctx, id, input) {
      const result = await applySecurityAdvisory(ctx, id, input);
      if (!result) throw new Error("Security refresh was not admitted.");
      return result;
    },
    checkRuntime: checkProjectRuntimeImages,
    async apply(ctx, id) {
      const result = await service.applyProjectUpdate(ctx, id);
      audit.recordAsync(operationAuditContext(ctx), {
        eventType: "project:write",
        resourceType: "project",
        resourceId: id,
        after: { operation: "applyUpdate", deploymentId: result.deployment_id },
      });
      return result;
    },
    async updateRuntime(ctx, id, input) {
      const result = await updateProjectRuntime(ctx, id, input);
      audit.recordAsync(operationAuditContext(ctx), {
        eventType: "project:write",
        resourceType: "project",
        resourceId: id,
        after: {
          operation: "updateRuntime",
          deploymentId: result.deployment_id,
          actionRequestId: result.action_request_id,
          serviceIds: input?.serviceIds,
        },
      });
      return result;
    },
  },
};
