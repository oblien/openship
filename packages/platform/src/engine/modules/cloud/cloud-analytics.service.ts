import { repos } from "@repo/db";
import { Oblien } from "@repo/adapters";
import { AppError } from "@repo/core";
import { env } from "../../config/env";
import type { ExecutionContext } from "../../../context";
import { authorization } from "../../lib/authorization";
import { cloudBillingOwner, workspaceForServer, requireWorkspaceServer } from "../../lib/cloud-workspace-scope";
import { getOblienClient } from "../../lib/oblien-client";

export type CloudAnalyticsOperation = "timeseries";

export class CloudAnalyticsForbiddenError extends Error {
  readonly status = 403 as const;
  constructor(domain: string) {
    super(`You do not own analytics for ${domain}`);
    this.name = "CloudAnalyticsForbiddenError";
  }
}

/**
 * Map an Oblien error to our forbidden type when it looks like a
 * cross-tenant / not-found rejection — so the caller gets a friendly
 * 403 instead of a generic 500.
 */
function isCrossTenantError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const status = (err as { status?: number }).status;
  if (status === 403 || status === 404) return true;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("not found") ||
    msg.includes("does not have access") ||
    msg.includes("does not belong")
  );
}

/** Reading counters must never create a namespace or depend on VM readiness. */
export async function getNamespaceAnalytics(organizationId: string, workspaceId: string | null) {
  const { namespace } = await cloudBillingOwner(organizationId, workspaceId);
  return analyticsForNamespace(namespace);
}

async function analyticsForNamespace(namespace: string | null) {
  if (!namespace) throw new AppError("This managed server has no Edge namespace", 404, "CLOUD_NAMESPACE_NOT_FOUND");

  const credentials = await getOblienClient().tokens.create({ scope: "namespace", namespace, ttl: 60 });
  if (!credentials.success || credentials.scope !== "namespace" || !credentials.token)
    throw new AppError("Cloud traffic metrics are unavailable", 502, "ANALYTICS_UPSTREAM_UNAVAILABLE");
  return new Oblien({ token: credentials.token, baseUrl: env.OBLIEN_API_URL }).analytics;
}

export async function proxyCloudAnalytics(
  ctx: ExecutionContext,
  input: {
    operation: CloudAnalyticsOperation;
    domain: string;
    params?: Record<string, unknown>;
    serverId?: string;
  },
): Promise<unknown> {
  const { organizationId } = ctx;
  const domain = await repos.domain.findByHostname(input.domain.trim().toLowerCase());
  const project = domain?.projectId ? await repos.project.findByIdInOrganization(domain.projectId, organizationId) : null;
  if (domain?.projectId && !project) throw new CloudAnalyticsForbiddenError(input.domain);

  const selected = input.serverId ? await workspaceForServer(organizationId, input.serverId) : null;
  const workspace = selected ? selected.workspace : (await cloudBillingOwner(organizationId, project?.workspaceId)).workspace;
  if (!workspace || workspace.remote || workspace.deletionInProgress || (project?.workspaceId && project.workspaceId !== workspace.id))
    throw new CloudAnalyticsForbiddenError(input.domain);
  const server = selected?.server ?? await requireWorkspaceServer(organizationId, workspace.id);
  await authorization.authorize(ctx, { resourceType: "server", resourceId: server.id, action: "read" });
  const analytics = await analyticsForNamespace(workspace.namespace);

  try {
    const { from, to, interval } = input.params ?? {};
    return await analytics.timeseries(input.domain, {
      ...(typeof from === "number" && { from }),
      ...(typeof to === "number" && { to }),
      ...((interval === "minute" || interval === "hour" || interval === "day") && { interval }),
    });
  } catch (err) {
    if (isCrossTenantError(err)) {
      throw new CloudAnalyticsForbiddenError(input.domain);
    }
    throw err;
  }
}
