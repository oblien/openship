import { AppError, NotFoundError } from "@repo/core";
import { repos } from "@repo/db";
import type { ExecutionContext } from "../../../context";
import { env } from "../../config/index";
import { authorization } from "../authorization";
import { resolveProjectAuthority } from "./project-authority";
import { canProxyCloudResources } from "./scope";
import { cloudRequestReferences } from "./server-reference";
import { linkedCloudIdentity, remoteCloudRequest } from "./server-link";
import { resolveOrgCloudUserId } from "./transport";

type ProjectTarget = {
  serverId?: string;
  projectId?: string;
  localPath?: string;
  gitProvider?: string;
};

/** Selecting managed hosting in an account dashboard creates Cloud-owned
 * configuration. Explicit local sources, existing local projects and credentials
 * scoped to this installation retain their controller and execution capability. */
export async function maybeCloudProjectRequest<T>(
  ctx: ExecutionContext,
  path: string,
  input: ProjectTarget & object,
  check: (value: unknown) => value is T,
  options: { method?: "GET" | "POST"; envelope?: "data" } = {},
): Promise<T | null> {
  if (env.CLOUD_MODE || !canProxyCloudResources(ctx)) return null;
  const method = options.method ?? "POST";
  if (input.projectId) {
    // Destination changes cannot silently move a local project to Cloud.
    if ((await resolveProjectAuthority(input.projectId, ctx.organizationId)) !== "cloud")
      return null;
  } else {
    // The source directory and upload session belong to this controller.
    if (
      input.localPath ||
      input.gitProvider === "local" ||
      input.gitProvider === "upload" ||
      !input.serverId
    )
      return null;
    const server = await repos.server.get(input.serverId);
    if (server) {
      if (server.organizationId !== ctx.organizationId)
        throw new NotFoundError("Server", input.serverId);
      if (!server.workspaceId) return null;
      await authorization.authorize(
        { ...ctx, scopeMode: "fixed" },
        {
          resourceType: "server",
          resourceId: server.id,
          action: method === "GET" ? "read" : "write",
        },
      );
    } else if (!(await resolveOrgCloudUserId(ctx.organizationId))) return null;
  }

  const identity = await linkedCloudIdentity(ctx.organizationId);
  const payload = await cloudRequestReferences(
    ctx.organizationId,
    input as Record<string, unknown>,
  );
  const url = new URL(path, "http://openship.internal");
  if (method === "GET") {
    for (const [key, value] of Object.entries(payload))
      if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const response = await remoteCloudRequest<Record<string, unknown>>(
    ctx.organizationId,
    `${url.pathname}${url.search}`,
    {
      method,
      ...(method === "POST" && { body: JSON.stringify(payload) }),
    },
    identity,
  );
  const data = options.envelope ? response[options.envelope] : response;
  if (!check(data))
    throw new AppError("Cloud returned an invalid project response", 502, "INVALID_CLOUD_RESPONSE");
  // Any upstream failure stays a failure. Never retry creation in the local DB.
  return data;
}
