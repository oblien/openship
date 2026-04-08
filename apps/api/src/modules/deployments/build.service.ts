/**
 * Build service — build session lifecycle + build→deploy pipeline.
 */

import { repos, type Project, type Deployment } from "@repo/db";
import { NotFoundError, ForbiddenError, DeployError, BUILD_ENV_VARS, SYSTEM, STACKS, getRuntimeImage, type StackId, type DeployTarget, type BuildStrategy } from "@repo/core";
import type { BuildConfig, CommandExecutor, DeployConfig, DeployEnvironment, LogEntry, ResourceConfig } from "@repo/adapters";
import { BareRuntime, BuildLogger, CloudRuntime, DEFAULT_BUILD_RESOURCE_CONFIG, DockerRuntime, ensurePortAvailable, runDeployPipeline, createPlatform, isMultiServiceRuntime } from "@repo/adapters";
import { platform } from "../../lib/controller-helpers";
import { env } from "../../config";
import { resolveDeploymentRuntime, resolveDeploymentPlatform } from "../../lib/deployment-runtime";
import { ensureManagedEdgeProxy } from "../../lib/managed-edge-proxy";
import { encrypt, decrypt } from "../../lib/encryption";
import { buildProjectRouteDomains, createTrackedSslProvider, ensureRouteDomainRecord, toRoutedDomainInputs } from "../../lib/routing-domains";
import { withDefaults } from "../../lib/resources";
import { resolveToken } from "../github/github.auth";
import { pruneRetainedBareReleases } from "./release-retention";
import * as sessionManager from "./session-manager";
import { onFailure, onSuccess, onCancelled, type LifecycleContext } from "./deployment-lifecycle";
import { runPreflightChecks } from "./preflight";
import { createBuildConfig } from "./build-config";
import { isComposeProject, executeComposePipeline } from "./compose";
import * as settingsService from "../settings/settings.service";
import type { ComposeService } from "../../lib/compose-parser";

// ─── Terminal output collapsing ──────────────────────────────────────────────

/**
 * Collapse raw log entries into their final terminal-rendered state.
 *
 * During live streaming, xterm handles \r (carriage return) to overwrite lines
 * in-place (e.g., git progress "Counting objects:  42%\r...100%").
 * When persisting to DB we don't want all intermediate lines — just the final
 * rendered result, as a terminal would show.
 *
 * Step events (entries with `step` field) pass through unchanged — they're
 * structured metadata for the stepper UI, not terminal output.
 */
function collapseTerminalLogs(entries: LogEntry[]): LogEntry[] {
  const result: LogEntry[] = [];
  // Virtual line buffer — simulates one terminal line
  let currentLine = "";
  let currentLevel: LogEntry["level"] = "info";
  let currentTimestamp = "";

  const flushLine = () => {
    const trimmed = currentLine.trimEnd();
    if (trimmed) {
      result.push({ timestamp: currentTimestamp, message: trimmed, level: currentLevel });
    }
    currentLine = "";
  };

  for (const entry of entries) {
    // Step events pass through as-is
    if (entry.step) {
      flushLine();
      result.push(entry);
      continue;
    }

    const text = entry.message;
    currentLevel = entry.level;
    currentTimestamp = entry.timestamp;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === "\r") {
        // Check for \r\n (treat as plain newline)
        if (i + 1 < text.length && text[i + 1] === "\n") {
          flushLine();
          i++; // skip the \n
        } else {
          // Bare \r — overwrite: reset current line (don't flush)
          currentLine = "";
        }
      } else if (ch === "\n") {
        flushLine();
      } else {
        currentLine += ch;
      }
    }
  }

  // Flush any remaining content
  flushLine();
  return result;
}

function buildScopedEnvVars(
  envVars: Record<string, string>,
  opts?: { forceProductionNodeEnv?: boolean },
): {
  envVars: Record<string, string>;
  ignoredNodeEnv?: string;
} {
  const scoped = { ...envVars };
  let ignoredNodeEnv: string | undefined;

  if (opts?.forceProductionNodeEnv) {
    ignoredNodeEnv = scoped.NODE_ENV;
    delete scoped.NODE_ENV;
  }

  return {
    envVars: {
      ...BUILD_ENV_VARS,
      ...scoped,
      ...(opts?.forceProductionNodeEnv ? { NODE_ENV: "production" } : {}),
    },
    ignoredNodeEnv,
  };
}

// ─── Types ───────────────────────────────────────────────────────────────────

