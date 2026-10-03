import { Oblien, CloudInfraProvider, cloudDockerProjectPaths } from "@repo/adapters";
import { repos } from "@repo/db";
import { env } from "../config/env";
import { createRemoteCloudAdmin } from "./cloud/admin-proxy";
import { issueNamespaceToken } from "./openship-cloud";
import { createTenantCloudAdmin } from "./cloud-tenant-admin";
import { createProvisionLock } from "./provision-lock";

export interface CloudRouteProject {
  id: string;
  organizationId: string;
  workspaceId?: string | null;
  activeDeploymentId: string | null;
}
async function tenantClient(organizationId: string, workspaceId?: string | null) {
  const token = await issueNamespaceToken(organizationId, workspaceId ?? null);
  const client = new Oblien({ token: token.token, baseUrl: token.providerApiUrl });
  const adminProxy = env.CLOUD_MODE ? createTenantCloudAdmin(organizationId, token.namespace, workspaceId ?? null) : createRemoteCloudAdmin(organizationId, workspaceId ?? undefined);
  return { client, namespace: token.namespace, adminProxy };
}

/** Remove only this project's route anchor; the subscribed server is retained. */
export async function removeCloudProjectRoute(project: CloudRouteProject, input: { hostname: string; isCustomDomain: boolean }): Promise<void> {
  const binding = await repos.cloudDockerWorkspace.find(project.id, project.organizationId);
  if (!binding?.workspaceId) return;
  const { client, namespace, adminProxy } = await tenantClient(project.organizationId, project.workspaceId);
  if (binding.namespace !== namespace) throw new Error("Cloud workspace namespace changed");
  await new CloudInfraProvider(client, { namespace, adminProxy, workspaceId: binding?.workspaceId ?? undefined,
    routeRoot: cloudDockerProjectPaths(project.id).routes,
    lock: createProvisionLock(`cloud:server:${binding.workspaceId}`),
  }).removeRoute(input.hostname);
}
