import { repos } from "@repo/db";
import { env } from "../../config/index";
import type { ExecutionContext } from "../../../context";
import { resolveOrgCloudUserId } from "./transport";
import { canProxyCloudResources } from "./scope";

export type CloudResourceType = "project" | "deployment" | "domain" | "service" | "server";
export type ConnectedResourceType =
  | CloudResourceType
  | "actionWorkflow"
  | "actionRun"
  | "actionRunner"
  | "actionJob";
export type ResourceAuthority = "local" | "cloud" | "not-found";

/** Account discovery never widens a credential scoped to this installation. */
export function canDiscoverCloudResources(ctx: ExecutionContext): boolean {
  return !env.CLOUD_MODE && canProxyCloudResources(ctx);
}

/** A local record always retains its authority, including a foreign-tenant row.
 * Database failures must not turn a local operation into an upstream request. */
export async function resolveResourceAuthority(
  type: ConnectedResourceType,
  id: string,
  organizationId: string,
): Promise<ResourceAuthority> {
  if (env.CLOUD_MODE) return "local";
  const local =
    type === "actionWorkflow" || type === "actionRun" || type === "actionRunner" || type === "actionJob"
      ? await repos.actions.resourceExists(type, id)
      : type === "server"
        ? await repos.server.get(id)
        : await repos[type].findById(id);
  if (local) return "local";
  return await resolveOrgCloudUserId(organizationId) ? "cloud" : "not-found";
}
