import { repos } from "@repo/db";
import type { BuildLogger } from "@repo/adapters";
import { resolveDeploymentRuntime, type PortCheckResult } from "../../lib/deployment-runtime";
import { assertResourceInOrg } from "../../lib/controller-helpers";
import type { RequestContext } from "../../lib/request-context";
import { resolveProjectRouteState } from "../domains/project-route.service";
import { auditPorts } from "../deployments/port-audit.service";

// auditPorts only ever calls logger.log — a silent sink is enough for an
// on-demand check (nothing is streaming build output here).
const silentLogger = { log() {} } as unknown as BuildLogger;

/** Overall budget for the advisory probe. Each service is probed via an SSH exec
 *  into its container; on a REMOTE box (desktop mode) those round-trips add up
 *  and, unbounded, time out the Domains tab. This is ADVISORY (just a "nothing on
 *  port X" hint) — past the budget, degrade to [] (no hint), never hang. */
const PORT_CHECK_BUDGET_MS = 5000;

/**
 * On-demand port-reachability audit for a project's LIVE deployment. Reuses the
 * exact `auditPorts` probe the deploy pipeline runs so the Domains tab can show
 * a FRESH "nothing responded on port X" hint instead of a stale deploy-time
 * snapshot. Advisory only: returns [] (no signal → no hint) whenever there's
 * nothing to probe (no active deployment, no container, runtime can't exec) OR
 * the probes don't finish within the budget (slow/unreachable remote server).
 */
export async function checkProjectPorts(
  ctx: RequestContext,
  projectId: string,
): Promise<PortCheckResult[]> {
  const project = await repos.project.findById(projectId);
  assertResourceInOrg(project, "Project", ctx.organizationId, projectId);
  if (!project.activeDeploymentId) return [];

  const deployment = await repos.deployment.findById(project.activeDeploymentId);
  if (!deployment) return [];

  // Bound the whole probe: a slow/unreachable remote box must degrade to "no
  // hint", never a timed-out tab. The probe keeps running in the background after
  // the cap (harmless) — the point is the request returns fast.
  return Promise.race([
    runPortProbe(projectId, project, deployment),
    new Promise<PortCheckResult[]>((resolve) => setTimeout(() => resolve([]), PORT_CHECK_BUDGET_MS)),
  ]);
}

async function runPortProbe(
  projectId: string,
  project: NonNullable<Awaited<ReturnType<typeof repos.project.findById>>>,
  deployment: NonNullable<Awaited<ReturnType<typeof repos.deployment.findById>>>,
): Promise<PortCheckResult[]> {
  // resolveDeploymentRuntime + the probes can throw (target server removed from
  // the org, invalid SSH config, cloud deployment missing an org id). This is an
  // ADVISORY check, so degrade to [] (no hint) rather than surfacing an error.
  try {
    const { runtime } = await resolveDeploymentRuntime(deployment);

    // Compose / multi-service: probe each exposed service inside its OWN live
    // container — the service_deployment rows carry the per-service containerId.
    const serviceDeployments = await repos.serviceDeployment.listByDeployment(deployment.id);
    if (serviceDeployments.length > 0) {
      const services = await repos.service.listByProject(projectId);
      const serviceById = new Map(services.map((s) => [s.id, s]));
      const results: PortCheckResult[] = [];
      for (const sd of serviceDeployments) {
        if (!sd.containerId || !sd.serviceId) continue;
        const svc = serviceById.get(sd.serviceId);
        if (!svc || !svc.exposed) continue;
        const port = Number(svc.exposedPort);
        if (!Number.isFinite(port) || port <= 0) continue;
        const checks = await auditPorts(runtime, sd.containerId, [port], silentLogger);
        for (const check of checks) {
          results.push({ ...check, serviceId: svc.id, serviceName: svc.name });
        }
      }
      return results;
    }

    // Single-app: probe the deployment's container on its public-endpoint ports
    // (the same set the firewall + deploy-time audit use), falling back to port.
    if (!deployment.containerId) return [];
    const routeState = await resolveProjectRouteState(project);
    const ports = Array.from(
      new Set(
        routeState.publicEndpoints
          .map((endpoint) => endpoint.port ?? project.port ?? undefined)
          .filter((port): port is number => Number.isFinite(port as number) && (port as number) > 0),
      ),
    );
    if (ports.length === 0 && project.port) ports.push(project.port);
    if (ports.length === 0) return [];
    return await auditPorts(runtime, deployment.containerId, ports, silentLogger);
  } catch {
    return [];
  }
}
