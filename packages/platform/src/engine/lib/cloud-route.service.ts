import { CloudInfraProvider, cloudDockerProjectPaths } from "@repo/adapters";
import { repos } from "@repo/db";
import { env } from "../config/env";
import { createRemoteCloudAdmin } from "./cloud/admin-proxy";
import { getNamespaceClient } from "./openship-cloud";
import { createTenantCloudAdmin } from "./cloud-tenant-admin";
import { createProvisionLock } from "./provision-lock";

export interface CloudRouteProject {
  id: string;
  organizationId: string;
  workspaceId?: string | null;
  activeDeploymentId: string | null;
}
async function tenantClient(organizationId: string, workspaceId?: string | null) {
  const { client, namespace } = await getNamespaceClient(organizationId, workspaceId ?? null);
  const adminProxy = env.CLOUD_MODE ? createTenantCloudAdmin(organizationId, namespace, workspaceId ?? null) : createRemoteCloudAdmin(organizationId, workspaceId ?? undefined);
  return { client, namespace, adminProxy };
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
