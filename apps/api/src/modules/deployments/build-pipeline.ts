/** Build → deploy execution engine. Extracted from build.service.ts — private pipeline: kickoffBuild fires executeBuildAndDeploy, which runs the build, deploy phases, and post-deploy sync. */

import { posix as pathPosix } from "node:path";
import { repos, type Project, type Deployment, type Domain } from "@repo/db";
import {
  BUILD_ENV_VARS,
  safeErrorMessage,
} from "@repo/core";
import type {
  BuildResult,
  CommandExecutor,
  DeployConfig,
  DeployEnvironment,
  LogEntry,
  ResourceConfig,
} from "@repo/adapters";
import {
  BareRuntime,
  BuildLogger,
  CloudRuntime,
  DEFAULT_BUILD_RESOURCE_CONFIG,
  ensurePortAvailable,
  allocateHostPort,
  createHostExecutor,
  runDeployPipeline,
  isMultiServiceRuntime,
  waitForReady,
  ensureEdge,
} from "@repo/adapters";
import { platform } from "../../lib/controller-helpers";
import { resolveUpstreamUrl, resolveRouteStrategy } from "../../lib/upstream-url";
import { webhookProxyTarget } from "../../config";
import { resolveDeploymentRuntime, resolveDeploymentPlatform } from "../../lib/deployment-runtime";
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
import { withDefaults } from "../../lib/resources";
import { resolveBuildGitToken } from "../github/clone-auth";
import { openDeployRelay } from "../../lib/git-forwarding";
import { resolveOrgOwner } from "../../lib/org-actor";
import {
  preCreateServiceDeployments,
  emitServiceCheckRun,
  emitInitialServiceChecks,
  rollupDeploymentStatus,
} from "./service-checks";
import { firePreDeployBackups } from "../backups/triggers/pre-deploy";
import { buildBackgroundContext } from "../../lib/request-context";
import * as sessionManager from "./session-manager";
import { onFailure, onSuccess, onCancelled, setDeploymentStatus, type LifecycleContext } from "./deployment-lifecycle";
import { auditPorts } from "./port-audit.service";
import { createBuildConfig } from "./build-config";
import { resolveClonePlan } from "./clone-plan";
import { collapseTerminalLogs } from "./terminal-logs";
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
    if (["failed", "ready", "cancelled"].includes(dep.status)) {
      // Inner onFailure already ran (or the deploy somehow succeeded). Nothing to do.
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
 * Hand the previous-active deployment to the rollback orchestrator: it
 * archives the prior artifact (so snapshot rollback stays possible), sets
 * artifact_retained_at on both rows, and prunes beyond the rollback
 * window. Git-strategy deploys SKIP this — rollback re-clones at
 * commit_sha_before, so there's no artifact to archive. Best-effort: the
 * new deployment is already live, so a failure here only affects rollback
 * eligibility, never the deploy outcome.
 */
async function archivePreviousDeployment(
  dep: Deployment,
  project: Project,
  logger: BuildLogger,
): Promise<void> {
  if (dep.rollbackStrategy === "git") {
    logger.log(
      "Skipping snapshot/artifact archive — rollback strategy is 'git' (rollback re-clones at commit_sha_before).",
    );
    return;
  }
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
      `Warning: failed to archive previous deployment for rollback: ${safeErrorMessage(err)}\n`,
      "warn",
    );
  }
}

/**
 * Finalize a compose (multi-service) deploy after executeComposePipeline:
 * roll the per-service results up into the project-level status (override
 * `ready` with `partial_failure` when some services failed), emit
 * per-service GitHub Checks, then archive the previous deployment.
 * Mirrors the single-app finalize tail in executeServerDeploy.
 */
