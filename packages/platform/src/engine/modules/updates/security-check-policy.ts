import { AppError, ValidationError } from "@repo/core";
import { repos } from "@repo/db";
import type { ExecutionContext } from "../../../context";
import { authorization } from "../../lib/authorization";
import { audit, operationAuditContext } from "../../lib/audit-emitter";
import { isOrganizationAdmin } from "../../lib/organization-authorization";

async function canManage(ctx: ExecutionContext) {
  return (
    (await isOrganizationAdmin(ctx)) &&
    authorization.checkPermissionOnResource(ctx, {
      resourceType: "updates",
      resourceId: "*",
      action: "write",
    })
  );
}

export async function securityCheckPolicy(ctx: ExecutionContext) {
  const [checksEnabled, allowed] = await Promise.all([
    repos.securityAdvisory.checksEnabled(ctx.organizationId),
    canManage(ctx),
  ]);
  return { checksEnabled, canManage: allowed };
}

export async function setSecurityCheckPolicy(
  ctx: ExecutionContext,
  input: { checksEnabled: boolean },
) {
  if (!(await canManage(ctx)))
    throw new AppError("Only workspace owners and admins can change advisory checks.", 403);
  await repos.securityAdvisory.setChecksEnabled(ctx.organizationId, input.checksEnabled);
  audit.recordAsync(operationAuditContext(ctx), {
    eventType: "updates:write",
    resourceType: "updates",
    after: { operation: "securityCheckPolicy", checksEnabled: input.checksEnabled },
  });
  return { checksEnabled: input.checksEnabled, canManage: true };
}

export async function assertSecurityChecksEnabled(organizationId: string) {
  if (!(await repos.securityAdvisory.checksEnabled(organizationId)))
    throw new ValidationError(
      "Security advisory checks are disabled for this workspace. Enable them in Settings → Notifications.",
    );
}
