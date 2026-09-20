import { Oblien, PAGE_CONTAINER_PREFIX, CloudInfraProvider, CloudDockerRuntime } from "@repo/adapters";
import { repos } from "@repo/db";
import { AppError, SYSTEM, deploymentBelongsToProject } from "@repo/core";
import { env } from "../config/env";
import { getOrgCloudToken } from "./cloud/client";
import { createRemoteCloudAdmin } from "./cloud/admin-proxy";
import { issueNamespaceToken } from "./openship-cloud";
import { createTenantCloudAdmin } from "./cloud-tenant-admin";
import { disposePlatform, resolveDeploymentPlatform, type DeploymentMeta } from "./deployment-runtime";
import { pickProjectPortOwner } from "./project-service-upstream";

export interface CloudRouteProject {
  id: string;
  organizationId: string;
  cloudWorkspaceId: string | null;
  activeDeploymentId: string | null;
}
export interface CloudRouteInput {
  hostname: string;
  port?: number;
  isCustomDomain: boolean;
}

async function tenantClient(organizationId: string) {
  const token = env.CLOUD_MODE ? await issueNamespaceToken(organizationId) : await getOrgCloudToken(organizationId);
  if (!token) throw new AppError("Connect Openship Cloud before changing cloud routes", 503, "CLOUD_NOT_CONNECTED");
  const client = new Oblien({ token: token.token, baseUrl: env.OBLIEN_API_URL });
  const adminProxy = env.CLOUD_MODE ? createTenantCloudAdmin(organizationId, token.namespace) : createRemoteCloudAdmin(organizationId);
  return { client, namespace: token.namespace, adminProxy };
}

/** Provider errors propagate so a failed edit cannot be presented as applied. */
export async function reapplyCloudProjectRoute(project: CloudRouteProject, input: CloudRouteInput): Promise<void> {
  if (!project.cloudWorkspaceId || !project.activeDeploymentId) return;
  const deployment = await repos.deployment.findById(project.activeDeploymentId);
  if (!deployment?.containerId) return;
  if (!deploymentBelongsToProject(project, deployment)) {
    throw new AppError("Cloud deployment does not belong to this project", 404, "DEPLOYMENT_NOT_FOUND");
  }
  if ((deployment.meta as DeploymentMeta | null)?.cloudDockerWorkspace) {
    if (!input.port) throw new AppError("A target port is required for this cloud route", 400, "CLOUD_ROUTE_PORT_REQUIRED");
    const resolved = await resolveDeploymentPlatform(deployment.meta as DeploymentMeta, { organizationId: project.organizationId });
    try {
      if (!(resolved.platform.runtime instanceof CloudDockerRuntime)) throw new Error("Invalid Docker workspace binding");
      const [services, rows, domainRows] = await Promise.all([
        repos.service.listByProject(project.id), repos.service.listByDeployment(deployment.id), repos.domain.listByProject(project.id),
      ]);
      const rowByService = new Map(rows.map(row => [row.serviceId, row]));
      const owner = pickProjectPortOwner({ port: input.port, services, rowByService, domainRows });
      const row = owner && rowByService.get(owner.serviceId);
      if (!owner || !row?.containerId) throw new Error("No deployed service owns this port");
      const target = await resolved.platform.runtime.resolveRoutingTarget(row.containerId, owner.containerPort);
      await resolved.platform.runtime.publishRoute(input.hostname, target.port, input.isCustomDomain);
    } finally { disposePlatform(resolved); }
    return;
  }
  const { client, adminProxy } = await tenantClient(project.organizationId);
  const containerId = deployment.containerId;
  if (containerId.startsWith(PAGE_CONTAINER_PREFIX)) {
    const slug = containerId.slice(PAGE_CONTAINER_PREFIX.length);
    const pages = adminProxy.pages ?? client.pages;
    if (input.isCustomDomain) await pages.connectDomain(slug, { domain: input.hostname });
    else {
      const { page } = await pages.get(slug);
      if (new URL(page.url).hostname !== input.hostname.toLowerCase()) {
        throw new AppError("Redeploy the site to change its free domain", 409, "CLOUD_PAGE_REDEPLOY_REQUIRED");
      }
      await pages.enable(slug);
    }
    return;
  }
  const ws = client.workspace(containerId);
  if (input.isCustomDomain) {
    if (input.port) {
      const network = await ws.network.get();
      const ingress = Array.isArray(network.ingress_ports) ? network.ingress_ports.filter((port): port is number => typeof port === "number") : [];
      await ws.network.update({ ingress_ports: [...new Set([...ingress, input.port])] });
    }
    await ws.domains.connect({ domain: input.hostname, ...(input.port ? { port: input.port } : {}) });
    return;
  }
  if (!input.port) throw new AppError("A target port is required for this cloud route", 400, "CLOUD_ROUTE_PORT_REQUIRED");
  const suffix = `.${SYSTEM.DOMAINS.CLOUD_DOMAIN}`;
  if (!input.hostname.toLowerCase().endsWith(suffix)) throw new AppError("Invalid managed cloud hostname", 400, "CLOUD_HOSTNAME_INVALID");
  await ws.publicAccess.expose({ port: input.port, domain: SYSTEM.DOMAINS.CLOUD_DOMAIN, slug: input.hostname.slice(0, -suffix.length) });
}

/** Resolve the actual route owner, including service workspaces in a compose deployment. */
export async function removeCloudProjectRoute(project: CloudRouteProject, input: { hostname: string; isCustomDomain: boolean }): Promise<void> {
  const { client, namespace, adminProxy } = await tenantClient(project.organizationId);
  const binding = await repos.cloudDockerWorkspace.find(project.id, project.organizationId);
  if (binding && binding.namespace !== namespace) throw new Error("Cloud workspace namespace changed");
  await new CloudInfraProvider(client, { namespace, adminProxy, dockerWorkspaceId: binding?.workspaceId ?? undefined }).removeRoute(input.hostname);
}
