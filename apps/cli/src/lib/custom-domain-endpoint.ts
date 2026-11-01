import { safeErrorMessage } from "@repo/core";
import type { UpdateProjectInput } from "@repo/contracts";
import type { CliShipClient } from "./ship-client";
import { reportCliMessage } from "./output";

type PublicEndpoint = NonNullable<UpdateProjectInput["publicEndpoints"]>[number];

/** Attach the routing endpoint after claiming the domain, as the dashboard does. */
export async function attachCustomDomainEndpoint(
  ship: Pick<CliShipClient, "projects">,
  projectId: string,
  hostname: string,
): Promise<boolean> {
  const host = hostname.trim().toLowerCase();
  try {
    const { project } = await ship.projects.getInfo(projectId);
    const endpoints =
      (project as typeof project & { publicEndpoints?: PublicEndpoint[] }).publicEndpoints ?? [];
    if (endpoints.some((endpoint) => endpoint.customDomain?.toLowerCase() === host)) return true;

    if (project.options.workloadType === "worker") {
      reportCliMessage(
        "warn",
        `Domain ${host} was added, but this worker has no public route. Configure a web workload and port before attaching it.`,
      );
      return false;
    }

    if (project.projectType !== "app") {
      reportCliMessage(
        "warn",
        `Domain ${host} was added, but ${project.name || projectId} is a multi-service project, so routes belong to a service. Attach it to a service in the dashboard.`,
      );
      return false;
    }

    const hasServer = project.options.hasServer;
    const port = Number(project.options.productionPort || project.port);
    if (hasServer && (!Number.isInteger(port) || port < 1 || port > 65535)) {
      reportCliMessage(
        "warn",
        `Domain ${host} was added, but the project has no valid server port and no public route. Configure a port in the dashboard Domains tab.`,
      );
      return false;
    }

    // Project info adds UI metadata. Send only the accepted save fields, keeping
    // every existing target, hostname, redirect, and endpoint position intact.
    const publicEndpoints: PublicEndpoint[] = endpoints.map((endpoint) => ({
      ...(endpoint.port !== undefined ? { port: endpoint.port } : {}),
      ...(endpoint.targetPath !== undefined ? { targetPath: endpoint.targetPath } : {}),
      ...(endpoint.domain !== undefined ? { domain: endpoint.domain } : {}),
      ...(endpoint.customDomain !== undefined ? { customDomain: endpoint.customDomain } : {}),
      ...(endpoint.domainType !== undefined ? { domainType: endpoint.domainType } : {}),
      ...(endpoint.redirectTo !== undefined ? { redirectTo: endpoint.redirectTo } : {}),
      ...(endpoint.redirectStatus !== undefined ? { redirectStatus: endpoint.redirectStatus } : {}),
    }));
    publicEndpoints.push({
      domainType: "custom",
      customDomain: host,
      ...(hasServer ? { port } : { targetPath: "/" }),
    });
    await ship.projects.update(projectId, { publicEndpoints });
    return true;
  } catch (error) {
    throw new Error(
      `Domain ${host} row still exists, but attaching its route failed: ${safeErrorMessage(error)}. Retry in the dashboard project ${projectId} Domains tab: configure this domain's target and save.`,
      { cause: error },
    );
  }
}
