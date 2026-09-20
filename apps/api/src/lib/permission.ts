/** HTTP compatibility adapter over the shared application permission policy. */
import type { Context } from "hono";
import { type PermissionInput } from "@repo/platform";
import type { RequestContext } from "./request-context";
import { authorization, checkPermission, checkPermissionOnResource } from "@repo/platform/engine/lib/authorization";
export { authorization, checkPermission, checkPermissionOnResource } from "@repo/platform/engine/lib/authorization";

export {
  ORG_SINGLETON_RESOURCES,
  PROJECT_ROOTED,
  permitsAction,
  roleAllowsResourceType,
  type CheckedResourceType,
  type PermissionInput,
} from "@repo/platform";

/** Lists/creates establish HTTP scope from an explicit header, then the session fallback. */
export function resolveRequestScopeOrg(c: Context): string | null {
  const header = c.req.header("X-Organization-Id") ?? c.req.header("x-organization-id");
  if (header && header.trim()) return header.trim();
  const sessionOrgId = c.get("activeOrganizationId");
  return typeof sessionOrgId === "string" && sessionOrgId.trim() ? sessionOrgId : null;
}

/**
 * Preserve legacy HTTP resource-derived scope. Native views use the shared
 * authorize() directly with a fixed tenant. All policy lives in @repo/platform;
 * only reading headers and rebinding the request belong here.
 */
export async function assert(ctx: RequestContext, input: PermissionInput): Promise<void> {
  const c = ctx.hono;
  if (!c)
    throw new Error(
      "permission.assert requires an HTTP request; use authorization.authorize for native operations",
    );
  const authorized = await authorization.authorize(ctx, input, resolveRequestScopeOrg(c));
  c.set("scopedOrganizationId", authorized.organizationId);
  c.set("ctx", { ...authorized, hono: c });
}

export const permission = { checkPermission, assert, resolveRequestScopeOrg };
