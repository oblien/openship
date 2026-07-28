import { posix as pathPosix } from "node:path";
import { repos } from "@repo/db";
import { BareRuntime, type BuildLogger } from "@repo/adapters";
import { resolveDeploymentRuntime, type OutputCheckResult } from "../../lib/deployment-runtime";
import { assertResourceInOrg } from "../../lib/controller-helpers";
import type { RequestContext } from "../../lib/request-context";
import { resolveProjectRouteState } from "../domains/project-route.service";
import { normalizeTargetPath } from "../../lib/public-endpoints";
import { auditStaticOutput } from "../deployments/output-audit.service";

const silentLogger = { log() {} } as unknown as BuildLogger;

/** Overall budget for the advisory probe. resolveDeploymentRuntime + the
 *  in-container exec each round-trip over SSH to the deployment's box; on a
 *  slow/unreachable/asleep REMOTE server those can HANG with no timeout of their
 *  own, which would otherwise hang the Domains tab request. ADVISORY only —
 *  past the budget, degrade to [] (no hint), never hang. Mirrors the port-check
 *  twin's PORT_CHECK_BUDGET_MS. */
const OUTPUT_CHECK_BUDGET_MS = 5000;

/**
 * On-demand static-output audit for a project's LIVE deployment — the file-side
 * twin of checkProjectPorts. Confirms each routed path actually serves output
 * (catches a wrong Output Directory or a per-domain path with no matching
 * subdir → a silent 404). Advisory: returns [] (no hint) whenever there's
 * nothing to probe.
 *
 * Scope: STATIC apps only (`!hasServer`) — server apps have a listening port,
 * which the port check covers. Live signal is BARE-built self-hosted only.
 * A Docker-sandbox-built static (the default now) serves from a host dir too,
 * but its live runtime is DockerRuntime (no file surface), so — like cloud Pages
 * (workspace deleted post-deploy) — it returns [] and relies on the deploy-time
 * output validation instead (deployStatic throws if the doc-root is missing).
 */
export async function checkProjectOutput(
  ctx: RequestContext,
  projectId: string,
): Promise<OutputCheckResult[]> {
  const project = await repos.project.findById(projectId);
  assertResourceInOrg(project, "Project", ctx.organizationId, projectId);
  if (project.hasServer) return [];
  if (!project.activeDeploymentId) return [];

  const deployment = await repos.deployment.findById(project.activeDeploymentId);
  if (!deployment || !deployment.containerId) return [];

  // Bound the whole probe: a slow/unreachable/asleep remote box must degrade to
  // "no hint", never a timed-out tab. The probe keeps running in the background
  // after the cap (harmless) — the point is the request returns fast.
  return Promise.race([
    runOutputProbe(project, deployment),
    new Promise<OutputCheckResult[]>((resolve) => setTimeout(() => resolve([]), OUTPUT_CHECK_BUDGET_MS)),
  ]);
}

async function runOutputProbe(
  project: NonNullable<Awaited<ReturnType<typeof repos.project.findById>>>,
  deployment: NonNullable<Awaited<ReturnType<typeof repos.deployment.findById>>>,
): Promise<OutputCheckResult[]> {
  const containerId = deployment.containerId;
  if (!containerId) return [];
  try {
    const { runtime } = await resolveDeploymentRuntime(deployment);
    // Only a bare-built static exposes a post-deploy file surface. A
    // Docker-sandbox-built static (DockerRuntime) and cloud Pages (workspace
    // gone, containerId = page:<slug>) have no exec/file surface here —
    // deploy-time validation already guarantees their doc-root.
    if (!(runtime instanceof BareRuntime)) return [];

    // Served root mirrors bare.ts deployStatic + route-registration exactly:
    //   staticRoot = resolveStaticRoot(workDir, outputDirectory)
    //   servedPath = targetPath === "/" ? staticRoot : join(staticRoot, targetPath.slice(1))
    const staticRoot = runtime.resolveStaticRoot(containerId, project.outputDirectory ?? "");
    const routeState = await resolveProjectRouteState(project);
    const seen = new Set<string>();
    const targets: Array<{ path: string; servedPath: string }> = [];
    for (const endpoint of routeState.publicEndpoints) {
      const path = normalizeTargetPath(endpoint.targetPath) ?? "/";
      if (seen.has(path)) continue;
      seen.add(path);
      const servedPath = path === "/" ? staticRoot : pathPosix.join(staticRoot, path.slice(1));
      targets.push({ path, servedPath });
    }
    if (targets.length === 0) targets.push({ path: "/", servedPath: staticRoot });

    return await auditStaticOutput(runtime, containerId, targets, silentLogger);
  } catch {
    return [];
  }
}