async function finalizeComposeDeploy(opts: {
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

  // Don't archive the previous deployment while THIS one is still `reconciling`
  // (connection lost, outcome unverified) — archiving now could prematurely
  // retire a still-live predecessor before we know the new deploy succeeded.
  // Reconciliation settles the status; archival waits for a confirmed ready.
  const settled = await repos.deployment.findById(dep.id).catch(() => null);
  if (settled?.status !== "reconciling") {
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

  /** Collapsed logs for DB persistence - resolves \r overwrites to final state. */
  const persistLogs = () => collapseTerminalLogs(logs);

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
    // Services are containers → they need the Docker runtime. If this deploy
    // will run the service pipeline (targeted serviceIds, or the project has
    // service rows) but the app is configured "bare", force Docker for it — the
    // bare runtime literally can't run a service container (it would fail with
    // "services not supported on the bare runtime"). Only the targeted
    // service(s) deploy here; the app's own bare deploy is untouched. Compose
    // projects are already Docker, so the `=== "bare"` guard skips them; a plain
    // bare app deploy with no services never flips (useServicePipeline=false).
    // Guard on `!== "docker"` (not `=== "bare"`) so an UNSET runtime (null/
    // undefined — e.g. a template/app project created without a runtime_mode)
    // also flips; otherwise it resolves to bare and the service deploy dies with
    // "services are not supported on the bare runtime". Already-Docker projects
    // skip the check.
    if (snapshot.runtimeMode !== "docker") {
      const willRunServices = (await resolveServicePipelineMode(project, snapshot)).useServicePipeline;
      if (willRunServices) {
        logger.log("→ Services require the Docker runtime — running this service deploy on Docker.\n");
        snapshot.runtimeMode = "docker";
      }
    }

    const resolved = await resolveDeploymentPlatform(snapshot, {
      organizationId: dep.organizationId,
      basePlatform: plat,
    });

    runtime = resolved.platform.runtime;
    routing = resolved.platform.routing;
    ssl = resolved.platform.ssl;
    system = resolved.platform.system;
    ctx.runtime = runtime;

    const usesManagedRouting = resolved.usesManagedRouting;
    const targetExecutor: CommandExecutor | null = resolved.platform.executor;

    // Surface the resolved deploy path so the operator can SEE where it lands —
    // in particular the self-hosted sandbox-vs-direct runtime, the choice that
    // could silently flip to "direct" before runtimeMode was persisted.
    logger.log(
      `→ Deploy target: ${resolved.effectiveTarget}` +
        (resolved.serverId ? ` (server ${resolved.serverId.slice(0, 8)})` : "") +
        ` · runtime: ${
          resolved.runtimeMode === "docker"
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

    const prodResources = withDefaults(snapshot.resources);
    const buildResources = withDefaults(snapshot.buildResources, DEFAULT_BUILD_RESOURCE_CONFIG);

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
    const useServicePipeline = (await resolveServicePipelineMode(project, snapshot)).useServicePipeline;

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
    const enabledSvcs = (snapshot.composeServices ?? []).filter((s) => s.enabled !== false);
    const needsGitSource =
      enabledSvcs.length > 0
        ? enabledSvcs.some((s) => s.kind === "monorepo" || !!s.build || !!s.dockerfile)
        : snapshot.hasBuild !== false;

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
        })
      : {};

    // Clone-on-server needs a SHIPPABLE credential that can travel to the build
    // host: the desktop relay (gitCred.relay) or an App/PAT token (gitCred.token
    // WITHOUT apiHostFallback). An apiHostFallback token is a LOCAL credential for
    // cloning on the orchestrator — NOT shippable — so it does not qualify. When
    // no shippable credential exists, fall back to cloning on the API host and
    // transferring the context — warn, never hard-fail. (The BARE runtime always
    // clones on the target and is gated by preflight separately, so this fallback
    // only changes DOCKER behavior.)
    const cloneCredentialAvailable =
      gitCred.relay === true ||
      !!gitCred.ssh ||
      (!!gitCred.token && !gitCred.apiHostFallback);
    const effectiveCloneOnServer =
      cloneOnServer && (runtime.name === "bare" || cloneCredentialAvailable);
    if (cloneOnServer && runtime.name !== "bare" && !cloneCredentialAvailable) {
      logger.log(
        "Clone-on-server was requested, but no git credential can reach the build host (no relay, no token). Falling back to cloning on the API host and transferring the build context.",
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
        await repos.service.syncFromCompose(project.id, composeOnly);
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

    // Desktop git credential relay (fallback): the operator opted this server
    // into forwarding and there's no App/PAT token. Open the relay (reverse
    // tunnel + remote helper) right before the build so the clone fetches the
    // gh identity on demand — nothing persisted on the build host — and tear it
    // down in `finally` the moment the build (and its clone) finishes.
    const deployRelay = await openRelayIfNeeded();
    if (deployRelay) {
      buildConfig.gitCredentialHelperPath = deployRelay.scriptPath;
    }

    let buildResult: Awaited<ReturnType<typeof runtime.build>>;
    try {
      buildResult = await runtime.build(buildConfig, logger);
    } finally {
      // Reverse tunnel + remote helper script torn down regardless of outcome —
      // the credential is reachable only for the build's duration.
      if (deployRelay) await deployRelay.close().catch(() => {});
    }
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
    };

    if (!snapshot.hasServer && runtime instanceof CloudRuntime) {
      await executeStaticEdgeDeploy(phase, runtime);
    } else {
      await executeServerDeploy(phase);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    logger.log(`Error: ${message}`, "error");
    await onFailure(ctx, message);
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
 * Build the runtime DeployEnvironment (preflight + activate + deactivate +
 * route/url resolvers) for a server deploy. Static-self-hosted (bare,
 * file-backed) and containerized server deploys share one shape but differ
 * in a handful of closures — kept together here so executeServerDeploy
 * reads as a straight sequence.
 */
function buildDeployEnvironment(
  phase: DeployPhaseInputs,
  deps: {
    staticBareRuntime: BareRuntime | null;
    isStaticSelfHosted: boolean;
    previousRuntime: DeployPhaseInputs["runtime"];
    plannedDomains: ReturnType<typeof buildProjectRouteDomains>;
    canOverlap: boolean;
  },
): DeployEnvironment {
  const { runtime, system, targetExecutor, routeState, snapshot, logger, effectiveTarget } = phase;
  const { staticBareRuntime, isStaticSelfHosted, previousRuntime, plannedDomains, canOverlap } = deps;

  return {
    canOverlap,
    // Post-activate readiness gate. Only wired for LOCAL targets: the app runs
    // on this host, so a refused/timed-out probe genuinely means it failed to
    // come up (throwing here auto-reverts to the previous deployment). Remote
    // (SSH server) and cloud targets aren't reachable from the API process, so
    // we leave them unprobed rather than risk failing a healthy deploy. Static
    // self-hosted has no listening port. See deploy-pipeline.ts for the seam.
    healthCheck:
      isStaticSelfHosted || effectiveTarget !== "local"
        ? undefined
        : async (containerId: string, cfg) => {
            let host = "127.0.0.1";
            let port = cfg.port;
            if (runtime.name !== "bare") {
              // Container runtime: prefer the published host port; fall back to
              // the container's bridge IP:port (reachable on the local daemon).
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
            logger.log(`Health check: waiting for the app to accept connections on port ${cfg.port}…\n`);
            const ready = await waitForReady(host, port, { timeoutMs: 45_000, intervalMs: 1_000 });
            if (!ready) {
              throw new Error(
                `Health check failed: the app never accepted a connection on port ${cfg.port} within 45s — it likely crashed on startup (check the runtime logs).`,
              );
            }
            logger.log(`Health check passed: the app is accepting connections.\n`);
          },
    reactivatePrevious:
      previousRuntime.name === "bare"
        ? (id: string) => (id.includes("/") ? Promise.resolve() : previousRuntime.start(id))
        : undefined,
    preflight: targetExecutor
      ? async (cfg, promptUser) => {
          if (system) {
            const systemLog = (entry: { message: string; level: "info" | "warn" | "error" }) => {
              logger.log(`${entry.message}\n`, entry.level);
            };

            if (!isStaticSelfHosted) {
              await system.ensureFeature("deploy", systemLog);
            }
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
                  (p) => system.ensureFeature("routing", systemLog, { promptUser: p }),
                  { promptUser, onLog: systemLog },
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
              if (plannedDomains.some((d) => d.provisionSsl)) {
                await system.ensureFeature("ssl", systemLog);
              }
            } catch (err) {
              logger.log(
                `Edge/routing setup failed — deploy continues; the app runs on its port and routing is retried later: ${safeErrorMessage(err)}\n`,
                "warn",
              );
            }
          }

          if (!isStaticSelfHosted) {
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
              await ensurePortAvailable(targetExecutor, port, logger, promptUser);
            }
          }
        }
      : undefined,
    activate: async (cfg, onLog) => {
      const r = isStaticSelfHosted
        ? await staticBareRuntime!.deployStatic({
            ...cfg,
            outputDirectory: cfg.outputDirectory ?? snapshot.outputDirectory,
          })
        : await runtime.deploy(cfg, onLog);
      if (!r.containerId) throw new Error("Deploy produced no container");
      return { containerId: r.containerId, url: r.url };
    },
    deactivate: (id) =>
      previousRuntime.name === "bare" && !id.includes("/")
        ? previousRuntime.stop(id)
        : previousRuntime.destroy(id),
    resolveRoute: isStaticSelfHosted
      ? async (id, cfg) => ({
          staticRoot: staticBareRuntime!.resolveStaticRoot(
            id,
            cfg.outputDirectory ?? snapshot.outputDirectory,
          ),
        })
      : undefined,
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

  // Static sites are always served directly from the web server (OpenResty)
  // via file-backed routes - Docker is only for server apps.
  const staticBareRuntime =
    !snapshot.hasServer && runtime instanceof BareRuntime ? runtime : null;
  const isStaticSelfHosted = staticBareRuntime !== null;

  // loopback-port routing pins a stable LOOPBACK host port for docker so the
  // edge target is predictable and survives container restarts. Reused across
  // redeploys (persisted on the project); allocated once on first deploy from a
  // live-probed free port. Bare owns 127.0.0.1:<port> and needs none.
  const routeStrategy = resolveRouteStrategy(project.routeStrategy);
  let pinnedHostPort: number | undefined = project.hostPort ?? undefined;
  if (routeStrategy === "loopback-port" && !isStaticSelfHosted && runtime.name !== "bare") {
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
      pinnedHostPort = await allocateHostPort(phase.targetExecutor ?? createHostExecutor(), { avoid });
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
    restartPolicy: isStaticSelfHosted ? "no" : "always",
    runtimeName: project.slug ?? project.id,
    publicEndpoints: routeState.publicEndpoints,
    outputDirectory: snapshot.outputDirectory,
    productionPaths: snapshot.productionPaths.length ? snapshot.productionPaths : undefined,
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
  const canOverlap =
    !isStaticSelfHosted && runtime.name !== "bare" && routeStrategy !== "loopback-port";

  // Runtime deploy environment (preflight + activate + deactivate + resolvers).
  const deployEnv = buildDeployEnvironment(phase, {
    staticBareRuntime,
    isStaticSelfHosted,
    previousRuntime,
    plannedDomains,
    canOverlap,
  });

  const deploySsl = plannedDomains.some((domain) => domain.provisionSsl)
    ? createTrackedSslProvider(ssl, domainByHostname)
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

  // R1 gate: in overlap mode with SNAPSHOT strategy, let archivePreviousDeployment
  // stop+RETAIN the old artifact (for rollback) instead of the pipeline stopping
  // it — the old one keeps serving until the archive step (still zero-downtime).
  // git strategy skips archive, so the pipeline stops the old one itself; bare
  // (non-overlap) always stops first. previousContainerId stays accurate; the
  // flag only controls whether the pipeline deactivates.
  const deactivateOldInPipeline = !(canOverlap && dep.rollbackStrategy === "snapshot");

  const deployResult = await runDeployPipeline(
    deployEnv,
    {
      config: deployConfig,
      previousContainerId: prevDep?.containerId ?? undefined,
      deactivatePrevious: deactivateOldInPipeline,
      domains: toRoutedDomainInputs(routableDomains),
      routing,
      ssl: deploySsl,
      routeOptions: project.webhookDomain
        ? {
            webhookDomain: project.webhookDomain,
            webhookProxy: webhookProxyTarget,
          }
        : undefined,
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
    if (deployResult.containerId && !isStaticSelfHosted) {
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
    isStaticSelfHosted || !deployResult.containerId
      ? []
      : await auditPorts(runtime, deployResult.containerId, auditedPorts, logger);

  // `metaPatch` is spread into deployment.meta (persisted) and read back for the
  // SSE payload in onSuccess, so both live + refresh see the same result.
  const metaPatch: Record<string, unknown> = {};
  if (portCheck.length > 0) metaPatch.portCheck = portCheck;
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
    const msg =
      `Some domains aren't routed yet — the app is deployed and running; fix DNS/routing and ` +
      `Retry from the Domains tab: ${routeIssues.join("; ")}`;
    metaPatch.deployWarning = metaPatch.deployWarning ? `${metaPatch.deployWarning} · ${msg}` : msg;
    metaPatch.edgeUnsynced = true;
  }

  await onSuccess(ctx, {
    containerId: deployResult.containerId!,
    url: deployResult.url,
    durationMs: buildResult.durationMs ?? 0,
    ...(typeof metaPatch.deployWarning === "string" ? { warningMessage: metaPatch.deployWarning } : {}),
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
