import type { Context } from "hono";
import { AppError } from "@repo/core";
import { env } from "@repo/platform/engine/config/env";
import { assertCloudProxyScope } from "@repo/platform/engine/lib/cloud/scope";
import {
  linkedCloudIdentity,
  remoteCloudRequest,
} from "@repo/platform/engine/lib/cloud/server-link";
import { getRequestContext, type RequestContext } from "../../lib/request-context";
import { permission } from "../../lib/permission";
import { isManagedMailId } from "@repo/contracts/managed-mail";
import { customerEngine } from "@repo/platform/engine/modules/managed-mail/service";

/** Pin every request in an operation to the same linked Cloud identity. */
export async function linkedMailRequest(ctx: RequestContext) {
  assertCloudProxyScope(ctx);
  const org = ctx.organizationId;
  const identity = await linkedCloudIdentity(org);
  const request = <T = object>(path: string, init?: RequestInit) =>
    remoteCloudRequest<T>(org, "/api/mail" + path, init, identity);
  return Object.assign(request, { identity });
}

/** Resolve the service after authorization. Worker origins and the linked
 * Cloud credential are always selected by the server. */
export async function resolveMailAccountTarget(c: Context, action: "read" | "write" | "admin") {
  const id = c.req.param("serverId")!;
  await permission.assert(getRequestContext(c), {
    resourceType: "mail_server",
    resourceId: id,
    action,
  });
  const ctx = getRequestContext(c);
  if (isManagedMailId(id)) {
    if (env.CLOUD_MODE) {
      return { kind: "hosted" as const, engine: await customerEngine(ctx.organizationId, id) };
    }
    return { kind: "linked" as const, request: await linkedMailRequest(ctx) };
  }
  if (env.CLOUD_MODE) throw new AppError("Mail service not found.", 404);
  return { kind: "instance" as const };
}
