/**
 * Background restart-loop watch for a release that has ALREADY reported ready
 * (GH-672).
 *
 * The blocking stabilization gate (stability-audit.service) is opt-in outside
 * Managed Cloud and deliberately short — it sits on the deploy's critical path.
 * So the default self-hosted deploy goes green the moment its containers exist,
 * and a service that starts crash-looping a few seconds later reads "Live" until
 * someone opens it. This closes that gap without making anyone wait: once the
 * deploy has settled, the same sampler watches every container it started for a
 * longer window, off the request path, and if any of them is bouncing it flags
 * the release so the project reads "Action Required" with the exit code and log
 * tail attached.
 *
 * Advisory by construction:
 *   - It never changes the deployment's status or the service rows. The
 *     steady-state health watch reads `service_deployment.status` as operator
 *     intent; demoting a row to `failure` here would tell it the service is not
 *     supposed to be running and silence its crash-loop incident.
 *   - A runtime that can't be sampled, or a box that can't be reached, yields no
 *     finding — exactly how the deploy-time gate treats its own blind spots.
 *   - The flag only lands while the row is still `ready` / `partial_failure`, and
 *     is ignored once a newer release becomes active (the flag is read off the
 *     ACTIVE deployment only).
 */

import { reportCaughtError as observeCaughtError, diagnostics as errorDiagnostics } from "@repo/core/diagnostics";
import { SYSTEM, safeErrorMessage } from "@repo/core";
import { repos, type Deployment } from "@repo/db";
import { BuildLogger, type RuntimeAdapter } from "@repo/adapters";

import { disposeRuntime, resolveDeploymentRuntimeForRead } from "../../lib/deployment-runtime";
import type { RestartLoopFinding } from "../projects/deployment-flags";
import { verifyDeployedContainers, type StabilityTarget } from "./stability-audit.service";

const SCOPE = "platform/engine/modules/deployments/post-deploy-watch.service";

/** Statuses a background finding may be attached to — a release that is live. */
const WATCHABLE_STATUSES: ReadonlySet<string> = new Set(["ready", "partial_failure"]);

/** Deployments with a watch in flight in THIS process — one watch per release. */
const inFlight = new Set<string>();

/** Injectable seams so the decision logic is testable without a runtime. */
export interface BackgroundWatchDeps {
  resolveRuntime?: (dep: Deployment) => Promise<RuntimeAdapter>;
  release?: (runtime: RuntimeAdapter) => void;
  windowMs?: number;
  pollMs?: number;
}

/**
 * The containers this release started. Compose: every service row that deployed
 * successfully and owns a container (skipped/unchanged services were already
 * live before this release and are the steady-state watch's concern). Single
 * app: the deployment's own container — unless it is a static release
 * directory, which is files, not a process.
 */
export async function collectWatchTargets(dep: Deployment): Promise<StabilityTarget[]> {
  const rows = await repos.serviceDeployment.listByDeployment(dep.id).catch((diagnosticFailure) => {
    observeCaughtError(diagnosticFailure, SCOPE);
    return [];
  });
  if (rows.length > 0) {
    return rows
      .filter((row) => row.status === "success" && row.containerId)
      .map((row) => ({
        serviceId: row.serviceId,
        serviceName: row.serviceName ?? row.serviceId,
        containerId: row.containerId!,
      }));
  }
  if (dep.containerId && !dep.containerId.includes("/")) {
    return [{ serviceName: "app", containerId: dep.containerId }];
  }
  return [];
}

/**
 * Watch a settled release in the background. Returns immediately; the watch
 * itself never throws and never blocks the deploy that scheduled it.
 */
export function scheduleBackgroundStabilityWatch(deploymentId: string, deps?: BackgroundWatchDeps): void {
  if (inFlight.has(deploymentId)) return;
  inFlight.add(deploymentId);
  void runBackgroundStabilityWatch(deploymentId, deps)
    .catch((err) => {
      observeCaughtError(err, SCOPE);
    })
    .finally(() => inFlight.delete(deploymentId));
}

/**
 * The watch itself, awaitable for tests. Resolves to the finding it recorded,
 * or null when everything held (or nothing could be verified).
 */
export async function runBackgroundStabilityWatch(
  deploymentId: string,
  deps: BackgroundWatchDeps = {},
): Promise<RestartLoopFinding | null> {
  const dep = await repos.deployment.findById(deploymentId);
  if (!dep || !WATCHABLE_STATUSES.has(dep.status)) return null;

  const targets = await collectWatchTargets(dep);
  if (targets.length === 0) return null;

  let runtime: RuntimeAdapter;
  try {
    runtime = deps.resolveRuntime
      ? await deps.resolveRuntime(dep)
      : (await resolveDeploymentRuntimeForRead(dep)).runtime;
  } catch (err) {
    // Unreachable box or a target that no longer resolves: a gap in what we
    // know, not a broken workload.
    observeCaughtError(err, SCOPE);
    return null;
  }

  let finding: RestartLoopFinding | null = null;
  try {
    // The build session is closed by now, so there is no stream to write to —
    // the finding is persisted on the row instead.
    const quiet = new BuildLogger();
    const findings = await verifyDeployedContainers(runtime, targets, quiet, {
      windowMs: deps.windowMs ?? SYSTEM.DEPLOYMENTS.BACKGROUND_STABILIZE_WINDOW_MS,
      pollMs: deps.pollMs ?? SYSTEM.DEPLOYMENTS.BACKGROUND_STABILIZE_POLL_MS,
      // Watch the whole window from NOW: the point is to look longer than the
      // deploy did, not to credit the time it already spent.
      creditElapsed: false,
    });
    const unstable = findings.filter((f) => !f.verdict.ok);
    if (unstable.length === 0) return null;

    finding = {
      detectedAt: new Date().toISOString(),
      services: unstable.map((f) => ({
        ...(f.target.serviceId ? { serviceId: f.target.serviceId } : {}),
        serviceName: f.target.serviceName,
        reason: f.verdict.reason,
        exitCode: f.verdict.exitCode ?? null,
        oomKilled: f.verdict.oomKilled === true,
        detail: f.detail.slice(0, 4_000),
      })),
    };
  } finally {
    (deps.release ?? disposeRuntime)(runtime);
  }

  const recorded = await repos.deployment.setRestartLoop(deploymentId, { ...finding }).catch((err) => {
    errorDiagnostics.warn(SCOPE, `Could not record restart loop for deployment ${deploymentId}: ${safeErrorMessage(err)}`, err);
    return false;
  });
  if (!recorded) return null;

  errorDiagnostics.warn(
    SCOPE,
    `Deployment ${deploymentId} reported ready but ${finding.services.map((s) => `"${s.serviceName}"`).join(", ")} ` +
      `is restart-looping: ${finding.services[0]!.reason}`,
  );
  return finding;
}
