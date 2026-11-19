import { repos } from "@repo/db";
import { Oblien } from "@repo/adapters";
import { issueNamespaceToken } from "@repo/platform/engine/lib/openship-cloud";

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

export async function proxyCloudAnalytics(
  organizationId: string,
  input: {
    operation: CloudAnalyticsOperation;
    domain: string;
    params?: Record<string, unknown>;
  },
): Promise<unknown> {
  const domain = await repos.domain.findByHostname(input.domain.trim().toLowerCase());
  const project = domain?.projectId ? await repos.project.findByIdInOrganization(domain.projectId, organizationId) : null;
  const { token } = await issueNamespaceToken(organizationId, project?.workspaceId ?? null);
  const client = new Oblien({ token });

  try {
    const { from, to, interval } = input.params ?? {};
    return await client.analytics.timeseries(input.domain, {
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