/** Config snapshot stored in deployment.meta — self-contained build+deploy config. */
export interface DeploymentConfigSnapshot {
  repoUrl: string;
  branch: string;
  framework: string;
  buildImage: string;
  runtimeImage: string;
  packageManager: string;
  installCommand: string;
  buildCommand: string;
  outputDirectory: string;
  productionPaths: string[];
  rootDirectory: string;
  port: number;
  startCommand: string;
  resources: ResourceConfig | null;
  buildResources: ResourceConfig | null;
  /** Whether the project needs a running server (false = static, deploy via Pages) */
  hasServer: boolean;
  /** Whether the project needs a build step (false = deploy source directly) */
  hasBuild: boolean;
  /** Custom domain from deploy input (e.g. "app.example.com") */
  customDomain?: string;
  /** Absolute path to a local project directory (alternative to repoUrl) */
  localPath?: string;
  /** Build strategy: "server" (build in workspace) or "local" (build on host) */
  buildStrategy?: BuildStrategy;
  /** Deploy target: "local" (this machine), "server" (remote SSH), or "cloud" (Oblien) */
  deployTarget?: DeployTarget;
  /** Target server ID when deployTarget is "server" */
  serverId?: string;
  /** Runtime mode: "bare" (direct process) or "docker" (container-based) */
  runtimeMode?: "bare" | "docker";
  /** Parsed compose services captured at deploy request time. */
  composeServices?: ComposeService[];
  /** Summary of a compose deployment fan-out, when applicable. */
  composeDeployment?: {
    totalServices: number;
    successfulServices: number;
    failedServices: number;
    failedServiceNames: string[];
    warningMessage?: string;
  };
  previousActiveDeploymentId?: string;
}

