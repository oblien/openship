/** Build → deploy execution engine. Extracted from build.service.ts — private pipeline: kickoffBuild fires executeBuildAndDeploy, which runs the build, deploy phases, and post-deploy sync. */

import { posix as pathPosix } from "node:path";
import { repos, type Project, type Deployment, type Domain } from "@repo/db";
import {
  BUILD_ENV_VARS,
  safeErrorMessage,
  sanitizeProxySettings,
  normalizeServiceLabel,
} from "@repo/core";
import { ensureEdgeChallengeReady } from "../../lib/edge-challenge";
import type {
  BuildResult,
  CommandExecutor,
  DeployConfig,
  DeployEnvironment,
  DeploymentResult,
  LogCallback,
  LogEntry,
  PromptUserFn,
  ResourceConfig,
} from "@repo/adapters";
import {
  BareRuntime,
  BuildLogger,
  CloudRuntime,
  DockerRuntime,
  STATIC_RELEASE_BASE,
  resolveStaticOutputPath,
  ensurePortAvailable,
  allocateHostPort,
  runDeployPipeline,
  isMultiServiceRuntime,
  waitForReady,
  ensureEdge,
} from "@repo/adapters";
import { platform } from "../../lib/controller-helpers";
import { resolveUpstreamUrl, resolveRouteStrategy } from "../../lib/upstream-url";
import { webhookProxyTarget } from "../../config";
import {
  resolveDeploymentRuntime,
  resolveDeploymentPlatform,
  resolveEffectiveTarget,
} from "../../lib/deployment-runtime";
import { ensureRoutingReady } from "../../lib/edge-reconcile";
import { sshManager } from "../../lib/ssh-manager";
import {
  resolveBuildRuntimeModes,
  resolveDeployRouting,
  type DeployRouting,
} from "./build-execution-plan";
import { attachLinkedNetworks } from "./attach-linked-networks";
import { syncProjectToServerManifest } from "../../lib/openship-manifest-sync";
import { syncManagedEdgeRoutes, edgeUnsyncedWarning } from "../../lib/managed-edge-proxy";
import { decryptEnvMap } from "../../lib/encryption";
import {
  buildProjectRouteDomains,
  createTrackedSslProvider,
  ensureRouteDomainRecord,
  toRoutedDomainInputs,
} from "../../lib/routing-domains";
import { normalizeTargetPath } from "../../lib/public-endpoints";
import { resolveRuntimeResources, resolveBuildResources } from "../../lib/resources";
import { resolveBuildGitToken } from "../github/clone-auth";
import { openDeployRelay } from "../../lib/git-forwarding";
import { resolveOrgOwner } from "../../lib/org-actor";
import { resolveAcmeProviderOptions } from "../../lib/acme-config";
import {
  preCreateServiceDeployments,
  emitServiceCheckRun,
  emitInitialServiceChecks,
  rollupDeploymentStatus,
} from "./service-checks";
import { firePreDeployBackups } from "../backups/triggers/pre-deploy";
import { buildBackgroundContext } from "../../lib/request-context";
import * as sessionManager from "./session-manager";
import { onFailure, onSuccess, onCancelled, reportPipelineError, setDeploymentStatus, routeIssuesWarning, type LifecycleContext } from "./deployment-lifecycle";
import { auditPorts } from "./port-audit.service";
import { verifyDeployedContainers } from "./stability-audit.service";
import { resolveReadinessGate, runReadinessGate, type ResolvedReadinessGate } from "./readiness-gate";
import { auditStaticOutput, staticOutputTargets } from "./output-audit.service";
import { createBuildConfig } from "./build-config";
import { pinnedAppImage, pinnedStaticDir, snapshotNeedsGitSource } from "./pinned-artifacts";
import { shouldRetainArtifact } from "./rollback/restore-plan";
import { resolveClonePlan } from "./clone-plan";
import { collapseTerminalLogs } from "./terminal-logs";
import { sanitizeLogsForPersistence } from "./build-log-sanitize";
import {
  executeComposePipeline,
  resolveProjectServicePreflightServices,
  shouldUseProjectServicePipeline,
} from "./compose";
import { serviceKind, type DeployableService } from "../../lib/deployable-service";
import {
  resolveProjectRouteState,
} from "../domains/project-route.service";
import { type DeploymentConfigSnapshot } from "./build.service";
import * as settingsService from "../settings/settings.service";

// Build env = CI/telemetry defaults (BUILD_ENV_VARS) + the customer's own env
// vars. NODE_ENV is deliberately NOT set or overridden here: it's the customer's
// to control via their project env vars. Forcing it (e.g. NODE_ENV=production)
// makes npm/pnpm omit devDependencies, which breaks any build whose tooling
// (tailwind, postcss, typescript, …) lives in devDependencies.
function buildScopedEnvVars(envVars: Record<string, string>): {
  envVars: Record<string, string>;
} {
  return { envVars: { ...BUILD_ENV_VARS, ...envVars } };
}

function resolveStaticOutputDirectory(outputDirectory: string, targetPath?: string): string {
  const normalizedTargetPath = normalizeTargetPath(targetPath);
  if (!normalizedTargetPath || normalizedTargetPath === "/") {
    return outputDirectory;
  }

  if (!outputDirectory || outputDirectory === ".") {
    return normalizedTargetPath.slice(1);
  }

  return pathPosix.join(outputDirectory, normalizedTargetPath.slice(1));
}

/**
 * Compose-vs-normal pipeline gate (single source of truth).
 * Single mode short-circuits; otherwise we resolve services + pipeline in parallel.
 */
export async function resolveServicePipelineMode(
  project: Project,
  snapshot: DeploymentConfigSnapshot,
): Promise<{
  useSingleAppPipeline: boolean;
  useServicePipeline: boolean;
  servicePreflightServices: DeployableService[];
}> {
  // A deploy that TARGETS specific service IDs is a per-service action — "add
  // service", or redeploy one service. Those services are their own workspaces/
  // containers, provisioned independently of the project's main app. Run the
  // service pipeline for exactly them regardless of `serviceDeploymentMode`
  // (even a static / single-app main app): the executor scopes the deploy to
  // `targetServiceIds`, so the main app is never touched. This is the seam that
  // separates ADDED services from a NORMAL app deploy.
  const targetsSpecificServices = (snapshot.targetServiceIds?.length ?? 0) > 0;

  if (snapshot.serviceDeploymentMode === "single" && !targetsSpecificServices) {
    return { useSingleAppPipeline: true, useServicePipeline: false, servicePreflightServices: [] };
  }

  const [servicePreflightServices, useServicePipeline] = await Promise.all([
    resolveProjectServicePreflightServices(project.id, snapshot.composeServices),
    shouldUseProjectServicePipeline(project, snapshot.composeServices),
  ]);

  return { useSingleAppPipeline: false, useServicePipeline, servicePreflightServices };
}

/**
 * Spawn the actual build pipeline for a freshly-queued deployment.
 *
 * Three callers (triggerDeployment, startBuild, redeployBuildSession) all
 * need to: locate the build session, register the SSE channel, then
 * fire-and-forget executeBuildAndDeploy with the safety-net error handler.
 * Extracted so changes (telemetry, throttling, queueing) happen in one
 * place instead of drifting across three.
 *
 * Returns the buildSessionId on success, or null when the build session
 * row is missing. The caller decides whether to throw or carry on - for
 * `redeploy` we want to skip silently; for `triggerDeployment` we throw.
 */
export async function kickoffBuild(project: Project, dep: Deployment): Promise<string | null> {
  const buildSession = await repos.deployment.findBuildSessionByDeploymentId(dep.id);
  if (!buildSession) return null;

  // Flip the row to "building" SYNCHRONOUSLY before firing the async
  // `executeBuildAndDeploy`. Without this, callers that chain
  // `redeployBuildSession` → `startBuild` (the dashboard does this on
  // every redeploy, see [build/[id]/page.tsx][1]) hit a race:
  //
  //   1. redeployBuildSession creates dep (status="queued") and calls
  //      kickoffBuild → fires executeBuildAndDeploy as `void`.
  //   2. kickoffBuild returns; the row is STILL "queued" because the
  //      async hasn't updated it yet.
  //   3. Dashboard reads the new deployment_id and calls /build/:id which
  //      runs startBuild → loadDeployment → status="queued" → falls through
  //      the idempotency guard at line ~1045 → kickoffBuild AGAIN.
  //   4. Two executeBuildAndDeploy in parallel for one deployment, both
  //      provisioning workspaces and double-logging to the same SSE
  //      stream - which is what users were seeing.
  //
  // [1]: apps/dashboard/src/app/(dashboard)/(deployment)/build/[id]/page.tsx
  await repos.deployment.updateStatus(dep.id, "building").catch(() => {
    // Best effort - if this fails, the worst case is the old race
    // returns. executeBuildAndDeploy will set the status itself when it
    // starts.
  });
  dep.status = "building";

  sessionManager.createSession(dep.id, project.id);

  void executeBuildAndDeploy(project, dep, buildSession.id).catch(async (err) => {
    console.error(`[DEPLOY] Fatal error for ${dep.id}:`, err);
    // executeBuildAndDeploy's inner try/catch only arms onFailure() after
    // snapshot + route state resolve. Anything that throws before that
    // (missing snapshot, route lookup crash, runtime resolution) would
    // otherwise leave the row queued forever - this guarantees the
    // deployment is marked failed and the SSE stream gets a closing
    // message.
    await markDeploymentFailedFromOutside(dep.id, err);
  });

  return buildSession.id;
}

/**
 * Fallback failure handler for errors thrown out of executeBuildAndDeploy
 * before its own try/catch arms onFailure(). Without this, an early
 * snapshot/route-state crash would leave the deployment stuck at "queued"
 * forever (the void .catch() just logged to console).
 *
 * Idempotent - if the deployment already reached "failed"/"ready"/"cancelled",
 * skips. Otherwise marks failed, flushes a final log line through SSE so the
 * dashboard stops spinning, and ends the session.
 */
async function markDeploymentFailedFromOutside(deploymentId: string, error: unknown): Promise<void> {
  const message = safeErrorMessage(error);
  try {
    const dep = await repos.deployment.findById(deploymentId).catch(() => null);
    if (!dep) return;
    if (["failed", "ready", "cancelled", "action_required"].includes(dep.status)) {
      // Inner onFailure already ran (or the deploy somehow succeeded). Nothing to do.
      // `action_required` counts as "already ran": onFailure wrote it deliberately
      // along with the blocker's code + details, and this function's blind
      // `updateStatus(id, "failed")` below would erase that distinction.
      return;
    }
    await repos.deployment.updateStatus(deploymentId, "failed").catch(() => {});
    const buildSession = await repos.deployment.findBuildSessionByDeploymentId(deploymentId).catch(() => null);
    if (buildSession) {
      await repos.deployment.updateBuildSession(buildSession.id, {
        status: "failed",
        finishedAt: new Date(),
      }).catch(() => {});
    }
    // SSE: surface the error to anyone watching the stream and close it.
    sessionManager.appendLog(deploymentId, {
      timestamp: new Date().toISOString(),
      message: `Deployment failed before build started: ${message}`,
      level: "error",
    });
    sessionManager.updateStatus(deploymentId, "failed");
  } catch (handlerErr) {
    console.error(`[DEPLOY] markDeploymentFailedFromOutside crashed for ${deploymentId}:`, handlerErr);
  }
}


