import { firstServicePort, resolveRedirectStatus, safeErrorMessage } from "@repo/core";
import type { UpdateProjectInput } from "@repo/contracts";
import type { CliShipClient } from "./ship-client";
import { resolveServiceRef } from "./service-ref";

type PublicEndpoint = NonNullable<UpdateProjectInput["publicEndpoints"]>[number];

export interface CustomDomainTarget { service?: string; port?: number }

/** Validate the target before claiming a hostname, then save through the same
 * project/service API used by the dashboard. DNS verification and deployment
 * remain explicit subsequent steps. */
export async function prepareCustomDomainEndpoint(
  ship: Pick<CliShipClient, "projects" | "services">,
  projectId: string,
  options: CustomDomainTarget = {},
): Promise<(hostname: string) => Promise<void>> {
  const { project } = await ship.projects.getInfo(projectId);
  if (!options.service && project.projectType !== "app")
    throw new Error("This is a multi-service project. Pass --service <name|id> and --port <container-port> to select its route.");
  if (!options.service && project.options.workloadType === "worker")
    throw new Error("This worker has no public route. Configure a web workload before adding a domain.");
  const service = options.service ? await resolveServiceRef(ship, projectId, options.service) : undefined;
  const hasServer = !!service || project.options.hasServer;
  const endpoints: PublicEndpoint[] = service?.publicEndpoints?.map(endpoint => ({ ...endpoint, redirectStatus: endpoint.redirectStatus !== undefined ? resolveRedirectStatus(endpoint.redirectStatus) : undefined })) ??
    (service ? [] : (project as typeof project & { publicEndpoints?: PublicEndpoint[] }).publicEndpoints ?? []);
  const ports = service ? [...new Set([
    ...(service.ports ?? []).map(spec => firstServicePort([spec])),
    ...(service.publicEndpoints ?? []).map(endpoint => endpoint.port),
    Number(service.exposedPort),
  ].filter((value): value is number => Number.isInteger(value) && Number(value) > 0 && Number(value) <= 65535))] : [];
  const port = options.port ?? (service
    ? ports.length === 1 ? ports[0] : undefined
    : Number(project.options.productionPort || project.port));
  if (hasServer && (!Number.isInteger(port) || !port || port < 1 || port > 65535))
    throw new Error("Choose a valid container port with --port <1-65535>; services with multiple ports require an explicit target.");
  if (!hasServer && options.port !== undefined)
    throw new Error("A static project routes its output directory; --port requires a web service.");

  return async hostname => {
    const host = hostname.trim().toLowerCase();
    try {
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
      const endpoint = { domainType: "custom" as const, customDomain: host, ...(hasServer ? { port } : { targetPath: "/" }) };
      const index = publicEndpoints.findIndex(value => value.customDomain?.toLowerCase() === host);
      if (index >= 0) {
        if (options.port === undefined || publicEndpoints[index]!.port === port) return;
        publicEndpoints[index] = { ...publicEndpoints[index], ...endpoint };
      } else publicEndpoints.push(endpoint);
      if (service) await ship.services.update(projectId, service.id, { exposed: true, publicEndpoints });
      else await ship.projects.update(projectId, { publicEndpoints });
    } catch (error) {
      throw new Error(
        `Domain ${host} row still exists, but attaching its route failed: ${safeErrorMessage(error)}. Retry in the dashboard project ${projectId} Domains tab: configure this domain's target and save.`,
        { cause: error },
      );
    }
  };
}

/** Existing callers claim a domain before attaching its endpoint. */
export async function attachCustomDomainEndpoint(
  ship: Pick<CliShipClient, "projects" | "services">,
  projectId: string,
  hostname: string,
): Promise<boolean> {
  await (await prepareCustomDomainEndpoint(ship, projectId))(hostname);
  return true;
}