export interface BuildAccessInput {
  projectId: string;
  branch?: string;
  environment?: string;
  envVars?: Record<string, string>;
  customDomain?: string;
  buildStrategy?: BuildStrategy;
  deployTarget?: DeployTarget;
  serverId?: string;
  runtimeMode?: "bare" | "docker";
  services?: ComposeService[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a config snapshot from the project — pure pass-through, no fallbacks.
 *  All values must be set by prepare / ensureProject before this is called. */
function buildConfigSnapshot(project: Project, branch?: string, customDomain?: string): DeploymentConfigSnapshot {
  const runtimeImage = resolveRuntimeImage(project);

  return {
    repoUrl: project.gitUrl ?? "",
    branch: branch || project.gitBranch || "main",
    framework: project.framework!,
    buildImage: project.buildImage!,
    runtimeImage,
    packageManager: project.packageManager!,
    installCommand: project.installCommand!,
    buildCommand: project.buildCommand!,
    outputDirectory: project.outputDirectory!,
    productionPaths: parseProductionPaths(project.productionPaths, project.framework),
    rootDirectory: project.rootDirectory || "",
    port: project.port!,
    startCommand: project.startCommand!,
    resources: (project.resources as ResourceConfig) || null,
    buildResources: (project.buildResources as ResourceConfig) || null,
    hasServer: project.hasServer ?? !!project.startCommand?.trim(),
    hasBuild: project.hasBuild ?? true,
    customDomain: customDomain || undefined,
    localPath: project.localPath || undefined,
  };
}

function resolveRuntimeImage(project: Project): string {
  const hasServer = project.hasServer ?? !!project.startCommand?.trim();
  const stackId = (project.framework && project.framework in STACKS
    ? project.framework
    : "unknown") as StackId;

  if (!hasServer) {
    return getRuntimeImage("static", project.packageManager ?? undefined);
  }

  return getRuntimeImage(stackId, project.packageManager ?? undefined);
}

/** Parse productionPaths from DB text (comma-separated) with STACKS fallback. */
function parseProductionPaths(raw: string | null | undefined, framework: string | null | undefined): string[] {
  if (raw) return raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (framework && framework in STACKS) {
    const paths = STACKS[framework as StackId] as import("@repo/core").StackDefinition;
    return paths.productionPaths ? [...paths.productionPaths] : [];
  }
  return [];
}

/** Encrypt a plaintext key-value map. Returns null if empty. */
function encryptEnvVars(envVars?: Record<string, string>): Record<string, string> | null {
  if (!envVars || Object.keys(envVars).length === 0) return null;
  const encrypted: Record<string, string> = {};
  for (const [k, v] of Object.entries(envVars)) {
    encrypted[k] = encrypt(v);
  }
  return encrypted;
}

/** Decrypt an encrypted env var map from deployment.envVars. */
function decryptEnvVars(encrypted: unknown): Record<string, string> {
  const map: Record<string, string> = {};
  if (!encrypted || typeof encrypted !== "object") return map;
  for (const [k, v] of Object.entries(encrypted as Record<string, string>)) {
    try { map[k] = decrypt(v); } catch { map[k] = v; }
  }
  return map;
}

// ─── Shared helpers ──────────────────────────────────────────────────────────

/** Load a deployment + its project, verifying the user owns it. */
async function loadDeploymentForUser(deploymentId: string, userId: string) {
  const dep = await repos.deployment.findById(deploymentId);
  if (!dep) throw new NotFoundError("Deployment", deploymentId);

  const project = await repos.project.findById(dep.projectId);
  if (!project || project.userId !== userId) {
    throw new NotFoundError("Deployment", deploymentId);
  }

  return { dep, project };
}

/** Throw if the project already has an in-progress deployment. */
async function checkNoActiveBuild(projectId: string) {
  const { rows } = await repos.deployment.listByProject(projectId, {
    page: 1,
    perPage: SYSTEM.DEPLOYMENTS.MAX_CONCURRENT_PER_PROJECT + 1,
  });
  const active = rows.find((d) =>
    ["queued", "building", "deploying"].includes(d.status),
  );
  if (active) {
    throw new ForbiddenError(
      `A deployment is already in progress (${active.id}). Cancel it first or wait for it to complete.`,
    );
  }
}

/**
 * Create a queued deployment + build session atomically.
 * If the build session insert fails, the deployment is cleaned up.
 */
async function createQueuedDeployment(opts: {
  projectId: string;
  userId: string;
  branch: string;
  environment: string;
  framework: string;
  meta: DeploymentConfigSnapshot;
  envVars: Record<string, string> | null;
  commitSha?: string;
}) {
  const dep = await repos.deployment.create({
    projectId: opts.projectId,
    userId: opts.userId,
    branch: opts.branch,
    commitSha: opts.commitSha,
    environment: opts.environment,
    framework: opts.framework,
    status: "queued",
    meta: opts.meta,
    envVars: opts.envVars,
  });

  try {
    await repos.deployment.createBuildSession({
      deploymentId: dep.id,
      projectId: opts.projectId,
      status: "queued",
    });
  } catch (err) {
    // Atomicity: clean up orphaned deployment
    await repos.deployment.deleteDeployment(dep.id).catch(() => {});
    throw err;
  }

  return dep;
}

// ─── SSE streaming (re-export) ───────────────────────────────────────────────

/** Subscribe to live build logs by deployment ID (dep_xxx). */
export { subscribe as subscribeToBuildSession } from "./session-manager";

// ─── Build access (create deployment with config snapshot) ───────────────────

/**
 * Create a deployment + build session for an existing project.
 * Snapshots project config into deployment.meta,
 * encrypts env vars into deployment.envVars.
 *
 * Project MUST exist before calling this.
 */

/** Resolve a pending pipeline prompt (e.g. port conflict). */
export async function respondToPrompt(
  deploymentId: string,
  userId: string,
  action: string,
): Promise<boolean> {
  await loadDeploymentForUser(deploymentId, userId);
  return sessionManager.respondToPrompt(deploymentId, action);
}

export async function requestBuildAccess(userId: string, input: BuildAccessInput) {
  const { projectId, branch, environment, envVars, customDomain, buildStrategy, deployTarget, serverId, runtimeMode, services } = input;

  const project = await repos.project.findById(projectId);
  if (!project || project.userId !== userId) {
    throw new NotFoundError("Project", projectId);
  }

  await checkNoActiveBuild(project.id);

  const snapshot = buildConfigSnapshot(project, branch, customDomain);
  if (services?.length) {
    snapshot.composeServices = services;
  }

  // Resolve effective build strategy via settings service
  snapshot.buildStrategy = await settingsService.resolveStrategy(
    userId,
    snapshot.framework,
    buildStrategy ?? snapshot.buildStrategy,
  );

  // Persist deploy target from the UI (desktop-only picker)
  if (deployTarget) {
    snapshot.deployTarget = deployTarget;
  }
  if (serverId) {
    snapshot.serverId = serverId;
  }
  if (runtimeMode) {
    snapshot.runtimeMode = runtimeMode;
  }

  // ── Preflight: validate config + domain before creating any resources ──
  const preflight = await runPreflightChecks(snapshot, {
    customDomain: snapshot.customDomain,
    slug: project.slug,
    userId,
    composeServices: snapshot.composeServices,
  });
  if (!preflight.ok) {
    const failures = preflight.checks
      .filter((c) => c.status === "fail")
      .map((c) => `${c.label}: ${c.message}`)
      .join("; ");
    throw new ForbiddenError(`Pre-deploy checks failed: ${failures}`);
  }
  const env = environment || "production";

  const dep = await createQueuedDeployment({
    projectId: project.id,
    userId,
    branch: snapshot.branch,
    environment: env,
    framework: snapshot.framework,
    meta: {
      ...snapshot,
      previousActiveDeploymentId: project.activeDeploymentId ?? undefined,
    },
    envVars: encryptEnvVars(envVars),
  });

  // Store env vars on project as "latest defaults"
  if (envVars && Object.keys(envVars).length > 0) {
    const vars = Object.entries(envVars).map(([key, value]) => ({
      key,
      value: encrypt(value),
      isSecret: false,
    }));
    await repos.project.bulkSetEnvVars(project.id, env, vars);
  }

  return {
    success: true,
    deployment_id: dep.id,
    project_id: project.id,
  };
}

// ─── Build session status ────────────────────────────────────────────────────

export async function getBuildSessionStatus(deploymentId: string, userId: string) {
  const { dep, project } = await loadDeploymentForUser(deploymentId, userId);

  const buildSessionRow = await repos.deployment.findBuildSessionByDeploymentId(deploymentId);

  const memSession = sessionManager.getSession(deploymentId);
  const isActive = memSession != null &&
    !["ready", "failed", "cancelled"].includes(memSession.status);

  const logEntries = isActive
    ? (memSession?.logs ?? (buildSessionRow?.logs as LogEntry[] | null) ?? [])
    : ((buildSessionRow?.logs as LogEntry[] | null) ?? memSession?.logs ?? []);
  // Filter out step-metadata entries — they drive the progress bar, not the terminal
  const terminalEntries = logEntries.filter((l) => !(l.step && l.stepStatus));
  const logsText = terminalEntries.map((l) => l.message).join("\n");
  const lastEventId = (() => {
    for (let index = logEntries.length - 1; index >= 0; index--) {
      const entry = logEntries[index];
      if (!(entry.step && entry.stepStatus)) {
        return index;
      }
    }
    return undefined;
  })();

  // In-memory session is real-time truth (updated every phase transition).
  // DB build-session row only moves queued → building → final, so it's stale during deploy.
  const effectiveStatus = memSession
    ? memSession.status
    : buildSessionRow
      ? buildSessionRow.status
      : dep.status;

  // Return config from deployment snapshot (self-contained)
  const snapshot = dep.meta as DeploymentConfigSnapshot | null;

  // Derive step progress from persisted log entries when no active session
  let currentStep = 0;
  let progress = 0;
  if (isActive) {
    // Truly active session — frontend gets live progress via SSE, don't override
    currentStep = undefined as unknown as number;
    progress = undefined as unknown as number;
  } else if (effectiveStatus === "ready") {
    currentStep = 4; // past deploy
    progress = 100;
  } else {
    // Scan persisted logs for step events to find where it got to
    const STEP_INDEX: Record<string, number> = { clone: 0, install: 1, build: 2, deploy: 3 };
    const STEP_PROGRESS: Record<string, number> = { clone: 5, install: 25, build: 50, deploy: 75 };
    for (const entry of logEntries) {
      if (entry.step && entry.step in STEP_INDEX) {
        const idx = STEP_INDEX[entry.step];
        if (idx >= currentStep) {
          currentStep = idx;
          progress = STEP_PROGRESS[entry.step];
          // If this step completed, advance progress beyond it
          if (entry.stepStatus === "completed") {
            progress = STEP_PROGRESS[entry.step] + 10;
          }
        }
      }
    }
    // For failed/cancelled, keep progress where it stopped
  }

  const projectType = isComposeProject(project)
    ? "services" as const
    : snapshot?.runtimeMode === "docker"
      ? "docker" as const
      : "app" as const;

  const composeData = projectType === "services"
    ? await Promise.all([
        repos.service.listByDeployment(deploymentId).catch(() => []),
        repos.service.listByProject(project.id).catch(() => []),
      ]).then(([deploymentServices, projectServices]) => ({
        composeDeployment: snapshot?.composeDeployment ?? null,
        serviceStatuses: deploymentServices.map((service) => ({
          serviceId: service.serviceId,
          status: service.status,
          containerId: service.containerId,
          hostPort: service.hostPort,
          ip: service.ip,
          imageRef: service.imageRef,
        })),
        services: projectServices
          .filter((service) => service.enabled)
          .map((service) => ({
            serviceId: service.id,
            serviceName: service.name,
            image: service.image,
            build: service.build,
          })),
      }))
    : {};

  return {
    success: true,
    deployment_id: dep.id,
    project_id: project.id,
    status: effectiveStatus,
    is_active: isActive,
    logs: logsText,
    lastEventId,
    config: {
      repo: project.gitRepo,
      owner: project.gitOwner,
      projectName: project.name,
      framework: snapshot?.framework || project.framework,
      branch: dep.branch ?? project.gitBranch,
      domain: "",
      buildCommand: snapshot?.buildCommand,
      outputDirectory: snapshot?.outputDirectory,
      installCommand: snapshot?.installCommand,
      startCommand: snapshot?.startCommand,
      productionPort: snapshot?.port ? String(snapshot.port) : undefined,
      rootDirectory: snapshot?.rootDirectory,
      hasServer: snapshot?.hasServer ?? !!snapshot?.startCommand?.trim(),
    },
    progress,
    currentStep,
    screenshots: [],
    buildDurationMs: buildSessionRow?.durationMs ?? null,
    buildStartedAt: buildSessionRow?.startedAt?.toISOString() ?? null,
    failureMessage: effectiveStatus === "failed" ? dep.errorMessage || "" : "",
    warningMessage: effectiveStatus === "ready"
      ? (snapshot?.composeDeployment?.warningMessage || "")
      : "",
    previousActiveDeploymentId: snapshot?.previousActiveDeploymentId ?? null,
    errorCode: dep.errorMessage?.includes("PORT_IN_USE") || dep.errorMessage?.includes("EADDRINUSE")
      ? "PORT_IN_USE"
      : undefined,
    projectType,
    ...composeData,
  };
}

// ─── Cancel build session ────────────────────────────────────────────────────

export async function cancelBuildSession(deploymentId: string, userId: string) {
  const { dep } = await loadDeploymentForUser(deploymentId, userId);

  if (!["queued", "building", "deploying"].includes(dep.status)) {
    throw new ForbiddenError("Cannot cancel a deployment that is not in progress");
  }

  const buildSession = await repos.deployment.findBuildSessionByDeploymentId(deploymentId);

  const { runtime } = platform();
  if (dep.status === "building") {
    await runtime.cancelBuild(dep.id).catch(() => {});
  }
  if (dep.containerId) {
    await runtime.destroy(dep.containerId).catch(() => {});
  }

  // Mark all pending/building services as failed so UI stops showing spinners
  const services = await repos.service.listByProject(dep.projectId).catch(() => []);
  for (const svc of services) {
    sessionManager.broadcastServiceStatus(dep.id, {
      serviceName: svc.name,
      serviceId: svc.id,
      status: "failed",
      error: "Deployment cancelled",
    });
  }

  await repos.deployment.updateStatus(dep.id, "cancelled");
  if (buildSession) {
    await repos.deployment.finishBuildSession(buildSession.id, "cancelled", 0);
  }

  // Broadcast cancelled AFTER service statuses so UI receives the service updates first
  sessionManager.updateStatus(dep.id, "cancelled");

  return { success: true, message: "Deployment cancelled" };
}

// ─── Redeploy build session ─────────────────────────────────────────────────

export async function redeployBuildSession(deploymentId: string, userId: string) {
  const { dep: oldDep, project } = await loadDeploymentForUser(deploymentId, userId);

  // Prefer the old deployment's snapshot; fall back to a fresh one from the project
  const meta = (oldDep.meta as DeploymentConfigSnapshot | null)
    ?? buildConfigSnapshot(project, oldDep.branch);

  const dep = await createQueuedDeployment({
    projectId: project.id,
    userId,
    branch: oldDep.branch,
    environment: oldDep.environment,
    framework: oldDep.framework || meta.framework,
    meta: {
      ...meta,
      previousActiveDeploymentId: project.activeDeploymentId ?? undefined,
    },
    envVars: oldDep.envVars as Record<string, string> | null,
  });

  return {
    success: true,
    deployment_id: dep.id,
    project_id: project.id,
  };
}

// ─── Start build from session ID (direct — no token) ─────────────────────────

export async function startBuild(deploymentId: string, userId: string) {
  const { dep, project } = await loadDeploymentForUser(deploymentId, userId);

  if (!["queued"].includes(dep.status)) {
    throw new ForbiddenError("Build session is not in queued state");
  }

  const buildSession = await repos.deployment.findBuildSessionByDeploymentId(deploymentId);
  if (!buildSession) throw new NotFoundError("BuildSession for deployment", deploymentId);

  // Create SSE session keyed by deployment ID
  sessionManager.createSession(dep.id, project.id);

  void executeBuildAndDeploy(project, dep, buildSession.id).catch((err) => {
    console.error(`[DEPLOY] Fatal error for ${dep.id}:`, err);
  });

  return {
    success: true,
    deployment_id: dep.id,
    project_id: project.id,
  };
}

// ─── Trigger deployment (internal build pipeline) ────────────────────────────

export async function triggerDeployment(userId: string, data: { projectId: string; branch?: string; commitSha?: string; environment?: string }) {
  const project = await repos.project.findById(data.projectId);
  if (!project || project.userId !== userId) {
    throw new NotFoundError("Project", data.projectId);
  }

  if (!project.gitUrl && !project.localPath) {
    throw new ForbiddenError("Project has no git repository or local path configured");
  }

  const branch = data.branch ?? project.gitBranch ?? "main";
  const environment = data.environment ?? "production";

  await checkNoActiveBuild(project.id);

  const snapshot = buildConfigSnapshot(project, branch);

  // ── Preflight: validate config before creating any resources ────
  const preflight = await runPreflightChecks(snapshot, { slug: project.slug, userId });
  if (!preflight.ok) {
    const failures = preflight.checks
      .filter((c) => c.status === "fail")
      .map((c) => `${c.label}: ${c.message}`)
      .join("; ");
    throw new ForbiddenError(`Pre-deploy checks failed: ${failures}`);
  }

  // Copy env vars from project (already encrypted in env_var table)
  const rawEnvMap = await repos.project.getEnvMap(project.id, environment);
  const encryptedEnvVars = Object.keys(rawEnvMap).length > 0 ? rawEnvMap : null;

  const dep = await createQueuedDeployment({
    projectId: project.id,
    userId,
    branch,
    commitSha: data.commitSha,
    environment,
    framework: snapshot.framework,
    meta: {
      ...snapshot,
      previousActiveDeploymentId: project.activeDeploymentId ?? undefined,
    },
    envVars: encryptedEnvVars,
  });

  const buildSess = await repos.deployment.findBuildSessionByDeploymentId(dep.id);
  if (!buildSess) throw new Error("Build session was not created");

  // Create SSE session keyed by deployment ID
  sessionManager.createSession(dep.id, project.id);

  void executeBuildAndDeploy(project, dep, buildSess.id).catch((err) => {
    console.error(`[DEPLOY] Fatal error for ${dep.id}:`, err);
  });

  return {
    deployment: dep,
  };
}

// ─── Build & Deploy pipeline (private) ───────────────────────────────────────

async function executeBuildAndDeploy(
  project: Project,
  dep: Deployment,
  buildSessionId: string,
) {
  const plat = platform();
  let { runtime, routing, ssl, system } = plat;

  // ── Read config snapshot early so we can resolve the runtime ──────
  const snapshot = dep.meta as DeploymentConfigSnapshot | null;
  if (!snapshot) {
    throw new Error("Deployment has no config snapshot (meta is empty)");
  }

  const logs: LogEntry[] = [];
  const MAX_LOG_ENTRIES = 50_000;

  const logCallback = (entry: LogEntry) => {
    if (logs.length < MAX_LOG_ENTRIES) logs.push(entry);
    sessionManager.appendLog(dep.id, entry);
  };

  // Single logger instance for the entire build→deploy lifecycle
  const logger = new BuildLogger(logCallback);

  /** Collapsed logs for DB persistence — resolves \r overwrites to final state. */
  const persistLogs = () => collapseTerminalLogs(logs);

  // ── Lifecycle context — shared across all phases ───────────────────
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
    // ── Resolve the full execution platform from deployment snapshot ──
    const resolved = await resolveDeploymentPlatform(snapshot, {
      userId: dep.userId,
      basePlatform: plat,
    });

    runtime = resolved.platform.runtime;
    routing = resolved.platform.routing;
    ssl = resolved.platform.ssl;
    system = resolved.platform.system;
    ctx.runtime = runtime;

    const effectiveTarget = resolved.effectiveTarget;
    const usesManagedRouting = resolved.usesManagedRouting;
    const targetExecutor: CommandExecutor | null = resolved.platform.executor;

    // ── Build phase ──────────────────────────────────────────────────
    await repos.deployment.updateStatus(dep.id, "building");
    await repos.deployment.updateBuildSession(buildSessionId, {
      status: "building",
      startedAt: new Date(),
    });
    sessionManager.updateStatus(dep.id, "building");

    const prodResources = withDefaults(snapshot.resources);
    const buildResources = withDefaults(
      snapshot.buildResources,
      DEFAULT_BUILD_RESOURCE_CONFIG,
    );

    // Decrypt env vars from deployment (self-contained)
    const envMap = decryptEnvVars(dep.envVars);
    const isLocalBuild = snapshot.buildStrategy === "local";
    const buildEnv = buildScopedEnvVars(envMap, {
      forceProductionNodeEnv: isLocalBuild,
    });

    if (isLocalBuild && buildEnv.ignoredNodeEnv && buildEnv.ignoredNodeEnv !== "production") {
      logger.log(
        `Ignoring deployment NODE_ENV=${buildEnv.ignoredNodeEnv} during local build and forcing NODE_ENV=production.`,
        "warn",
      );
    }

    // Resolve a fresh GitHub token for cloning (private repos)
    const gitToken = await resolveToken({
      userId: dep.userId,
      owner: project.gitOwner ?? undefined,
    }).catch(() => null);

    const buildConfig = createBuildConfig({
      project,
      dep,
      snapshot,
      sessionId: buildSessionId,
      envVars: buildEnv.envVars,
      resources: buildResources,
      gitToken: gitToken ?? undefined,
    });

    if (isComposeProject(project) && isMultiServiceRuntime(runtime)) {
      if (snapshot.composeServices?.length) {
        await repos.service.syncFromCompose(project.id, snapshot.composeServices);
      }

      await executeComposePipeline({
        project,
        dep,
        runtime,
        routing,
        ssl,
        usesManagedRouting,
        logger,
        ctx,
        snapshot,
        buildSessionId,
        buildEnvVars: buildEnv.envVars,
        buildResources,
        gitToken: gitToken ?? undefined,
      });
      return;
    }

    if (isComposeProject(project)) {
      // Compose project on a runtime that doesn't support multi-service yet
      const msg = `Compose projects are not supported on the "${runtime.name}" runtime yet. Use Docker runtime or deploy as a single app.`;
      logger.log(msg, "error");
      await onFailure(ctx, msg);
      return;
    }

    if (!snapshot.hasBuild) {
      logger.step("build", "completed", "Build disabled — skipping install & build, using source directly");
    }

    const buildResult = await runtime.build(buildConfig, logger);
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

    // ── Deploy phase ─────────────────────────────────────────────────
    await repos.deployment.updateStatus(dep.id, "deploying", {
      imageRef: buildResult.imageRef,
      buildDurationMs: buildResult.durationMs,
    });
    sessionManager.updateStatus(dep.id, "deploying");

    // ── Branch: static (Pages) vs server (VM) ────────────────────────
    if (!snapshot.hasServer && runtime instanceof CloudRuntime) {
      // ── Static deploy via Oblien Pages ─────────────────────────────
      logger.step("deploy", "running", "Deploying to edge (static)...");

      const staticResult = await runtime.deployStatic({
        deploymentId: dep.id,
        projectId: project.id,
        buildSessionId,
        imageRef: buildResult.imageRef,
        environment: dep.environment,
        port: snapshot.port,
        startCommand: snapshot.startCommand,
        stack: snapshot.framework,
        envVars: envMap,
        resources: prodResources,
        restartPolicy: "no",
        slug: project.slug,
        customDomain: snapshot.customDomain,
        outputDirectory: snapshot.outputDirectory,
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
    } else {
      // ── Server deploy (existing VM pipeline) ───────────────────────
      // Static sites are always served directly from the web server (OpenResty)
      // via file-backed routes — Docker is only for server apps.
      const staticBareRuntime = !snapshot.hasServer && runtime instanceof BareRuntime ? runtime : null;
      const isStaticSelfHosted = staticBareRuntime !== null;

      const deployConfig: DeployConfig = {
        deploymentId: dep.id,
        projectId: project.id,
        buildSessionId,
        imageRef: buildResult.imageRef,
        environment: dep.environment,
        port: snapshot.port,
        startCommand: snapshot.startCommand,
        stack: snapshot.framework,
        envVars: envMap,
        resources: prodResources,
        restartPolicy: isStaticSelfHosted ? "no" : "always",
        slug: project.slug,
        outputDirectory: snapshot.outputDirectory,
        productionPaths: snapshot.productionPaths.length
          ? snapshot.productionPaths
          : undefined,
      };

      // Gather inputs for the deploy pipeline
      const prevDep = project.activeDeploymentId
        ? await repos.deployment.findById(project.activeDeploymentId)
        : null;
      const previousRuntime = prevDep?.containerId
        ? await resolveDeploymentRuntime(prevDep).catch(() => runtime)
        : runtime;

      // ── Gather all domains that need routing ───────────────────────
      // Sources: custom domain, verified DB domains, free host subdomain.
      // Every domain gets an OpenResty route; SSL is provisioned only for
      // custom domains — the free host subdomain skips SSL (user manages it).
      const projectDomains = await repos.domain.listByProject(project.id);
      const domainByHostname = new Map(projectDomains.map((domain) => [domain.hostname.toLowerCase(), domain]));
      const plannedDomains = buildProjectRouteDomains({
        project,
        projectDomains,
        customDomain: snapshot.customDomain,
        runtimeName: runtime.name,
        usesManagedRouting,
      });

      // Persist domain records for any new planned domains (free subdomain, custom domain)
      for (const route of plannedDomains) {
        const created = await ensureRouteDomainRecord({
          projectId: project.id,
          route,
          domainByHostname,
        });
        if (created && !projectDomains.some((d) => d.id === created.id)) {
          logger.log(`Created domain record for "${route.hostname}".\n`);
        }
      }

      // Compose deploy environment from runtime adapter
      const deployEnv: DeployEnvironment = {
        preflight: targetExecutor
          ? async (cfg, promptUser) => {
              if (system) {
                const systemLog = (entry: { message: string; level: "info" | "warn" | "error" }) => {
                  logger.log(`${entry.message}\n`, entry.level);
                };

                if (!isStaticSelfHosted) {
                  await system.ensureFeature("deploy", systemLog);
                }
                if (plannedDomains.length > 0) {
                  await system.ensureFeature("routing", systemLog);
                }
                if (plannedDomains.some((d) => d.provisionSsl)) {
                  await system.ensureFeature("ssl", systemLog);
                }
              }

              if (!isStaticSelfHosted) {
                await ensurePortAvailable(targetExecutor, cfg.port, logger, promptUser);
              }
            }
          : undefined,
        activate: async (cfg, onLog) => {
          const r = isStaticSelfHosted
            ? await staticBareRuntime.deployStatic({
                ...cfg,
                outputDirectory: cfg.outputDirectory ?? snapshot.outputDirectory,
              })
            : await runtime.deploy(cfg, onLog);
          if (!r.containerId) throw new Error("Deploy produced no container");
          return { containerId: r.containerId, url: r.url };
        },
        deactivate: (id) => (previousRuntime.name === "bare" && !id.includes("/"))
          ? previousRuntime.stop(id)
          : previousRuntime.destroy(id),
        resolveRoute: isStaticSelfHosted
          ? async (id, cfg) => ({
              staticRoot: staticBareRuntime.resolveStaticRoot(id, cfg.outputDirectory ?? snapshot.outputDirectory),
            })
          : undefined,
        resolveTargetUrl: runtime.supports("containerIp")
          ? async (id, port) => {
              const ip = await runtime.getContainerIp(id);
              return ip ? `http://${ip}:${port}` : null;
            }
          : undefined,
      };

      // Attach custom domain from snapshot (passed through from input)
      if (snapshot.customDomain) {
        deployConfig.customDomain = snapshot.customDomain;
      }
      const deploySsl = plannedDomains.some((domain) => domain.provisionSsl)
        ? createTrackedSslProvider(ssl, domainByHostname)
        : ssl;

      const deployResult = await runDeployPipeline(deployEnv, {
        config: deployConfig,
        previousContainerId: prevDep?.containerId ?? undefined,
        domains: toRoutedDomainInputs(plannedDomains),
        routing,
        ssl: deploySsl,
        promptUser: (prompt) => sessionManager.promptUser(dep.id, prompt),
      }, logger);

      if (deployResult.status === "failed") {
        await onFailure(ctx, deployResult.error, buildResult.durationMs, {
          errorCode: deployResult.errorCode,
          errorDetails: deployResult.errorDetails,
        });
        return;
      }

      if (usesManagedRouting) {
        for (const domain of plannedDomains.filter((d) => d.isCloud && d.managedSubdomain)) {
          logger.log(`Syncing managed edge proxy for ${domain.hostname}...\n`);
          await ensureManagedEdgeProxy(dep.userId, domain.managedSubdomain!, {
            serverId: snapshot.serverId,
          });
        }
      }

      if (
        prevDep?.imageRef &&
        prevDep.imageRef !== buildResult.imageRef &&
        previousRuntime instanceof DockerRuntime
      ) {
        await previousRuntime.removeImage(prevDep.imageRef).catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          logger.log(`Warning: failed to remove previous image ${prevDep.imageRef}: ${message}\n`, "warn");
        });
      }

      // ── Success ──────────────────────────────────────────────────────
      await onSuccess(ctx, {
        containerId: deployResult.containerId!,
        url: deployResult.url,
        durationMs: buildResult.durationMs ?? 0,
      });

      if (runtime.name === "bare") {
        await pruneRetainedBareReleases(project, dep).catch((err) => {
          console.error(`[DEPLOY] Failed to prune retained releases for ${dep.id}:`, err);
        });
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    logger.log(`Error: ${message}`, "error");
    await onFailure(ctx, message);
  }
}