/**
 * Hand the finished deployment to the rollback orchestrator: it retains the
 * previous release (stopping a durable unit when the project keeps artifacts),
 * marks both rows retained, prunes past the rollback window, and reclaims
 * superseded images.
 *
 * Runs for EVERY successful deploy — the retention *preference* is read live
 * from the project inside the orchestrator, not frozen onto the deployment. The
 * old `rollbackStrategy === "git"` bail-out here is exactly what left
 * `artifact_retained_at` null for every default project, which in turn made the
 * dashboard's Rollback action permanently unavailable.
 *
 * Best-effort: the new deployment is already live, so a failure here can only
 * affect restore bookkeeping, never the deploy outcome.
 */
async function archivePreviousDeployment(
  dep: Deployment,
  project: Project,
  logger: BuildLogger,
): Promise<void> {
  try {
    const { onDeploymentReady } = await import("./rollback");
    const finalDep = await repos.deployment.findById(dep.id);
    const prevDep = project.activeDeploymentId
      ? await repos.deployment.findById(project.activeDeploymentId)
      : null;
    if (finalDep) {
      await onDeploymentReady({ newDeployment: finalDep, previousActive: prevDep ?? null });
    }
  } catch (err) {
    logger.log(
      `Warning: failed to record retention for rollback: ${safeErrorMessage(err)}\n`,
      "warn",
    );
  }
}

/**
 * A build that isn't one: this release's artifact is already on the host, so
 * hand the deploy step a BuildResult pointing straight at it.
 *
 * Two shapes, because "the artifact" differs by deploy kind:
 *   - an IMAGE tag (server apps) — verified with the daemon.
 *   - a release DIRECTORY (static sites, which have no image) — verified on the
 *     host filesystem. The deploy step promotes those files again, exactly as it
 *     promotes a freshly-extracted build.
 *
 * Returns null when nothing is pinned or the artifact has since been reclaimed,
 * which is the caller's signal to build from source. A pin is a hint, never a
 * promise — retention may have run between planning a restore and executing it.
 */
async function reuseRetainedArtifact(opts: {
  snapshot: DeploymentConfigSnapshot;
  runtime: { name: string };
  buildSessionId: string;
  targetExecutor?: CommandExecutor | null;
  logger: BuildLogger;
}): Promise<BuildResult | null> {
  const { snapshot, runtime, buildSessionId, targetExecutor, logger } = opts;

  const reuse = (artifactRef: string) => {
    logger.step("build", "completed", `Reusing retained artifact ${artifactRef} — no rebuild needed`);
    return {
      sessionId: buildSessionId,
      status: "deploying" as const,
      imageRef: artifactRef,
      durationMs: 0,
      startCommand: snapshot.startCommand,
    };
  };
  const gone = (artifactRef: string) => {
    logger.log(
      `Retained artifact ${artifactRef} is no longer on the host — rebuilding from source.\n`,
      "warn",
    );
    return null;
  };

  const staticDir = pinnedStaticDir(snapshot);
  if (staticDir) {
    const exists = await (targetExecutor?.exists(staticDir) ?? Promise.resolve(false));
    return exists ? reuse(staticDir) : gone(staticDir);
  }

  const image = pinnedAppImage(snapshot);
  if (!image) return null;
  // Only Docker's artifact is an image; any other runtime takes its normal path.
  const present =
    runtime instanceof DockerRuntime
      ? await runtime.imageExistsLocally(image).catch(() => false)
      : false;
  return present ? reuse(image) : gone(image);
}

/**
 * Finalize a compose (multi-service) deploy after executeComposePipeline:
 * roll the per-service results up into the project-level status (override
 * `ready` with `partial_failure` when some services failed), emit
 * per-service GitHub Checks, then archive the previous deployment.
 * Mirrors the single-app finalize tail in executeServerDeploy.
 */
export async function finalizeComposeDeploy(opts: {
  project: Project;
  dep: Deployment;
  logger: BuildLogger;
}): Promise<void> {
  const { project, dep, logger } = opts;

  // Rollup + per-service Checks. Failures here must not roll back the deploy.
  try {
    const finalDep = await repos.deployment.findById(dep.id);
    if (finalDep && finalDep.status === "ready") {
      const perService = await repos.serviceDeployment.listByDeployment(dep.id);
      const rolled = rollupDeploymentStatus(perService);
      if (rolled === "partial_failure") {
        // A partial failure is held for an explicit user decision: it must NOT
        // read as a clean "Deployed". Persist `decision: "pending"` on the meta
        // block (survives refresh; drives the "Action Required" banner + modal)
        // until the user keeps or rejects it. SSE stays "ready" (the succeeded
        // containers are already live in-place); the dashboard reads the
        // partial_failure row + pending marker for the real state.
        const meta = (finalDep.meta as Record<string, unknown> | null) ?? {};
        const existingCompose =
          (meta.composeDeployment as Record<string, unknown> | undefined) ?? {};
        const composeDeployment: Record<string, unknown> = {
          ...existingCompose,
          decision: "pending",
        };
        const warningMessage =
          (composeDeployment.warningMessage as string | undefined) ||
          "Some services failed — see service deployments for details.";
        // Trace it here too: this was SSE-meta-only, so the partial-failure reason
        // never made it into the persisted log (see the edge-warning note in
        // executeServerDeploy — same fix, same reason).
        logger.log(`Deployment completed with warnings: ${warningMessage}\n`, "warn");
        await setDeploymentStatus(dep.id, "partial_failure", {
          extra: { meta: { ...meta, composeDeployment } },
          sse: {
            status: "ready",
            meta: { warningMessage },
          },
        });
      } else if (rolled === "failed") {
        // Shouldn't happen — the compose pipeline marks ready only on
        // at-least-one success — but guard defensively.
        await setDeploymentStatus(dep.id, "failed");
      }

      // Per-service Checks API events.
      for (const sd of perService) {
        if (!sd.serviceName) continue;
        if (sd.status === "skipped") continue; // already emitted up front
        const conclusion =
          sd.status === "success" || sd.status === "running"
            ? "success"
            : sd.status === "cancelled"
              ? "cancelled"
              : "failure";
        await emitServiceCheckRun({
          project,
          dep,
          serviceDeploymentId: sd.id,
          serviceName: sd.serviceName,
          phase: "complete",
          conclusion,
          output: {
            title: `${sd.serviceName} ${conclusion}`,
            summary: sd.errorMessage ?? sd.error ?? "",
          },
        }).catch(() => {});
      }
    }
  } catch (err) {
    // Rollup failures must not roll back the deploy.
    console.warn(`[build] rollup/Checks emission failed for ${dep.id}:`, err);
  }

  // Archive the predecessor only after this deployment reaches a success state.
  // Failed, cancelled, and reconciling deployments leave the live release intact.
  const settled = await repos.deployment.findById(dep.id).catch(() => null);
  if (settled?.status === "ready" || settled?.status === "partial_failure") {
    await archivePreviousDeployment(dep, project, logger);
  }
}

