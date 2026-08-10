import { repos } from "@repo/db";
import { type BuildLogger } from "@repo/adapters";
import {
  resolveDeploymentRuntime,
  resolveDeploymentStaticRoot,
  type OutputCheckResult,
} from "../../lib/deployment-runtime";
import { assertResourceInOrg } from "../../lib/controller-helpers";
import type { RequestContext } from "../../lib/request-context";
import { resolveProjectRouteState } from "../domains/project-route.service";
import { auditStaticOutput, staticOutputTargets } from "../deployments/output-audit.service";

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
 * which the port check covers.
 *
 * Probes through the deployment's ROUTING provider, not its runtime. That's what
 * makes a Docker-sandbox-built static (the default) checkable at all: its live
 * runtime is a DockerRuntime with no file surface, so gating on `BareRuntime`
 * meant the common case silently returned [] and leaned entirely on deploy-time
 * validation — which only asserts the doc-root DIRECTORY exists, not that anything
 * servable is in it. The edge, meanwhile, can always be asked. Cloud Pages still
 * returns [] (its provider serves no local files), as it should.
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
    const { runtime, routing } = await resolveDeploymentRuntime(deployment);
    // Where this deployment SERVES from, as recorded by the deploy — the SAME
    // resolver that points the vhost, so this probe audits the exact directory the
    // edge was given rather than a second guess at it. A null root means there's
    // nothing static to audit.
    const staticRoot = resolveDeploymentStaticRoot(deployment, project);
    if (!staticRoot) return [];
    const routeState = await resolveProjectRouteState(project);
    // `routing` (the edge) is asked first — it sees what actually serves the files.
    // The runtime is only the fallback, which is why this no longer gates on
    // BareRuntime: a sandbox-built static persists runtimeMode "bare" and so DID
    // pass that gate, but with the wrong root (project.outputDirectory instead of
    // the extracted release root) — probing `<root>/dist` where the edge serves
    // `<root>` and reporting a phantom "nothing found".
    return await auditStaticOutput(
      { routing, runtime, containerId },
      staticOutputTargets(staticRoot, routeState.publicEndpoints),
      silentLogger,
    );
  } catch {
    return [];
  }
}
