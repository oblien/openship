import type { CloudProjectRoutingScope } from "../../infra/cloud";
import type { ProvisionLock } from "../../types";
import { cloudDockerProjectPaths } from "./docker-paths";
import { CloudProcessSupervisor } from "./process-supervisor";
import type { CloudServerConnection } from "./server-connection";

/** Container lookups are lazy: a direct process or static site needs no Docker
 * connection. Both runtimes still use the same project ownership checks. */
export interface ManagedContainerRouteTargets {
  resolveTarget(id: string, port: number): Promise<number>;
  resolveUrl(url: string): Promise<number>;
}

export function managedProjectRoutingScope(
  connection: CloudServerConnection,
  options: { projectId: string; provisionLock: ProvisionLock; publicDomain?: string },
  containers: () => Promise<ManagedContainerRouteTargets>,
): CloudProjectRoutingScope {
  const paths = cloudDockerProjectPaths(options.projectId);
  const processes = new CloudProcessSupervisor(connection, options.projectId, paths.bare);
  return {
    workspaceId: connection.workspaceId,
    projectId: options.projectId,
    routeRoot: paths.routes,
    staticReleaseRoot: `${paths.bare}/releases`,
    executor: connection.executor,
    lock: options.provisionLock,
    publicDomain: options.publicDomain,
    async resolveTarget(id, port) {
      if ((await processes.listProjectDeploymentIds(options.projectId)).includes(id)) {
        const info = await processes.getInfo(id);
        if (info.hostPortByContainerPort?.[port] !== port)
          throw new Error("Routing port does not belong to this project's process");
        return port;
      }
      return (await containers()).resolveTarget(id, port);
    },
    async resolveUrl(url) {
      const target = new URL(url);
      if (target.protocol !== "http:" || target.username || target.password)
        throw new Error("Invalid application route target");
      const port = Number(target.port || 80);
      if (["127.0.0.1", "localhost"].includes(target.hostname) && (await processes.ports()).includes(port))
        return port;
      return (await containers()).resolveUrl(url);
    },
  };
}