async function executeBuildAndDeploy(project: Project, dep: Deployment, buildSessionId: string) {
  const plat = platform();
  let { runtime, routing, ssl, system } = plat;

  const snapshot = dep.meta as DeploymentConfigSnapshot | null;
  if (!snapshot) {
    throw new Error("Deployment has no config snapshot (meta is empty)");
  }
  const routeState = await resolveProjectRouteState(project);

  const logs: LogEntry[] = [];
  const MAX_LOG_ENTRIES = 50_000;

  const logCallback = (entry: LogEntry) => {
    if (logs.length < MAX_LOG_ENTRIES) logs.push(entry);
    sessionManager.appendLog(dep.id, entry);
  };

  // Single logger instance for the entire build→deploy lifecycle
  const logger = new BuildLogger(logCallback);

  /**
   * Collapsed logs for DB persistence - resolves \r overwrites to final state,
   * then sanitized: the column is jsonb, which Postgres refuses to store when
   * the payload carries a NUL or an unpaired surrogate. Raw build output does
   * (a failed docker exec surfaces the multiplexed stream, frame headers and
   * all), and the rejected UPDATE used to be read as a deploy failure. This is
   * the ONE place the persisted array is built.
   */
  const persistLogs = () => sanitizeLogsForPersistence(collapseTerminalLogs(logs));

  const provisioned: { imageRef?: string } = {};
  const ctx: LifecycleContext = {
    runtime,
    project,
    dep,
    buildSessionId,
    persistLogs,
    provisioned,
  };

  try {
    // Decide the runtime modes as DATA (no mutate-then-undo). Two historical
    // flips, encoded in resolveBuildRuntimeModes: services → Docker (containers
    // can't run bare); a server/self-hosted STATIC app → BUILD in a Docker sandbox
    // but keep a BARE serve/lifecycle identity (files served by the edge — a
    // persisted "docker" would make rollback/purge 404-no-op on the release dir and
    // leak it). Cloud static + Docker-less desktop-local static keep their own mode.
    const willRunServices = (await resolveServicePipelineMode(project, snapshot)).useServicePipeline;
    const runtimeModes = resolveBuildRuntimeModes({
      hasServer: !!snapshot.hasServer,
      serverId: snapshot.serverId,
      baseTarget: plat.target,
      effectiveTarget: resolveEffectiveTarget(plat.target, snapshot),
      willRunServices,
    });
    if (runtimeModes.buildRuntimeMode === "docker") {
      logger.log(
        willRunServices
          ? "→ Services require the Docker runtime — running this service deploy on Docker.\n"
          : "→ Static build runs in a Docker sandbox; files are served by the edge.\n",
      );
    }

    // Resolve the platform for the BUILD with buildRuntimeMode as an OVERRIDE on a
    // shallow snapshot copy (resolveDeploymentPlatform is read-only) — never mutate
    // the real snapshot for a transient build need.
    const resolved = await resolveDeploymentPlatform(
      runtimeModes.buildRuntimeMode && runtimeModes.buildRuntimeMode !== snapshot.runtimeMode
        ? { ...snapshot, runtimeMode: runtimeModes.buildRuntimeMode }
        : snapshot,
      { organizationId: dep.organizationId, basePlatform: plat },
    );

    runtime = resolved.platform.runtime;
    routing = resolved.platform.routing;
    ssl = resolved.platform.ssl;
    system = resolved.platform.system;
    ctx.runtime = runtime;
    // Persist the serve/lifecycle identity ONCE (no undo): bare for static
    // file-serve, docker for services, unchanged otherwise.
    if (runtimeModes.serveRuntimeMode !== undefined) {
      snapshot.runtimeMode = runtimeModes.serveRuntimeMode;
    }

    // Build + deploy routing, keyed off the RESOLVED runtime (ground truth) — this
    // is the one place the old scattered `instanceof` checks now live.
    const deployRouting = resolveDeployRouting({
      hasServer: !!snapshot.hasServer,
      runtimeName: runtime.name,
      outputDirectory: snapshot.outputDirectory,
    });

    const usesManagedRouting = resolved.usesManagedRouting;
    const targetExecutor: CommandExecutor | null = resolved.platform.executor;

    // Surface the resolved deploy path so the operator can SEE where it lands —
    // in particular the self-hosted sandbox-vs-direct runtime, the choice that
    // could silently flip to "direct" before runtimeMode was persisted.
    logger.log(
      `→ Deploy target: ${resolved.effectiveTarget}` +
        (resolved.serverId ? ` (server ${resolved.serverId.slice(0, 8)})` : "") +
        ` · runtime: ${
          !snapshot.hasServer
            ? "static (built in a Docker sandbox, served as files by the edge)"
            : resolved.runtimeMode === "docker"
              ? "sandboxed (Docker container)"
              : "direct (host process)"
        }\n`,
    );

    await repos.deployment.updateBuildSession(buildSessionId, {
      status: "building",
      startedAt: new Date(),
    });
    await setDeploymentStatus(dep.id, "building");

    // Pre-create service_deployment rows so the dashboard sees a
    // complete fan-out even before any service starts building. Rows
    // for targeted services start as `pending`; everyone else is
    // marked `skipped` up front. The composeBuild pipeline patches
    // status as it goes; we roll up at the end.
    //
    // Done UP FRONT so a downstream crash still leaves a coherent
    // (deployment, services[]) shape behind.
    const serviceFanOut = await preCreateServiceDeployments(dep.id, project.id, {
      targetServiceIds: snapshot.targetServiceIds,
      forceAll: dep.forceAll ?? false,
    }).catch((err) => {
      // Best-effort: fan-out is a dashboard concern. A crash here must
      // not block the main build.
      console.warn(`[build] preCreateServiceDeployments crashed for ${dep.id}:`, err);
      return new Map<string, { id: string; serviceId: string; serviceName: string; targeted: boolean }>();
    });

    await emitInitialServiceChecks(serviceFanOut, project, dep);

    // Target-aware: cloud falls back to the metered free tier, self-hosted falls
    // back to NO limits (the operator's box is the cap). Using the cloud default
    // on both is what pinned every self-hosted container to 512 MB.
    const isCloudDeploy = resolveEffectiveTarget(plat.target, snapshot) === "cloud";
    const prodResources = resolveRuntimeResources(snapshot.resources, { isCloud: isCloudDeploy });
    const buildResources = resolveBuildResources(snapshot.buildResources, {
      isCloud: isCloudDeploy,
    });

    // Decrypt env vars from deployment (self-contained). decryptEnvMap
    // drops keys that fail decryption rather than leaking ciphertext into
    // the build environment.
    const failedEnvKeys: string[] = [];
    const envMap = decryptEnvMap(
      (dep.envVars ?? {}) as Record<string, string>,
      (key: string, err: unknown) => {
        failedEnvKeys.push(key);
        console.warn(
          `[build] failed to decrypt env var ${key}: ${safeErrorMessage(err)}`,
        );
      },
    );
    // Surface dropped env in the BUILD LOG (not just the server console) so a
    // key-rotation data loss is visible to the operator instead of the build
    // silently running with missing env.
    if (failedEnvKeys.length > 0) {
      logger.log(
        `⚠ ${failedEnvKeys.length} environment variable(s) could not be decrypted and were skipped: ` +
          `${failedEnvKeys.join(", ")}. The encryption key likely changed since they were saved — ` +
          `re-enter them in the project's Environment settings and redeploy.`,
        "warn",
      );
    }
    // Single source of truth for buildStrategy, at the point of use. The deploy
    // entry points already resolve this onto the snapshot, but a legacy frozen
    // meta reused via rollback can arrive with it undefined — route through the
    // authority (idempotent for an already-resolved value) instead of a hardcoded
    // "server" fallback that would override the stack default ("local"). Resolved
    // here, at the point of use, so every reader below sees one value.
    const buildStrategy = await settingsService.resolveStrategy(
      snapshot.framework,
      snapshot.buildStrategy,
      { deployTarget: snapshot.deployTarget },
    );
    const buildEnv = buildScopedEnvVars(envMap);

    // Resolve a fresh GitHub token for cloning private repos.
    // Policy lives in resolveBuildGitToken - local builds keep the broad
    // resolver chain (token never leaves the API); remote builds in App
    // mode are installation-only; remote builds in non-App modes still
    // ship the user's token but the preflight check warns first.
    //
    // Org scoping: pass the project's organizationId so the App installation
    // lookup uses (organizationId, owner). The resolver falls back to the
    // per-user installation row when the org has none, but the org path is
    // the canonical one for multi-user deploys.
    // Automated/webhook builds have no human actor. Attribute the GitHub
    // token lookup to the org OWNER — the cloud-identity holder who owns
    // the App installation and is the only role with default GitHub
    // access (members need an explicit grant). A "first member" actor
    // would be DENIED by the github-access gate and break the build.
    const orgOwner = await resolveOrgOwner(dep.organizationId).catch(() => null);
    const actorUserId = orgOwner?.userId ?? "";

    // Resolved up front so the relay-fallback gate below can exclude
    // multi-service builds (whose clone path differs).
    const { useServicePipeline, servicePreflightServices } = await resolveServicePipelineMode(
      project,
      snapshot,
    );

    // "Clone on the server" — clone the repo directly on the remote build host
    // instead of cloning on the orchestrator and transferring the context. The
    // BARE runtime always clones on the target; DOCKER (incl. services) does so
    // only when the deploy opted in (snapshot.cloneStrategy === "server"). Cloud
    // builds run inside the workspace and never apply.
    // Single source of truth for the clone decision — shared with preflight via
    // resolveClonePlan so the two can never disagree (the drift that let preflight
    // pass an api-host clone the pipeline then rejected for a remote token). It
    // decides where the clone runs, the credential purpose that follows from that,
    // and desktop-relay eligibility. The desktop relay (reverse tunnel; nothing
    // persisted) is opted into per deploy via snapshot.forwardGitCredentials.
    const clonePlan = resolveClonePlan({
      effectiveTarget: resolved.effectiveTarget,
      serverId: resolved.serverId,
      runtimeIsBare: runtime.name === "bare",
      cloneStrategy: snapshot.cloneStrategy,
      buildStrategy,
      isDesktop: plat.target === "desktop",
      forwardGitCredentials: snapshot.forwardGitCredentials,
      repoIsGithub: !!project.gitOwner,
    });
    const cloneOnServer = clonePlan.runsOnServer;
    // The relay needs a real SSH reverse tunnel — `reverseForward` exists on every
    // SSH executor and is absent only on a LocalExecutor (relay.ts). This is the
    // TRUE capability gate (not the server's SSH auth method); combined with the
    // config-level relayEligible + a local gh (probed in resolveBuildGitToken),
    // it makes forwarding the automatic clone path ahead of the api-host fallback.
    const allowRelayFallback =
      clonePlan.relayEligible && typeof targetExecutor?.reverseForward === "function";

    // Only resolve a git clone token when the deploy actually needs a SOURCE.
    // A services deploy where every enabled service runs a registry IMAGE (no
    // build / dockerfile / monorepo) clones nothing — so demanding a remote
    // GitHub token there is wrong and hard-fails "No GitHub token available".
    // This is the SAME exemption preflight applies (checkConfig.needsProjectSource),
    // so the two can't disagree. One-click app installs (Convex, n8n, …) are
    // exactly this case: image services, hasBuild=false. This is what makes the
    // app-install and advanced-deploy paths converge on one behavior.
    //
    // A PINNED artifact (rollback restore / migration cutover) is git-free for
    // the same reason: its image already exists, so nothing is cloned or built.
    // snapshotNeedsGitSource owns both answers — see pinned-artifacts.ts.
    //
    // The services list is REQUIRED for the image-only exemption: without it the
    // helper falls back to the project-level hasBuild flag, which a webhook- or
    // adopted-Docker-created snapshot may leave set even though every service runs
    // a registry image. Same arguments preflight passes (preflight.ts) — the two
    // must agree or a rollback resolves a git token it has no use for.
    const needsGitSource = snapshotNeedsGitSource(snapshot, servicePreflightServices);

    const gitCred: Awaited<ReturnType<typeof resolveBuildGitToken>> = needsGitSource
      ? await resolveBuildGitToken({
          ctx: buildBackgroundContext({
            userId: actorUserId,
            organizationId: dep.organizationId,
            label: "build:resolve-git-token",
          }),
          projectId: project.id,
          owner: project.gitOwner ?? undefined,
          repo: project.gitRepo ?? undefined,
          buildStrategy: clonePlan.cloneBuildStrategy,
          // Only meaningful for an on-server clone — lets a per-server GitHub auth
          // config (device token / PAT / SSH key) win for that server.
          serverId: clonePlan.runsOnServer ? resolved.serverId : null,
          allowRelayFallback,
          // Docker clone-on-server can degrade to an api-host clone, so resolve
          // gracefully (a LOCAL fallback credential, flagged apiHostFallback) instead
          // of hard-failing at token resolution after the server is provisioned.
          allowApiHostFallback: clonePlan.dockerClonesOnServer,
          // Lets the chain ask the target server whether it already reaches this
          // repo on its own — only consulted for a clone that runs THERE.
          serverExecutor: clonePlan.runsOnServer ? targetExecutor : null,
          repoUrl: snapshot.repoUrl,
          onLog: (message) => logger.log(message),
        })
      : {};

    // Clone-on-server needs a credential the build host can actually AUTHENTICATE
    // WITH. Four qualify: the server's own ambient git access (nothing moves), an
    // ssh key or App/PAT token we ship it, the desktop relay, or a public repo
    // (nothing needed). An apiHostFallback token is a LOCAL credential for cloning
    // on the orchestrator — NOT usable there — so it does not qualify. When
    // nothing qualifies, fall back to cloning on the API host and transferring the
    // context — warn, never hard-fail. (The BARE runtime always clones on the
    // target and is gated by preflight separately, so this only changes DOCKER.)
    const cloneCredentialAvailable =
      !!gitCred.ambient ||
      gitCred.relay === true ||
      !!gitCred.ssh ||
      gitCred.anonymous === true ||
      (!!gitCred.token && !gitCred.apiHostFallback);
    const effectiveCloneOnServer =
      cloneOnServer && (runtime.name === "bare" || cloneCredentialAvailable);
    if (cloneOnServer && runtime.name !== "bare" && !cloneCredentialAvailable) {
      logger.log(
        "Clone-on-server was requested, but nothing can authenticate the clone on the build host — " +
          "the server has no GitHub identity of its own, no App/PAT token is available, and no git " +
          "identity could be forwarded. Falling back to cloning on the API host and transferring the " +
          "build context. To clone directly on the server, connect it under Servers → GitHub " +
          "(a read-only per-repo deploy key is the narrowest option), or install the Openship App / " +
          "add a per-project clone token.",
        "warn",
      );
    } else if (effectiveCloneOnServer && gitCred.relay) {
      logger.log(
        "Cloning on the build host via your forwarded git identity — the credential is used for this build only and never persisted on the server.",
      );
    }

    // Monorepo sub-app rows (kind="monorepo") fan out through the standard
    // compose pipeline below - each gets its own image, container, and
    // route. Per-app build/start commands live on the service row; no
    // project-row mirroring needed and no snapshot mutation here.

    const buildConfig = createBuildConfig({
      project,
      dep,
      snapshot,
      sessionId: buildSessionId,
      envVars: buildEnv.envVars,
      resources: buildResources,
      gitToken: gitCred.token,
    });
    // A static app builds via the minimal nginx image (generateStaticDockerfile);
    // only this flag selects it. Bare builds ignore it.
    buildConfig.isStatic = !snapshot.hasServer;
    // Folder-upload cloud deploy: the browser uploaded the source straight into
    // a pre-provisioned workspace — adopt it and skip clone + transfer. (The
    // self-hosted upload path instead rides snapshot.localPath, handled above.)
    if (snapshot.uploadWorkspaceId) {
      buildConfig.cloudWorkspaceId = snapshot.uploadWorkspaceId;
      buildConfig.sourceStaged = snapshot.sourceStaged ?? true;
    }
    // When opted in, the runtime clones on the remote build host instead of the
    // orchestrator transferring the context. The credential arrives either via
    // the relay (gitCredentialHelperPath, set once the relay is open) or the
    // short-lived token already on buildConfig.gitToken.
    buildConfig.cloneOnServer = effectiveCloneOnServer;
    // Per-server SSH clone credential (ssh-server-key / ssh-deploy-key mode).
    // Consumed by the adapter clone step (git@github.com + GIT_SSH_COMMAND).
    if (gitCred.ssh) buildConfig.gitSsh = gitCred.ssh;
    // The server authenticates with its own credentials. Gated on the clone
    // actually running there: on the api-host path this names an identity that
    // isn't ours to use, and the adapter would find no credential at all.
    if (gitCred.ambient && effectiveCloneOnServer) buildConfig.gitAmbient = gitCred.ambient;

    // Desktop git-credential relay opener, shared by the single-app and compose
    // paths. Opens the reverse tunnel + remote helper (nothing persisted on the
    // build host); the caller closes it in a `finally` the moment the build (and
    // its clone) finishes. Returns null when no relay was requested.
    const openRelayIfNeeded = async (): Promise<{
      scriptPath: string;
      close: () => Promise<void>;
    } | null> => {
      if (!gitCred.relay) return null;
      if (!targetExecutor || !resolved.serverId) {
        throw new Error(
          "Git credential forwarding is enabled, but no SSH executor is available for this server.",
        );
      }
      const relay = await openDeployRelay({
        serverId: resolved.serverId,
        executor: targetExecutor,
        sessionId: buildSessionId,
        // Repo-pin the relay to exactly this deploy's repo (when known) so it
        // never vends creds for any other repo. Absent owner/repo (e.g. a
        // local-path project) degrades to host-pin only.
        expectedOwner: project.gitOwner ?? undefined,
        expectedRepo: project.gitRepo ?? undefined,
      });
      if (!relay) {
        throw new Error(
          "Git credential forwarding is enabled for this server, but its SSH auth method can't host the credential relay. Use key or password auth for this server, install the GitHub App, or add a per-project token.",
        );
      }
      return relay;
    };

    // Pre-deploy backups — fire for ALL deploy modes (single-app, static-edge,
    // AND compose) before any teardown, so a destructive cutover never runs
    // without a backup. Previously this lived in executeServerDeploy only, so
    // the compose path (which tears down old containers in deployComposeServices)
    // ran with NO backup. Best-effort + policy-gated: we await only the enqueue
    // (durably queued before destruction), never the run — a failing/slow backup
    // must not block the deploy.
    try {
      const preBackup = await firePreDeployBackups({
        projectId: project.id,
        organizationId: dep.organizationId,
      });
      if (preBackup.enqueued > 0 || preBackup.failed > 0) {
        logger.log(`[pre-deploy-backup] enqueued=${preBackup.enqueued} failed=${preBackup.failed}`);
      }
    } catch (err) {
      logger.log(
        `[pre-deploy-backup] trigger crashed (ignoring, best-effort): ${safeErrorMessage(err)}`,
      );
    }

    if (useServicePipeline && isMultiServiceRuntime(runtime)) {
      // snapshot.composeServices is a DeployableService[] - mixed compose +
      // monorepo. syncFromCompose strictly owns compose rows; passing a
      // monorepo entry in causes a ghost compose-kind row to be inserted
      // alongside the real monorepo row (no DB unique constraint on
      // (projectId, name)). Filter to compose-kind before handing it off.
      const composeOnly = snapshot.composeServices?.filter(
        (s) => serviceKind(s) === "compose",
      );
      if (composeOnly?.length) {
        // removeMissing: false — this list is the release's frozen snapshot, not
        // an authoritative inventory. On a rollback it predates services added
        // since; on any deploy the delete cascades `service_deployment` and so
        // empties the input deployComposeServices reaps de-listed containers
        // from. Removal belongs to the explicit reconcile path.
        await repos.service.syncFromCompose(project.id, composeOnly, {
          removeMissing: false,
        });
      }

      // Clone-on-server for compose: open one repo-pinned relay for the whole
      // fan-out (all services share the same repo), thread its helper path into
      // every service buildConfig, and close it once the pipeline settles.
      const composeRelay = await openRelayIfNeeded();
      try {
        await executeComposePipeline({
          project,
          dep,
          runtime,
          routing,
          ssl,
          system,
          executor: targetExecutor,
          usesManagedRouting,
          logger,
          ctx,
          snapshot,
          buildSessionId,
          buildEnvVars: buildEnv.envVars,
          buildResources,
          runtimeResources: prodResources,
          gitToken: gitCred.token,
          gitCredentialHelperPath: composeRelay?.scriptPath,
          gitSsh: gitCred.ssh,
          gitAmbient: effectiveCloneOnServer ? gitCred.ambient : undefined,
          cloneOnServer: effectiveCloneOnServer,
        });
      } finally {
        if (composeRelay) await composeRelay.close().catch(() => {});
      }

      // Roll per-service results up into the project status, emit
      // per-service Checks, and archive the previous deployment.
      await finalizeComposeDeploy({ project, dep, logger });
      return;
    }

    if (useServicePipeline) {
      const msg = `Project services are not supported on the "${runtime.name}" runtime yet. Use Docker runtime or deploy as a single app.`;
      logger.log(msg, "error");
      await onFailure(ctx, msg);
      return;
    }

    if (!snapshot.hasBuild) {
      logger.step(
        "build",
        "completed",
        "Build disabled - skipping install & build, using source directly",
      );
    }

    const buildFromSource = async (): Promise<Awaited<ReturnType<typeof runtime.build>>> => {
      // Desktop git credential relay (fallback): the operator opted this server
      // into forwarding and there's no App/PAT token. Open the relay (reverse
      // tunnel + remote helper) right before the build so the clone fetches the
      // gh identity on demand — nothing persisted on the build host — and tear it
      // down in `finally` the moment the build (and its clone) finishes.
      const deployRelay = await openRelayIfNeeded();
      if (deployRelay) {
        buildConfig.gitCredentialHelperPath = deployRelay.scriptPath;
      }
      try {
        // static-sandbox: build in a Docker sandbox, then extract the doc-root to a
        // host dir the edge serves. Everything else (server apps, bare-built static
        // on a Docker-less local box, cloud) builds normally.
        if (deployRouting.buildMode === "static-sandbox") {
          // buildMode is derived from runtime.name === "docker", so the cast is sound.
          return await (runtime as DockerRuntime).buildStaticToHost(
            buildConfig,
            `${STATIC_RELEASE_BASE}/.builds/${buildSessionId}`,
            logger,
          );
        }
        return await runtime.build(buildConfig, logger);
      } finally {
        // Reverse tunnel + remote helper script torn down regardless of outcome —
        // the credential is reachable only for the build's duration.
        if (deployRelay) await deployRelay.close().catch(() => {});
      }
    };

    // A restore ships the retained artifact PINNED, so there's nothing to build,
    // clone or relay a credential for (see reuseRetainedArtifact). A pin is a
    // hint, never a guarantee — if the artifact is gone we build from source.
    const buildResult =
      (await reuseRetainedArtifact({ snapshot, runtime, buildSessionId, targetExecutor, logger })) ??
      (await buildFromSource());
    provisioned.imageRef = buildResult.imageRef;

    if (buildResult.status === "cancelled") {
      await onCancelled(ctx, buildResult.durationMs);
      return;
    }

    if (buildResult.status === "failed") {
      await onFailure(ctx, buildResult.errorMessage ?? "Build failed", buildResult.durationMs);
      return;
    }

    // Guard: build must produce an imageRef to proceed to deploy
    if (buildResult.status !== "deploying" || !buildResult.imageRef) {
      const msg = "Build completed but did not produce a deployable artifact";
      logger.step("build", "failed", msg);
      await onFailure(ctx, msg, buildResult.durationMs);
      return;
    }

    await setDeploymentStatus(dep.id, "deploying", {
      extra: { imageRef: buildResult.imageRef, buildDurationMs: buildResult.durationMs },
    });

    const phase: DeployPhaseInputs = {
      ctx,
      project,
      dep,
      snapshot: snapshot,
      buildSessionId,
      runtime,
      routing,
      ssl,
      system,
      targetExecutor,
      baseTarget: plat.target,
      effectiveTarget: resolved.effectiveTarget,
      serverId: resolved.serverId,
      usesManagedRouting,
      routeState,
      buildResult,
      envMap,
      prodResources,
      logger,
      deployRouting,
    };

    // deployMode is derived from runtime.name === "cloud", so the cast is sound.
    if (deployRouting.deployMode === "static-edge") {
      await executeStaticEdgeDeploy(phase, runtime as CloudRuntime);
    } else {
      await executeServerDeploy(phase);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    if (process.env.OPENSHIP_DEBUG_PIPELINE) console.error("[pipeline]", err);
    // Only an UNSETTLED error is a deploy failure. An error thrown after the
    // outcome was recorded is bookkeeping: reporting it as a failure would
    // invert a working deploy and tear its containers down.
    await reportPipelineError(ctx, message, logger);
  }
}

interface DeployPhaseInputs {
  ctx: LifecycleContext;
  project: Project;
  dep: Deployment;
  snapshot: DeploymentConfigSnapshot;
  buildSessionId: string;
  runtime: Awaited<ReturnType<typeof platform>>["runtime"];
  routing: Awaited<ReturnType<typeof platform>>["routing"];
  ssl: Awaited<ReturnType<typeof platform>>["ssl"];
  system: Awaited<ReturnType<typeof platform>>["system"];
  targetExecutor: CommandExecutor | null;
  /** Base platform target ("desktop" | "selfhosted" | "cloud") + the resolved
   *  per-deployment target/server — used to gate the `.openship` manifest write
   *  to desktop-mode server deploys only. */
  baseTarget: string;
  effectiveTarget: string;
  serverId: string | null;
  usesManagedRouting: boolean;
  routeState: Awaited<ReturnType<typeof resolveProjectRouteState>>;
  buildResult: BuildResult;
  envMap: Record<string, string>;
  prodResources: ResourceConfig;
  logger: BuildLogger;
  /** Build/deploy routing decided once from the resolved runtime (static-sandbox /
   *  static-file-serve / server / static-edge) — replaces scattered `instanceof`. */
  deployRouting: DeployRouting;
}

/** Static edge deploy via CloudRuntime (Oblien Pages). */
async function executeStaticEdgeDeploy(
  phase: DeployPhaseInputs,
  runtime: CloudRuntime,
): Promise<void> {
  const { ctx, project, dep, snapshot, buildSessionId, routeState, buildResult, envMap, prodResources, logger } = phase;

  logger.step("deploy", "running", "Deploying to edge (static)...");

  const staticResult = await runtime.deployStatic({
    deploymentId: dep.id,
    projectId: project.id,
    buildSessionId,
    imageRef: buildResult.imageRef!,
    environment: dep.environment,
    port: snapshot.port,
    startCommand: snapshot.startCommand,
    stack: snapshot.framework,
    envVars: envMap,
    resources: prodResources,
    restartPolicy: "no",
    runtimeName: project.slug ?? project.id,
    publicEndpoints: routeState.publicEndpoints,
    outputDirectory: resolveStaticOutputDirectory(
      snapshot.outputDirectory,
      routeState.publicEndpoints[0]?.targetPath,
    ),
    projectName: project.name,
  });

  if (staticResult.status === "failed" || !staticResult.containerId) {
    logger.step("deploy", "failed", "Static deploy failed");
    await onFailure(ctx, "Failed to deploy static site to edge", buildResult.durationMs);
    return;
  }

  logger.step("deploy", "completed", "Deployed to edge successfully");

  await onSuccess(ctx, {
    containerId: staticResult.containerId,
    url: staticResult.url,
    durationMs: buildResult.durationMs ?? 0,
  });

  // Archive the previous-active deployment for rollback — same helper the
  // server + compose paths use. (Previously hand-copied here WITHOUT the
  // helper's best-effort try/catch, so an archive failure threw and failed the
  // deploy; the shared helper keeps it best-effort per its contract.)
  await archivePreviousDeployment(dep, project, logger);
}

/**
 * How a deploy SERVES its workload — the one place the static-file-serve vs
 * running-process divergence lives. `buildDeployEnvironment` composes the
 * DeployEnvironment from a `ServeStrategy` (the divergent bits) + shared
 * orchestration (edge/routing/SSL setup, previous-deployment teardown, upstream
 * URL) — so no closure re-branches `isStaticFileServe`/`runtime.name`.
 */
interface ServeStrategy {
  readonly restartPolicy: "no" | "always";
  readonly canOverlap: boolean;
  /** Preflight: ensure the runtime/toolchain is ready. Noop for static file-serve
   *  (nothing runs). */
  ensureRuntimeReady(): Promise<void>;
  /** Preflight: ensure the workload's host ports are free. Noop for file-serve
   *  (no listening port). */
  ensurePorts(config: DeployConfig, promptUser: PromptUserFn): Promise<void>;
  /** Deploy the workload; the caller checks containerId + shapes the result. */
  activate(config: DeployConfig, onLog: LogCallback): Promise<DeploymentResult>;
  /** File-serve → a filesystem `root`; running processes route via resolveTargetUrl. */
  resolveRoute?: (containerId: string, config: DeployConfig) => Promise<{ staticRoot: string }>;
  /**
   * Post-activate readiness probe. What "ready" means is the strategy's business:
   * a running process answers on its port, a static site has servable files.
   *
   * REPORTS rather than throws: returns a failure detail, or null when the check
   * passed. The caller owns the verdict, because whether a failure warns or vetoes
   * the deploy is the project's `readiness.onFailure` choice, not this strategy's.
   */
  readiness?: (containerId: string, config: DeployConfig) => Promise<string | null>;
  /**
   * Can `readiness` answer for a REMOTE target?
   *
   * false (running process): the probe dials a port from the orchestrator, and a
   *   remote app's port isn't reachable from here — so it only runs for local.
   * true (static file-serve): the probe goes through the routing provider, which
   *   reaches the edge wherever it lives, so a remote server is fine.
   *
   * Without this the static check would be skipped on every remote deploy — i.e.
   * exactly the deploys where a missing doc-root is hardest to notice.
   */
  readinessWorksRemotely?: boolean;
}

/**
 * Build the runtime DeployEnvironment (preflight + activate + deactivate +
 * route/url resolvers) for a server deploy. The static-vs-process divergence is
 * encapsulated in `serve`; this composes it with the shared orchestration.
 */
function buildDeployEnvironment(
  phase: DeployPhaseInputs,
  deps: {
    serve: ServeStrategy;
    previousRuntime: DeployPhaseInputs["runtime"];
    plannedDomains: ReturnType<typeof buildProjectRouteDomains>;
    /** The project's opted-in readiness gate. `active: false` (the default) ⇒ no
     *  gate is wired at all and the pipeline skips the step. */
    readinessGate: ResolvedReadinessGate;
    /** Sink for a failure the gate decided to WARN about rather than veto. The
     *  caller folds these into the deploy's action-required warning. */
    onReadinessWarning: (detail: string) => void;
  },
): DeployEnvironment {
  const { runtime, system, targetExecutor, routeState, logger, effectiveTarget, project } = phase;
  const { serve, previousRuntime, plannedDomains, readinessGate, onReadinessWarning } = deps;

  return {
    canOverlap: serve.canOverlap,
    // Post-activate readiness gate — OPT-IN, and omitted entirely when the
    // project didn't ask for one, so runDeployPipeline skips the step rather than
    // calling a check that does nothing. That absence IS the default: a deploy
    // reports ready as soon as the workload is up and routed. Listening state is
    // still reported, by the advisory in-container `auditPorts` probe that runs
    // after the deploy is live and cannot fail it.
    //
    // When a project does opt in, up to two layers run:
    //
    //  1. Stabilization — watch the container we just started and fail if it
    //     bounces or exits. Asked of the RUNTIME (docker inspect), so unlike the
    //     TCP probe it works for remote/SSH targets too.
    //  2. Readiness probe — local targets only; the app runs on this host, so a
    //     refused/timed-out connection genuinely means it never came up.
    //
    // `onFailure` decides what a failure means. "warn" (the default even when
    // opted in) keeps the deploy ready and records an action-required warning;
    // only "fail" throws, which vetoes the deploy before traffic is repointed and
    // reverts to the previous deployment.
    // Ordering + the warn-vs-fail decision live in runReadinessGate (readiness-gate.ts),
    // shared with the compose pipeline so the two can't drift. This is just the
    // adapter that supplies the two effects.
    //
    // `healthCheck` is the PIPELINE's name for this hook (DeployEnvironment, in
    // @repo/adapters) and predates the project-level `readiness` field — the
    // pipeline gates on any readiness verdict, whatever the caller calls it.
    healthCheck: !readinessGate.active
      ? undefined
      : (containerId, cfg) =>
          runReadinessGate({
            gate: readinessGate,
            // A path-shaped id is a static release DIR — files, not a process, so
            // there is nothing to watch for a restart loop.
            stabilize: containerId.includes("/")
              ? undefined
              : async (windowMs) => {
                  const [unstable] = (
                    await verifyDeployedContainers(
                      runtime,
                      [{ serviceName: project.name || project.slug || "app", containerId }],
                      logger,
                      { windowMs },
                    )
                  ).filter((finding) => !finding.verdict.ok);
                  return unstable ? unstable.detail : null;
                },
            // A port probe dials from the orchestrator, so it only answers for a
            // LOCAL target. The static file probe goes through the routing provider
            // and reaches the edge anywhere, so it isn't restricted.
            probe:
              serve.readiness && (effectiveTarget === "local" || serve.readinessWorksRemotely)
                ? () => serve.readiness!(containerId, cfg)
                : undefined,
            probeSkippedReason: serve.readiness
              ? `Readiness: skipped — dialing the app's port only works for a local ` +
                `target (this deploy targets "${effectiveTarget}"). Turn on the ` +
                `restart-loop watch to cover remote targets.`
              : undefined,
            onWarn: onReadinessWarning,
            log: (message, level) => logger.log(`${message}\n`, level ?? "info"),
          }),
    // Auto-revert for the stop-first (non-overlap) path. Wired for BOTH runtimes:
    // Docker takes this path too whenever routeStrategy is loopback-port (the
    // default), and while it was bare-only a failed gate left the old container
    // force-removed with nothing to restore — the new one was reaped as well, so a
    // failed readiness check took the app down entirely. `deactivate` now stops
    // (retains) the previous container on this path, so there is something to start.
    reactivatePrevious: (id: string) =>
      id.includes("/") ? Promise.resolve() : previousRuntime.start(id),
    preflight: targetExecutor
      ? async (cfg, promptUser) => {
          if (system) {
            const systemLog = (entry: { message: string; level: "info" | "warn" | "error" }) => {
              logger.log(`${entry.message}\n`, entry.level);
            };

            await serve.ensureRuntimeReady();
            // Domains are OPTIONAL — edge/routing/SSL toolchain setup is
            // best-effort and must NEVER fail the deploy. If OpenResty/certbot
            // can't be installed, or 80/443 takeover is declined, the app still
            // deploys and runs on its port; routing is flagged action-required
            // and retried later (route registration below is also best-effort).
            try {
              if (plannedDomains.length > 0) {
                // Routing needs OpenResty on 80/443. If a foreign proxy already
                // holds them, HOLD the deploy and prompt (migrate / take over /
                // cancel) — the same session prompt flow used for port conflicts.
                const edge = await ensureEdge(
                  targetExecutor,
                  (p) =>
                    ensureRoutingReady(targetExecutor, system, {
                      onLog: systemLog,
                      promptUser: p,
                    }),
                  { promptUser, onLog: systemLog, nginx: resolveAcmeProviderOptions() },
                );
                if (edge.migrated && !edge.ok) {
                  // ensureEdge already rolled back to the previous proxy — we
                  // just don't fail the deploy over it.
                  logger.log(
                    "Edge migration failed — rolled back to the previous proxy; the app will deploy unrouted (Retry routing from the Domains tab).\n",
                    "warn",
                  );
                }
              }
              // Prepare certbot for pending custom domains too. Issuance still
              // waits for verification, but Verify/the background verifier must
              // not require a second deploy merely to install the toolchain.
              if (plannedDomains.some((d) => d.requiresSslTooling)) {
                await system.ensureFeature("ssl", systemLog);
              }
              // Same idea for Openship Cloud's target check: make the box able to
              // answer it now, so a free domain added later doesn't need a redeploy
              // first. Cheap and idempotent (a couple of stats once written).
              await ensureEdgeChallengeReady(phase.project.organizationId, phase.routing, {
                serverId: phase.serverId ?? undefined,
                onLog: (m) => logger.log(m, "warn"),
              });
            } catch (err) {
              logger.log(
                `Edge/routing setup failed — deploy continues; the app runs on its port and routing is retried later: ${safeErrorMessage(err)}\n`,
                "warn",
              );
            }
          }

          await serve.ensurePorts(cfg, promptUser);
        }
      : undefined,
    activate: async (cfg, onLog) => {
      const r = await serve.activate(cfg, onLog);
      if (!r.containerId) throw new Error("Deploy produced no container");
      return { containerId: r.containerId, url: r.url };
    },
    deactivate: (id) => {
      // A path-shaped id is a static release DIR — remove the files. A bare
      // previousRuntime's destroy already rm's it; but a post-change static's
      // previousRuntime resolves to Docker, whose destroy(dir) is a 404 no-op
      // that would LEAK the dir, so rm it ourselves via the target FS.
      if (id.includes("/")) {
        if (previousRuntime.name === "bare") return previousRuntime.destroy(id);
        if (targetExecutor) return targetExecutor.rm(id);
        return previousRuntime.destroy(id);
      }
      return previousRuntime.name === "bare" ? previousRuntime.stop(id) : previousRuntime.destroy(id);
    },
    // The non-overlap pre-stop: free the port, but keep the old workload
    // restorable until the new one proves out. STOP for both runtimes — Docker
    // used to force-remove here, which is why a failed health gate could take the
    // app down with nothing to revert to.
    //
    // A path-shaped id is a static release DIR: nothing is "running", so there is
    // no port to free and nothing to stop. Leaving it in place is what makes it
    // restorable; `deactivate` above still removes it on the overlap/success path.
    deactivateRetaining: (id) =>
      id.includes("/") ? Promise.resolve() : previousRuntime.stop(id),
    // Discard the retained container after success. Container runtimes only: bare's
    // stopped release is a DIRECTORY owned by the retention/rollback window, and
    // destroying it here would delete a release that rollback still expects (bare
    // already only ever stopped it, so "no retire" is its existing behaviour).
    retireRetainedPrevious:
      previousRuntime.name === "bare"
        ? undefined
        : (id: string) => (id.includes("/") ? Promise.resolve() : previousRuntime.destroy(id)),
    // Release the port the failed deployment is holding so the revert can rebind
    // it. Uses the CURRENT runtime (it started this container), not previousRuntime.
    stopActivated: (id: string) => (id.includes("/") ? Promise.resolve() : runtime.stop(id)),
    resolveRoute: serve.resolveRoute,
    resolveTargetUrl: async (id, port) => {
      const strategy = resolveRouteStrategy(phase.project.routeStrategy);
      // loopback-port: dial the container's published LOOPBACK host port (read
      // live — works with a pinned or random publish). Bare has none → the
      // helper falls back to 127.0.0.1:<appPort>. A container with no host port
      // falls back to the bridge IP. The post-activate health check gates all
      // of this, so a bad target fails the deploy, not the live route.
      let hostPort: number | undefined;
      if (strategy === "loopback-port" && runtime.name !== "bare") {
        hostPort = (await runtime.getContainerInfo(id).catch(() => null))?.hostPort ?? undefined;
      }
      return resolveUpstreamUrl({ strategy, runtime, containerId: id, containerPort: port, hostPort });
    },
  };
}

/** Server deploy via runDeployPipeline (VM / Docker / Bare). Handles static-self-hosted too. */
async function executeServerDeploy(phase: DeployPhaseInputs): Promise<void> {
  const {
    ctx, project, dep, snapshot, buildSessionId,
    runtime, routing, ssl, usesManagedRouting,
    routeState, buildResult, envMap, prodResources, logger,
  } = phase;

  // Static sites are served as files by the edge (OpenResty `root`), regardless
  // of how they were BUILT — a Docker sandbox (server/self-hosted, the common
  // case) or bare (Docker-less desktop "This Machine"). A dedicated bare
  // file-serve runtime rooted at the edge-shared STATIC_RELEASE_BASE promotes
  // the built dir into a release and hands the edge a `root`. Its executor is
  // the platform executor, which is exactly the FS the build wrote to (SSH for a
  // remote server; local for a local / docker-edge host where the extract landed
  // on the shared /opt/openship/static mount).
  const isStaticFileServe = phase.deployRouting.deployMode === "static-file-serve";
  const staticServeRuntime = isStaticFileServe
    ? new BareRuntime({
        workDir: STATIC_RELEASE_BASE,
        executor: phase.targetExecutor ?? undefined,
      })
    : null;
  // Where the static doc-root lives: "" when a Docker sandbox build already
  // extracted it (release root), else the configured output dir (bare build).
  const staticServeOutputDir = phase.deployRouting.staticServeOutputDir;

  // loopback-port routing pins a stable LOOPBACK host port for docker so the
  // edge target is predictable and survives container restarts. Reused across
  // redeploys (persisted on the project); allocated once on first deploy from a
  // live-probed free port. Bare owns 127.0.0.1:<port> and needs none. The
  // `effectiveTarget !== "cloud"` guard makes explicit that a cloud deploy never
  // allocates a host port on the orchestrator (cloud routes via Oblien, not a
  // loopback port) — defense-in-depth against a cloud→host-exec slip.
  const routeStrategy = resolveRouteStrategy(project.routeStrategy);

  // The project's OPT-IN readiness gate. Inactive unless the project configured
  // one, and inactive is the default — so by default nothing waits on the app
  // after start and nothing can veto a deploy whose workload came up. Listening
  // state still gets reported by the advisory `auditPorts` probe further down.
  const readinessGate = resolveReadinessGate(project.readiness);
  // Failures the gate chose to WARN about (onFailure: "warn"), folded into the
  // deploy's action-required warning alongside routing issues.
  const readinessWarnings: string[] = [];

  // How this deploy SERVES — the single object holding the static-file-serve vs
  // running-process divergence (restart/overlap, preflight, activate, route,
  // health). buildDeployEnvironment composes the pipeline env from it; the shared
  // edge/routing orchestration stays there (not duplicated per strategy).
  const serve: ServeStrategy = isStaticFileServe
    ? {
        restartPolicy: "no",
        canOverlap: false,
        ensureRuntimeReady: async () => {},
        ensurePorts: async () => {},
        activate: (cfg) =>
          staticServeRuntime!.deployStatic({ ...cfg, outputDirectory: staticServeOutputDir }),
        resolveRoute: async (id) => ({
          staticRoot: resolveStaticOutputPath(id, staticServeOutputDir),
        }),
        // A static site has no port to dial, so "ready" means the FILES are
        // servable: the routed path resolves and has an index. Probed from where
        // the edge actually looks (auditStaticOutput picks the vantage point), so
        // this catches the one failure mode a static deploy has — a 404 — which a
        // port probe structurally cannot see.
        //
        // Same probe as the always-on advisory `outputCheck` below; the difference
        // is only consequence. That one records a hint, this one can gate the
        // deploy when the project opted in with onFailure "fail".
        readiness: async (containerId) => {
          const targets = staticOutputTargets(
            resolveStaticOutputPath(containerId, staticServeOutputDir),
            routeState.publicEndpoints,
          );
          const findings = await auditStaticOutput(
            { routing, runtime: staticServeRuntime, containerId },
            targets,
            logger,
          );
          // `checked:false` is "we couldn't look", not "it's broken" — an
          // inconclusive probe must never veto a deploy.
          const broken = findings.filter((f) => f.checked && (!f.found || !f.hasIndex));
          if (broken.length === 0) return null;
          return broken
            .map((f) =>
              f.found
                ? `${f.path}: no servable index at ${f.servedPath ?? "the routed path"} — this path will 404.`
                : `${f.path}: nothing at ${f.servedPath ?? "the routed path"} — this path will 404.`,
            )
            .join("\n");
        },
        // Probed through the routing provider, so a remote server answers too.
        readinessWorksRemotely: true,
      }
    : {
        restartPolicy: "always",
        // Overlap (run-new-then-swap, zero-downtime) needs a unique container +
        // its own host port; a pinned loopback port can't be double-bound and bare
        // binds a fixed port → stop-first.
        canOverlap: runtime.name !== "bare" && routeStrategy !== "loopback-port",
        ensureRuntimeReady: async () => {
          const system = phase.system;
          if (!system) return;
          await system.ensureFeature("deploy", (entry) => logger.log(`${entry.message}\n`, entry.level));
        },
        ensurePorts: async (cfg, promptUser) => {
          const executor = phase.targetExecutor;
          if (!executor) return;
          // A published container binds exactly ONE host port — the loopback pin.
          // Its own port lives in the container's network namespace and can never
          // collide on the host, so probing it there compares an unrelated number
          // against the host's listeners: an app on 80 behind the edge reported a
          // conflict with the edge itself, and the only "continue" action offered
          // would have freed the edge — taking every routed site down to publish
          // one. Probe what the workload actually binds, which is also the
          // backstop `allocateHostPort` documents.
          if (cfg.hostPort !== undefined) {
            // The outgoing deployment still holds the pin at preflight time: the
            // loopback-port strategy can't overlap, so the pipeline stops it in
            // the very next step. Prompting the operator about our own container
            // would stall every redeploy on a conflict that resolves itself.
            const previousHostPort = prevDep?.containerId
              ? await previousRuntime
                  .getContainerInfo(prevDep.containerId)
                  .then((info) => info?.hostPort)
                  .catch(() => undefined)
              : undefined;
            if (previousHostPort !== cfg.hostPort) {
              await ensurePortAvailable(executor, cfg.hostPort, logger, promptUser);
            }
            return;
          }
          // Bare: the app owns 127.0.0.1:<port> on the host, so its declared
          // ports are the ones to check.
          const ports = Array.from(
            new Set(
              (routeState.publicEndpoints.length > 0
                ? routeState.publicEndpoints
                : [{ port: cfg.port }])
                .map((endpoint) => endpoint.port ?? cfg.port)
                .filter((port): port is number => Number.isFinite(port)),
            ),
          );
          for (const port of ports) {
            await ensurePortAvailable(executor, port, logger, promptUser);
          }
        },
        activate: async (cfg, onLog) => {
          const deployed = await runtime.deploy(cfg, onLog);
          // Single-app consumer: join the networks of any internally-linked
          // source apps so injected internal hosts (e.g. db:5432) resolve. The
          // compose path does this in compose/deploy.service.ts; this closes the
          // single-container gap. Advisory — never fails the deploy.
          await attachLinkedNetworks(project.id, runtime, (m, level) => logger.log(`${m}\n`, level));
          return deployed;
        },
        resolveRoute: undefined,
        readiness: async (containerId, cfg) => {
          let host = "127.0.0.1";
          // An explicit `readiness.port` overrides; otherwise probe the app port
          // and let the container-runtime lookup below remap it to the published one.
          let port = readinessGate.probe.port ?? cfg.port;
          if (runtime.name !== "bare" && readinessGate.probe.port === undefined) {
            // Container runtime: prefer the published host port; fall back to the
            // container's bridge IP:port (reachable on the local daemon).
            try {
              const info = await runtime.getContainerInfo(containerId);
              if (info?.hostPort) {
                port = info.hostPort;
              } else if (runtime.supports("containerIp")) {
                const ip = await runtime.getContainerIp(containerId);
                if (ip) host = ip;
              }
            } catch {
              /* fall back to 127.0.0.1:cfg.port */
            }
          }
          // Name the address actually dialed. Reporting `cfg.port` here sent
          // operators to look at the app's own port (3000) when the probe had
          // really been talking to the published host port, so a wrong-port or
          // unreachable-address failure read as "my app is broken".
          const target = `${host}:${port}${readinessGate.probe.path ?? ""}`;
          const seconds = Math.round(readinessGate.probe.timeoutMs / 1000);
          logger.log(
            `Health check: waiting up to ${seconds}s for the app to answer at ${target}` +
              `${readinessGate.probe.path ? "" : " (TCP connect)"}…\n`,
          );
          const ready = await waitForReady(host, port, {
            path: readinessGate.probe.path,
            timeoutMs: readinessGate.probe.timeoutMs,
            intervalMs: readinessGate.probe.intervalMs,
          });
          if (!ready) {
            return (
              `The app never answered at ${target} within ${seconds}s` +
              `${readinessGate.probe.path ? " (or answered 500+)" : ""}. It may have crashed on ` +
              `startup, may still be booting, or may be listening on a different port than ${cfg.port} ` +
              `— check the runtime logs.`
            );
          }
          logger.log(`Health check passed: the app answered at ${target}.\n`);
          return null;
        },
      };

  let pinnedHostPort: number | undefined = project.hostPort ?? undefined;
  if (
    routeStrategy === "loopback-port" &&
    !isStaticFileServe &&
    runtime.name !== "bare" &&
    phase.effectiveTarget !== "cloud"
  ) {
    if (!pinnedHostPort) {
      // Avoid host ports already pinned to OTHER projects in this org — their
      // containers may not be listening right now, so the live scan alone
      // wouldn't see them and two projects could collide on the same loopback
      // port (ensurePortAvailable is only the deploy-time backstop).
      const avoid = (
        await repos.project
          .listByOrganization(project.organizationId, { perPage: 1000 })
          .then((r) => r.rows)
          .catch(() => [] as { id: string; hostPort: number | null }[])
      )
        .filter((p) => p.id !== project.id && typeof p.hostPort === "number")
        .map((p) => p.hostPort as number);
      // The deploy's own executor when it has one; otherwise the POOLED host
      // channel — never a bare `createHostExecutor()`, which builds a fresh
      // SSH connection per call and leaked one sshd session each time (#291).
      pinnedHostPort = phase.targetExecutor
        ? await allocateHostPort(phase.targetExecutor, { avoid })
        : await sshManager.withHostExecutor((exec) => allocateHostPort(exec, { avoid }));
      await repos.project
        .update(project.id, { hostPort: pinnedHostPort })
        .catch((err) => logger.log(`Couldn't persist host port ${pinnedHostPort}: ${safeErrorMessage(err)}\n`, "warn"));
    }
  } else {
    pinnedHostPort = undefined; // don't publish a pinned port under container-ip / bare / static
  }

  const deployConfig: DeployConfig = {
    deploymentId: dep.id,
    projectId: project.id,
    buildSessionId,
    imageRef: buildResult.imageRef!,
    environment: dep.environment,
    port: snapshot.port,
    hostPort: pinnedHostPort,
    // The build may override the start command once it knows the output shape
    // (e.g. Next.js standalone → `node server.js` instead of `next start`).
    startCommand: buildResult.startCommand ?? snapshot.startCommand,
    stack: snapshot.framework,
    envVars: envMap,
    resources: prodResources,
    restartPolicy: serve.restartPolicy,
    runtimeName: project.slug ?? project.id,
    slug: project.slug ?? project.id,
    // Stable per-project DNS alias so a single-app native container is
    // reachable east-west (another linked project resolves `<alias>:<port>`),
    // mirroring what compose services already get. Read only by
    // DockerRuntime.deploy(); other runtimes ignore it. Publishing stays
    // loopback-only — an alias is not exposure until an explicit link
    // (attachLinkedNetworks) puts a consumer on this project's network.
    networkAlias: normalizeServiceLabel(project.slug || project.name),
    // A user-chosen custom hostname (Stage D) resolves ALONGSIDE the default.
    extraAliases: project.internalAlias
      ? [normalizeServiceLabel(project.internalAlias)]
      : undefined,
    publicEndpoints: routeState.publicEndpoints,
    outputDirectory: snapshot.outputDirectory,
    // Optional chaining for the same reason as `volumes` below: a snapshot
    // persisted before this field existed (or one that simply never set it) has
    // none, and a redeploy/restore of that release must not crash on it. It did —
    // `.length` on undefined — which made every such release un-restorable.
    productionPaths: snapshot.productionPaths?.length ? snapshot.productionPaths : undefined,
    // `?? []` because a snapshot persisted before this field existed has none —
    // redeploying an old deployment must not crash on it.
    volumes: snapshot.volumes ?? [],
    // Bare uses this to hard-link identical files across releases.
    // Other runtimes ignore it.
    previousDeploymentId: project.activeDeploymentId ?? undefined,
  };

  // Resolve the previous deployment + its runtime so we can deactivate it cleanly.
  const prevDep = project.activeDeploymentId
    ? await repos.deployment.findById(project.activeDeploymentId)
    : null;
  const previousRuntime = prevDep?.containerId
    ? await resolveDeploymentRuntime(prevDep)
        .then((r) => r.runtime)
        .catch(() => runtime)
    : runtime;

  // buildProjectRouteDomains turns the project's public endpoints (and
  // existing domain rows) into concrete routes. We persist a domain
  // record for each up front because SSL provisioning inside
  // runDeployPipeline writes cert status back onto these rows.
  const projectDomains = await repos.domain.listByProject(project.id);
  const domainByHostname = new Map(
    projectDomains.map((domain) => [domain.hostname.toLowerCase(), domain]),
  );
  const plannedDomains = buildProjectRouteDomains({
    project,
    projectDomains,
    managedSlug: routeState.publicEndpoints.length > 0 ? routeState.primarySlug : undefined,
    publicEndpoints: routeState.publicEndpoints,
    runtimeName: runtime.name,
    usesManagedRouting,
    isStatic: isStaticFileServe,
  });
  // Domains to prune after a successful deploy: project-level rows that
  // no longer back a current public endpoint AND aren't among the routes
  // we just planned. The size>0 guard is a safety valve — if endpoint
  // resolution yielded nothing (transient/empty), prune nothing rather
  // than nuke every route. The plannedHostnames check is belt-and-braces:
  // never prune a hostname this same deploy is registering.
  const activeRouteIds = new Set(
    routeState.publicEndpoints
      .map((endpoint) => endpoint.id)
      .filter((id): id is string => !!id),
  );
  const plannedHostnames = new Set(plannedDomains.map((domain) => domain.hostname.toLowerCase()));
  const obsoleteProjectDomains = activeRouteIds.size > 0
    ? projectDomains.filter(
        (domain) =>
          !domain.serviceId &&
          // Never sweep a user-connected custom domain (may be portless / not a
          // build endpoint) — only free/generated routes are eligible.
          domain.domainType !== "custom" &&
          !activeRouteIds.has(domain.id) &&
          !plannedHostnames.has(domain.hostname.toLowerCase()),
      )
    : [];

  // Persist a domain record for each planned route. Track the ones we
  // CREATE here (vs pre-existing rows) so they can be rolled back if the
  // deploy fails — otherwise a failed deploy leaves orphan domain rows
  // that resurface as routes on the next deploy.
  const createdDomainIds: string[] = [];
  const domainClaimWarnings: string[] = [];
  // Only domains we could CLAIM get routed. A hostname owned by another project
  // (ConflictError) is skipped entirely — not just un-claimed but NOT routed in
  // nginx either, or we'd hijack the other project's route. Domains are optional,
  // so a conflict never fails the deploy; it's flagged action-required instead.
  const routableDomains: typeof plannedDomains = [];
  for (const route of plannedDomains) {
    try {
      const created = await ensureRouteDomainRecord({
        projectId: project.id,
        route,
        domainByHostname,
      });
      if (created && !projectDomains.some((d) => d.id === created.id)) {
        createdDomainIds.push(created.id);
        logger.log(`Created domain record for "${route.hostname}".\n`);
      }
      routableDomains.push(route);
    } catch (err) {
      const message = safeErrorMessage(err);
      logger.log(`Skipping domain "${route.hostname}" (not routed — ${message}).\n`, "warn");
      domainClaimWarnings.push(`${route.hostname}: ${message}`);
    }
  }

  // Overlap-capable = the new deployment can run alongside the old one (docker
  // unique-name + random host port; cloud isolated workspace). Bare binds a
  // fixed port and static is file-backed → stop-first. Drives the cutover order
  // AND the snapshot-artifact gate below.
  // Zero-downtime overlap (run new + old together, then swap) needs each to bind
  // its own host port. A PINNED loopback port can't be double-bound, so
  // loopback-port docker deploys stop-then-start (brief blip, like bare).
  // container-ip keeps overlap.
  const canOverlap = serve.canOverlap;

  // Runtime deploy environment (preflight + activate + deactivate + resolvers).
  const deployEnv = buildDeployEnvironment(phase, {
    serve,
    previousRuntime,
    plannedDomains,
    readinessGate,
    onReadinessWarning: (detail) => readinessWarnings.push(detail),
  });

  const deploySsl = plannedDomains.some((domain) => domain.provisionSsl)
    ? createTrackedSslProvider(ssl, domainByHostname, (m) => logger.log(`${m}\n`))
    : ssl;

  // (Pre-deploy backups now fire once in executeBuildAndDeploy, covering all
  // deploy modes — see the firePreDeployBackups call before the compose branch.)

  // Reap leftover containers from a previous MULTI-SERVICE / monorepo
  // deployment when this deploy collapses to single-app mode. runDeployPipeline
  // only deactivates prevDep.containerId — which in compose mode is just the
  // old primary service's container (or the literal "compose" sentinel, not a
  // real container) — so the remaining per-service containers
  // (openship-{slug}-{service}) have no owner in the single-app path and would
  // otherwise orphan. Skip the one runDeployPipeline already handles and the
  // sentinel. Best-effort; never blocks the deploy.
  if (prevDep) {
    const prevServiceDeps = await repos.service
      .listByDeployment(prevDep.id)
      .catch(() => []);
    for (const sd of prevServiceDeps) {
      if (!sd.containerId || sd.containerId === "compose" || sd.containerId === prevDep.containerId) {
        continue;
      }
      try {
        await previousRuntime.destroy(sd.containerId);
        logger.log(`Stopped leftover service container (${sd.containerId.slice(0, 12)}).\n`);
      } catch (err) {
        logger.log(
          `Warning: failed to stop leftover service container: ${safeErrorMessage(err)}\n`,
          "warn",
        );
      }
    }
  }

  // R1 gate: when the runtime can overlap two versions AND this project keeps
  // artifacts, leave stopping the old one to archivePreviousDeployment — it keeps
  // serving until then (still zero-downtime) and gets stop-and-RETAIN rather than
  // a plain stop. Otherwise the pipeline stops it itself; bare (non-overlap)
  // always stops first. previousContainerId stays accurate either way; the flag
  // only controls WHO deactivates.
  //
  // Reads the project's LIVE retention preference, not the frozen
  // `deployment.rollback_strategy` — that column is history only, and keying
  // behaviour off it is what made a retention change apply to nothing that
  // already existed.
  const deactivateOldInPipeline = !(canOverlap && shouldRetainArtifact(project));

  // Sanitized rather than passed through: this reaches generated nginx config, and
  // the row can also carry a value seeded from a repo config, not just the API.
  const proxySettings = sanitizeProxySettings(project.routingConfig?.proxy);

  const deployResult = await runDeployPipeline(
    deployEnv,
    {
      config: deployConfig,
      previousContainerId: prevDep?.containerId ?? undefined,
      deactivatePrevious: deactivateOldInPipeline,
      domains: toRoutedDomainInputs(routableDomains),
      routing,
      ssl: deploySsl,
      routeOptions: {
        ...(project.webhookDomain
          ? { webhookDomain: project.webhookDomain, webhookProxy: webhookProxyTarget }
          : {}),
        ...(proxySettings ? { proxy: proxySettings } : {}),
      },
      promptUser: (prompt) => sessionManager.promptUser(dep.id, prompt),
    },
    logger,
  );

  if (deployResult.status === "failed") {
    // Reap the container this deploy STARTED if it failed during/after routing.
    // activeDeploymentId only advances on SUCCESS, so a started-but-failed
    // container is never any future deploy's prevDep and the 1-deep
    // prev-deactivation can never reach it — that's exactly how containers
    // piled up (3 for one project). Destroy it via the current runtime now.
    // Static deploys have no container. Best-effort + idempotent.
    if (deployResult.containerId && !isStaticFileServe) {
      await runtime.destroy(deployResult.containerId).catch((err) =>
        logger.log(
          `Warning: failed to clean up container after deploy failure: ${safeErrorMessage(err)}\n`,
          "warn",
        ),
      );
    }
    // Roll back the domain rows this deploy created — it didn't take, so
    // its routes must not linger (they'd resurface as planned routes next
    // deploy). Best-effort; pre-existing rows are left untouched.
    for (const id of createdDomainIds) {
      await repos.domain.remove(id).catch((err) =>
        logger.log(`Warning: failed to roll back domain record: ${safeErrorMessage(err)}\n`, "warn"),
      );
    }
    await onFailure(ctx, deployResult.error, buildResult.durationMs, {
      errorCode: deployResult.errorCode,
      errorDetails: deployResult.errorDetails,
    });
    return;
  }

  const postSync = await runPostDeploySync({
    plannedDomains,
    obsoleteProjectDomains,
    routing,
    usesManagedRouting,
    organizationId: dep.organizationId,
    serverId: snapshot.serverId,
    // prevDep is intentionally NOT passed to runPostDeploySync anymore —
    // the RollbackOrchestrator below owns prev-artifact lifecycle now.
    // Keeping runPostDeploySync for managed-routing + obsolete-domain
    // cleanup only.
    logger,
  });

  // Advisory port check — confirm the app is actually listening on its exposed
  // port(s) from INSIDE the instance. Runs after the deploy is live and never
  // throws (auditPorts is fully guarded), so it can't fail or delay-revert the
  // deploy; the result is pure metadata the dashboard uses to offer a "wrong
  // port?" fix. Exposed ports = the same publicEndpoints→port set the firewall
  // step uses. Static self-hosted has no listening process to probe.
  const auditedPorts = Array.from(
    new Set(
      (deployConfig.publicEndpoints && deployConfig.publicEndpoints.length > 0
        ? deployConfig.publicEndpoints
        : [{ port: deployConfig.port }])
        .map((endpoint) => endpoint.port ?? deployConfig.port)
        .filter((port): port is number => Number.isFinite(port)),
    ),
  );
  const portCheck =
    isStaticFileServe || !deployResult.containerId
      ? []
      : await auditPorts(runtime, deployResult.containerId, auditedPorts, logger);

  // The file-side twin, for the case that HAS no port: a static site 404s when the
  // edge's `root` doesn't resolve to something servable, and until this ran the
  // static branch above just returned [] with nothing in its place — so the one
  // deploy shape whose only failure mode IS a 404 was the one shape we never
  // checked. Probed through `routing`, so it answers from where OpenResty looks
  // (a `root` present on the host but not bind-mounted into the edge container
  // reads as missing here — exactly the 404 a host-side probe can't see).
  const outputCheck =
    isStaticFileServe && deployResult.containerId
      ? await auditStaticOutput(
          { routing, runtime: staticServeRuntime, containerId: deployResult.containerId },
          staticOutputTargets(
            resolveStaticOutputPath(deployResult.containerId, staticServeOutputDir),
            routeState.publicEndpoints,
          ),
          logger,
        )
      : [];

  // `metaPatch` is spread into deployment.meta (persisted) and read back for the
  // SSE payload in onSuccess, so both live + refresh see the same result.
  const metaPatch: Record<string, unknown> = {};
  if (portCheck.length > 0) metaPatch.portCheck = portCheck;
  if (outputCheck.length > 0) metaPatch.outputCheck = outputCheck;
  // Persist WHERE this deploy serves from. It can't be recomputed later: the read
  // path sees runtimeMode "bare" (the serve identity) and would answer
  // `project.outputDirectory`, while a sandbox-built static actually serves the
  // release root. See DeploymentMeta.staticServeOutputDir.
  if (isStaticFileServe) metaPatch.staticServeOutputDir = staticServeOutputDir;
  // Surface a free-domain edge-sync failure so the deploy doesn't read as cleanly
  // green with a dead .opsh.io URL. `edgeUnsynced` is the structured signal the
  // project status reads to flag "Action Required" + offer Retry routing;
  // `deployWarning` is the human message (both cleared when routing later syncs).
  if (postSync.warningMessage) {
    metaPatch.deployWarning = postSync.warningMessage;
    metaPatch.edgeUnsynced = true;
  }
  // Per-domain route-registration failures are best-effort in the pipeline
  // (domains are optional; the container is up + healthy). Fold them into the
  // SAME "Action Required" signal so an unrouted domain shows a routing warning
  // + the Domains-tab dot instead of failing an otherwise-good deploy. Cleared
  // by Retry routing / the next clean deploy.
  const routeIssues = [...domainClaimWarnings, ...(deployResult.routeWarnings ?? [])];
  if (routeIssues.length) {
    const msg = routeIssuesWarning(routeIssues);
    metaPatch.deployWarning = metaPatch.deployWarning ? `${metaPatch.deployWarning} · ${msg}` : msg;
    metaPatch.edgeUnsynced = true;
  }

  // An opted-in readiness check that failed with onFailure "warn": the deploy is
  // live, and this says what didn't answer. Kept as its OWN key rather than folded
  // into `deployWarning`, because any deployWarning makes the project read
  // `routingUnsynced` and offer "Retry routing" — the wrong fix to suggest for an
  // app that didn't answer on its port.
  if (readinessWarnings.length > 0) {
    metaPatch.readinessWarning = readinessWarnings.join(" · ");
  }

  // The warning belongs in the TRACE, not only on the SSE meta. It used to reach
  // the terminal solely because the dashboard wrote it client-side, so it was
  // absent from the persisted log — invisible on replay, in history, and to the
  // CLI. Emitting it here (matching the compose path's wording) makes the server
  // the single writer for every warning, so the client never has to add one.
  const deployWarnings = [metaPatch.deployWarning, metaPatch.readinessWarning].filter(
    (warning): warning is string => typeof warning === "string" && warning.length > 0,
  );
  const warningMessage = deployWarnings.join(" · ");
  if (warningMessage) {
    logger.log(`Deployment completed with warnings: ${warningMessage}\n`, "warn");
  }

  await onSuccess(ctx, {
    containerId: deployResult.containerId!,
    url: deployResult.url,
    durationMs: buildResult.durationMs ?? 0,
    ...(warningMessage ? { warningMessage } : {}),
    ...(Object.keys(metaPatch).length > 0 ? { metaPatch } : {}),
  });

  // FINAL STEP (desktop-only, best-effort): mirror this project onto the
  // server's .openship/manifest.json so a fresh orchestrator can re-adopt it.
  // Self-gated inside — a no-op for VPS/self-hosted and non-server targets.
  await syncProjectToServerManifest({
    baseTarget: phase.baseTarget,
    effectiveTarget: phase.effectiveTarget,
    serverId: phase.serverId,
    executor: phase.targetExecutor,
    project,
    deployment: dep,
    containerId: deployResult.containerId!,
    log: (msg) => logger.log(`${msg}\n`),
  });

  await archivePreviousDeployment(dep, project, logger);
}

/** After a successful deploy: managed-edge sync + prune obsolete
 *  domains/routes. Previous-deployment artifact lifecycle has moved
 *  to the RollbackOrchestrator (rollback/rollback-orchestrator.ts). */
async function runPostDeploySync(opts: {
  plannedDomains: ReturnType<typeof buildProjectRouteDomains>;
  obsoleteProjectDomains: Domain[];
  routing: Awaited<ReturnType<typeof platform>>["routing"];
  usesManagedRouting: boolean;
  organizationId: string;
  serverId?: string;
  logger: BuildLogger;
}): Promise<{ warningMessage?: string }> {
  const {
    plannedDomains, obsoleteProjectDomains, routing, usesManagedRouting,
    organizationId, serverId, logger,
  } = opts;

  // Collect free-domain edge-sync failures so a self-hosted + free-.opsh.io
  // deploy that comes up locally but whose cloud edge route didn't wire is
  // surfaced as a deployment warning — not just a buried log line that leaves
  // the operator with a green deploy and a dead URL.
  // Best-effort: this only wires the free .opsh.io URL through cloud edge.
  // Containers are up and custom domains route locally, so a cloud failure
  // (403, slug taken, unreachable) must not fail the deploy. Shared with the
  // standalone "retry routing" action via syncManagedEdgeRoutes.
  const edgeFailures: string[] = [];

  if (usesManagedRouting) {
    const managedTargets = plannedDomains
      .filter((d) => d.isCloud && d.managedSubdomain)
      .map((d) => ({ hostname: d.hostname, subdomain: d.managedSubdomain! }));
    const { failures } = await syncManagedEdgeRoutes(managedTargets, {
      organizationId,
      serverId,
      onLog: (msg, level) => logger.log(msg, level),
    });
    edgeFailures.push(...failures);
  }

  for (const domain of obsoleteProjectDomains) {
    if (routing) {
      await routing.removeRoute(domain.hostname).catch((err) => {
        const message = safeErrorMessage(err);
        logger.log(`Warning: failed to remove stale route ${domain.hostname}: ${message}\n`, "warn");
      });
    }

    await repos.domain.remove(domain.id).catch((err) => {
      const message = safeErrorMessage(err);
      logger.log(`Warning: failed to remove stale domain record ${domain.hostname}: ${message}\n`, "warn");
    });
  }

  // Previous-image GC moved to the RollbackOrchestrator. It archives
  // the prev image (not destroys it) so rollback stays possible, and
  // prunes beyond rollbackWindow + skips pinned.

  if (edgeFailures.length === 0) return {};
  return { warningMessage: edgeUnsyncedWarning(edgeFailures, "redeploy to retry") };
}
