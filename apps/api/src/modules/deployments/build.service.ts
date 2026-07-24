/**
 * Build service — build session LIFECYCLE + config/snapshot helpers.
 *
 * Public API: triggerDeployment, requestBuildAccess, redeployBuildSession,
 * startBuild, cancelBuildSession, respondToPrompt, createQueuedDeployment,
 * checkNoActiveBuild, buildConfigSnapshot, runDeploymentPreflight,
 * encryptEnvVars, metaWithPrevious, loadDeployment.
 * (getBuildSessionStatus moved to ./build-status.service.)
 *
 * The build→deploy EXECUTION engine (kickoffBuild → executeBuildAndDeploy
 * → deploy phases → post-deploy sync) lives in `./build-pipeline.ts`.
 * Lifecycle entry points here call `kickoffBuild` from there; the split
 * keeps this file focused on session state + request validation. The
 * pipeline owns the deploy↔rollback cycle (a deliberate dynamic import).
 */

import { repos, type Project } from "@repo/db";
import {
  AppError,
  NotFoundError,
  ForbiddenError,
  SYSTEM,
  STACKS,
  safeErrorMessage,
  getRuntimeImage,
  isReleaseProvider,
  type StackId,
  type DeployTarget,
  type BuildStrategy,
  type StackDefinition,
  type ReleaseSource,
} from "@repo/core";
import type {
  LogEntry,
  ResourceConfig,
} from "@repo/adapters";
import { resolveCloudResourceConfig } from "./cloud-resources";
import type { TBuildAccessBody } from "./deployment.schema";
import { platform } from "../../lib/controller-helpers";
import { encrypt } from "../../lib/encryption";
import { getLatestCommit, getRepository } from "../github/github.service";
import { assertGitHubRepoAccess } from "../github/github-access";
import { firePreDeployBackups } from "../backups/triggers/pre-deploy";
import { resolveSmartRoute } from "./smart-route";
import { resolveProjectInfo } from "./prepare.service";
import { getFolderSession } from "../projects/folder/session-store";
import { type RequestContext } from "../../lib/request-context";
import { type PortCheckResult } from "../../lib/deployment-runtime";
import * as sessionManager from "./session-manager";
import {
  collectDeploymentManifest,
  executeCleanup,
  type CleanupManifest,
} from "../projects/project-cleanup.service";
import { runPreflightChecks, type PreflightResult } from "./preflight";
import {
  isMultiServiceProject,
  listProjectComposeServices,
  projectServicesToDeployableServices,
} from "./compose";
import * as settingsService from "../settings/settings.service";
import { type DeployableService, serviceKind } from "../../lib/deployable-service";
import {
  listProjectRouteRows,
  resolveProjectRouteState,
  syncProjectRouteState,
} from "../domains/project-route.service";
import { kickoffBuild, resolveServicePipelineMode } from "./build-pipeline";
import { resolveReleaseDist, resolveLatestVersion, readApiVersion } from "../../lib/release-resolver";
import { env } from "../../config";

function throwPreflightFailure(preflight: PreflightResult): never {
  const failedChecks = preflight.checks.filter((check) => check.status === "fail");
  const failures = failedChecks.map((check) => `${check.label}: ${check.message}`).join("; ");
  const codes = Array.from(
    new Set(
      failedChecks.map((check) => check.code).filter((code): code is string => Boolean(code)),
    ),
  );
  const errorCode =
    codes.length === 1 && failedChecks.every((check) => check.code === codes[0])
      ? codes[0]
      : "PRE_DEPLOY_CHECKS_FAILED";

  throw new AppError(`Pre-deploy checks failed: ${failures}`, 403, errorCode);
}

/** Wrap a snapshot with the project's currently-active deployment id (rollback target). */
export function metaWithPrevious(
  snapshot: DeploymentConfigSnapshot,
  project: Project,
): DeploymentConfigSnapshot {
  return { ...snapshot, previousActiveDeploymentId: project.activeDeploymentId ?? undefined };
}

/** Run preflight against a snapshot+route state and throw a structured failure on any check fail. */
export async function runDeploymentPreflight(
  snapshot: DeploymentConfigSnapshot,
  routeState: Awaited<ReturnType<typeof resolveProjectRouteState>>,
  opts: {
    ctx: RequestContext;
    composeServices?: DeployableService[];
    multiService?: boolean;
    /** Git owner of the source repo. Cloud preflight uses it to verify the
     *  GitHub App is installed for this owner before the build pipeline
     *  spends resources cloning a repo it can't access. */
    gitOwner?: string | null;
    /** Project id — passed to the remote-clone-token preflight check so
     *  project-scoped clone tokens are considered. */
    projectId?: string;
  },
): Promise<void> {
  const preflight = await runPreflightChecks(snapshot, {
    customDomain: routeState.primaryCustomDomain,
    slug:
      routeState.publicEndpoints.length > 0 && routeState.primaryDomainType === "free"
        ? routeState.primarySlug
        : undefined,
    ctx: opts.ctx,
    publicEndpoints: routeState.publicEndpoints,
    ...(opts.composeServices ? { composeServices: opts.composeServices } : {}),
    ...(opts.multiService !== undefined ? { multiService: opts.multiService } : {}),
    ...(opts.gitOwner !== undefined ? { gitOwner: opts.gitOwner } : {}),
    ...(opts.projectId !== undefined ? { projectId: opts.projectId } : {}),
    buildStrategy: snapshot.buildStrategy as "local" | "server" | undefined,
  });
  if (!preflight.ok) {
    throwPreflightFailure(preflight);
  }
}

/** Config snapshot stored in deployment.meta - self-contained build+deploy config. */
export interface DeploymentConfigSnapshot {
  /** Owning organization — required so server lookups can be org-scoped. */
  organizationId?: string;
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
  /** Absolute path to a local project directory (alternative to repoUrl) */
  localPath?: string;
  /**
   * Release/dist source (gitProvider === "release"). Resolved by
   * `applyReleaseSourceToSnapshot` in the async entry points: the semver
   * version deployed, the asset it came from, and the source repo — captured
   * so history/rollback and the drift banner have a stable anchor. `localPath`
   * above points at the resolved dist dir and `buildCommand` is emptied
   * (deploy-only, no build).
   */
  releaseVersion?: string;
  releaseAsset?: string;
  releaseRepo?: string;
  /** Build strategy: "server" (build in workspace) or "local" (build on host) */
  buildStrategy?: BuildStrategy;
  /**
   * Folder-upload flow: source was uploaded out of band (no git). For a cloud
   * deploy the browser uploaded into THIS pre-provisioned Oblien workspace —
   * the build adopts it and skips clone + transfer (`sourceStaged`). For a
   * self-hosted deploy `localPath` above points at the staging dir instead.
   * Set by requestBuildAccess from the upload session.
   */
  uploadWorkspaceId?: string;
  sourceStaged?: boolean;
  /** Deploy target: "local" (this machine), "server" (remote SSH), or "cloud" (Oblien) */
  deployTarget?: DeployTarget;
  /** Target server ID when deployTarget is "server" */
  serverId?: string;
  /** Runtime mode: "bare" (direct process) or "docker" (container-based) */
  runtimeMode?: "bare" | "docker";
  /**
   * Adopt an already-running process instead of building + starting one. Set
   * for the self-deployed control plane so it becomes a real deployment without
   * a second process binding the port. Threaded onto DeployConfig.adopt.
   */
  adopt?: boolean;
  /** Project services fan-out mode captured for this deployment. */
  serviceDeploymentMode?: "services" | "single";
  /**
   * Deployable services captured at deploy request time. Mixed shape:
   * compose-source rows AND monorepo sub-app rows travel through the
   * same pipeline, discriminated by `kind`. See `DeployableService`.
   */
  composeServices?: DeployableService[];
  /** Summary of a compose deployment fan-out, when applicable. */
  composeDeployment?: {
    totalServices: number;
    successfulServices: number;
    failedServices: number;
    failedServiceNames: string[];
    warningMessage?: string;
    /**
     * User decision for a partial-failure deploy that is held for review.
     * `"pending"` = awaiting keep/reject (drives the "Action Required" UX);
     * `"kept"` = the operator confirmed it. Absent for non-partial deploys.
     */
    decision?: "pending" | "kept";
  };
  /**
   * A non-fatal post-deploy warning to surface on an otherwise-successful
   * deploy — e.g. a self-hosted + free-.opsh.io deploy whose cloud edge route
   * didn't sync (app is live locally but the free URL won't resolve yet).
   * Persisted so it survives a page refresh, not just the live SSE event.
   */
  deployWarning?: string;
  /**
   * Advisory post-deploy port-probe results (one per exposed port/service).
   * Point-in-time; drives the dashboard's skippable "wrong port?" modal.
   */
  portCheck?: PortCheckResult[];
  /**
   * Ports (single-app) / service ids (compose) the operator dismissed from the
   * port advisory — so it doesn't re-nag after a refresh.
   */
  portCheckSkipped?: (number | string)[];
  previousActiveDeploymentId?: string;
  /**
   * Smart per-service target list. When set, only these service ids
   * are (re)built; others are recorded as `service_deployment` rows
   * with `status='skipped'` so the fan-out has a complete record.
   */
  targetServiceIds?: string[];
  /**
   * Subset of `targetServiceIds` to REFRESH — recreate the container with
   * fresh env but WITHOUT rebuilding the image (env-only change, code
   * unchanged). They deploy from their previous image ref. Empty/absent =
   * every targeted service is rebuilt normally.
   */
  refreshServiceIds?: string[];
  /**
   * Per-deploy opt-in to forward the operator's LOCAL `gh` identity to the
   * remote host for the on-server clone (desktop-only; default off). Drives the
   * HTTPS credential relay in the build pipeline — see `allowRelayFallback`.
   * Nothing is persisted on the remote; the relay closes when the build ends.
   */
  forwardGitCredentials?: boolean;
  /**
   * Where the repo is cloned for a docker server deploy: "api-host" (default —
   * clone on the orchestrator, transfer the context) or "server" (clone on the
   * build host; desktop forwards creds via the relay, non-desktop ships a
   * short-lived token). Ignored for cloud; bare always clones on the target.
   */
  cloneStrategy?: "api-host" | "server";
}

/**
 * Request body for POST /deployments/build/access. Derived from the single
 * source `BuildAccessBody` (deployment.schema.ts) so the type, the runtime
 * body, and the MCP tool's param schema can't drift. `services` is the wire
 * subset of DeployableService (extra parser/monorepo fields optional), so it
 * stays assignable to DeployableService[] where consumed below.
 */
export type BuildAccessInput = TBuildAccessBody;

/** Narrow the free-form `project.runtime_mode` text column (string | null) to
 *  the runtime-isolation union — a validated check instead of an unchecked
 *  `as` cast, so a stray/legacy DB value can't be mistyped as a valid mode. */
function toRuntimeMode(value: string | null | undefined): "bare" | "docker" | undefined {
  return value === "bare" || value === "docker" ? value : undefined;
}

/** Build a config snapshot from the project - pure pass-through, no fallbacks.
 *  All values must be set by prepare / ensureProject before this is called. */
export function buildConfigSnapshot(
  project: Project,
  branch?: string,
): DeploymentConfigSnapshot {
  const runtimeImage = resolveRuntimeImage(project);

  return {
    // Owning org — needed by every downstream that does an org-scoped
    // lookup (preflight bridge, github installation resolver, runtime
    // factory). Multiple call sites used to set this AFTER snapshot
    // creation and the preflight call would race with `undefined` →
    // cloudClient({organizationId: undefined}) → null → outer code
    // shows "no cloud account connected". Set it here once, at the
    // source, where every snapshot consumer can rely on it.
    organizationId: project.organizationId,
    repoUrl: project.gitUrl ?? "",
    branch: branch || project.gitBranch || (project.localPath ? "main" : ""),
    framework: project.framework!,
    buildImage: project.buildImage!,
    runtimeImage,
    packageManager: project.packageManager!,
    installCommand: project.installCommand!,
    buildCommand: project.buildCommand!,
    outputDirectory: project.outputDirectory!,
    productionPaths: parseProductionPaths(project.productionPaths, project.framework),
    rootDirectory: project.rootDirectory || "",
    port: project.port ?? 3000,
    startCommand: project.startCommand!,
    resources: (project.resources as ResourceConfig) || null,
    buildResources: (project.buildResources as ResourceConfig) || null,
    hasServer: project.hasServer ?? !!project.startCommand?.trim(),
    hasBuild: project.hasBuild ?? true,
    localPath: project.localPath || undefined,
    // Per packages/db/src/schema/project.ts:231 — `cloudWorkspaceId IS
    // NOT NULL` is THE canonical "is this a cloud project?" test.
    // Default the snapshot's deployTarget from that so preflight,
    // pipeline, and rollback all see "cloud" without depending on the
    // UI to pass it on every redeploy. The desktop picker still wins
    // when it does pass an explicit deployTarget (see line ~773).
    deployTarget: project.cloudWorkspaceId ? "cloud" : undefined,
    // Runtime isolation mode persisted on the project (editable in the Runtime
    // tab). So a redeploy/webhook deploy respects the saved choice instead of
    // re-defaulting. The wizard's per-deploy override still wins when passed.
    runtimeMode: toRuntimeMode(project.runtimeMode),
  };
}

/**
 * Resolve a release/dist-source project (`gitProvider === "release"`) into a
 * deployable snapshot: pick the version, download/locate the prebuilt dist,
 * and point the snapshot's `localPath` at it with the build step emptied. The
 * rest of the pipeline then treats it exactly like a `localPath` no-build
 * deploy — no bespoke pipeline. `buildConfigSnapshot` is sync/pure, so this
 * async resolution runs in the deploy entry points (requestBuildAccess /
 * triggerDeployment) after the snapshot is built, mirroring `startWebmailDeploy`.
 *
 * Version precedence: explicit `opts.version` (webhook release tag / redeploy
 * pin) → `releaseSource.pinnedVersion` → newest advertised (github latest tag
 * or `versionUrl`) → the API's own version (mono-version fallback).
 *
 * Mutates `snapshot` in place and returns the resolved semver (no leading "v").
 */
export async function applyReleaseSourceToSnapshot(
  project: Project,
  snapshot: DeploymentConfigSnapshot,
  opts?: { version?: string },
): Promise<string> {
  // Backstop: release/dist resolution downloads + extracts a prebuilt dir onto
  // THIS box (~/.openship) — a self-hosted runtime op that must never run on the
  // multi-tenant SaaS control plane. Creation is already blocked in cloud mode
  // (resolveProjectSource); this also covers redeploy/webhook paths for any
  // project that predates the gate.
  if (env.CLOUD_MODE) {
    throw new ForbiddenError("Release/dist source deploys are not available in cloud mode");
  }
  const source = (project.releaseSource as ReleaseSource | null) ?? null;
  if (!source) {
    throw new AppError(
      `Project ${project.id} has gitProvider "release" but no releaseSource configured.`,
      400,
      "RELEASE_SOURCE_MISSING",
    );
  }

  const version =
    stripV(opts?.version) ||
    stripV(source.pinnedVersion) ||
    (await resolveLatestVersion(source)) ||
    readApiVersion();

  const result = await resolveReleaseDist({
    name: project.slug || project.id,
    version,
    source,
  });

  // Deploy the prebuilt dist as-is: point localPath at it, drop any git repo,
  // and never build. Install still runs iff the project keeps hasBuild=true
  // (install-only apps like webmail); a pure static/binary dist sets hasBuild=false.
  snapshot.localPath = result.dir;
  snapshot.repoUrl = "";
  snapshot.buildCommand = "";
  snapshot.releaseVersion = result.version;
  snapshot.releaseAsset = result.asset;
  snapshot.releaseRepo = source.mode === "github" ? source.repo : undefined;
  return result.version;
}

function stripV(v: string | null | undefined): string | undefined {
  const t = v?.trim();
  return t ? t.replace(/^v/, "") : undefined;
}

async function resolveLatestCommitInfo(ctx: RequestContext, project: Project, branch: string) {
  if (!project.gitOwner || !project.gitRepo) {
    return {};
  }

  const head = await getLatestCommit(ctx, project.gitOwner, project.gitRepo, branch);
  return head ? { commitSha: head.sha, commitMessage: head.message } : {};
}

async function resolveProjectBranch(ctx: RequestContext, project: Project, branch?: string) {
  const configuredBranch = branch?.trim() || project.gitBranch?.trim();
  if (configuredBranch) return configuredBranch;

  if (project.gitOwner && project.gitRepo) {
    const repository = await getRepository(ctx, project.gitOwner, project.gitRepo);
    return repository.default_branch;
  }

  return "main";
}

/**
 * Re-parse the repo's current docker-compose and 3-way reconcile it against the
 * stored service rows (repos.service.reconcileFromCompose): services the user
 * hasn't edited auto-update to the repo; edited services are preserved and flagged
 * (`driftSpec`) for review. Best-effort — a repo/parse failure, a non-compose or
 * local-source project, or an empty parse leaves the rows untouched and NEVER
 * blocks the deploy. GitHub-source compose projects only.
 *
 * `changedPaths` (webhook only) is an optimization: when we have a definite,
 * non-empty changed-file list that does NOT include a compose file, skip the
 * repo scan entirely — the compose can't have changed. When it's absent (manual
 * redeploy) or empty, reconcile runs to be safe.
 */
const COMPOSE_PATH_RE = /(^|\/)(docker-compose|compose)\.ya?ml$/i;
async function reconcileComposeDrift(
  ctx: RequestContext,
  project: Project,
  branch: string,
  changedPaths?: string[] | null,
) {
  try {
    if (!project.gitOwner || !project.gitRepo) return; // local/no-git source → nothing to re-parse
    if (changedPaths && changedPaths.length > 0 && !changedPaths.some((p) => COMPOSE_PATH_RE.test(p))) {
      return; // this push didn't touch the compose file → no drift possible
    }
    const composeRows = await listProjectComposeServices(project.id);
    if (!composeRows.some((s) => s.kind === "compose")) return; // not a compose project
    const info = await resolveProjectInfo({
      source: "github",
      owner: project.gitOwner,
      repo: project.gitRepo,
      branch,
      ctx,
    });
    const services = info.services ?? [];
    if (services.length === 0) return;
    const { driftedNames } = await repos.service.reconcileFromCompose(project.id, services);
    if (driftedNames.length > 0) {
      console.log(
        `[compose-drift] ${project.id}: kept user edits on ${driftedNames.join(", ")} (pending review)`,
      );
    }
  } catch (err) {
    console.warn(`[compose-drift] reconcile skipped for ${project.id}:`, err);
  }
}

/**
 * Single source of truth for a deployment's rollback context. Replaces the
 * blocks that were hand-copied (with divergent defaults) across
 * requestBuildAccess / triggerDeployment / redeployBuildSession / the webhook
 * push path.
 *
 *   - rollbackStrategy: explicit override wins, else the project default, else
 *     `"git"` (cheap re-clone at the prior commit; the unified default — set
 *     `project.defaultRollbackStrategy = "snapshot"` for instant artifact
 *     restore). createQueuedDeployment's backstop matches this same `"git"`.
 *   - commitShaBefore: explicit override wins, else the last successful deploy
 *     on this branch — the anchor a git-strategy rollback re-clones to.
 */
export async function resolveRollbackContext(
  project: Project,
  branch: string,
  override?: { rollbackStrategy?: "snapshot" | "git"; commitShaBefore?: string },
): Promise<{ rollbackStrategy: "snapshot" | "git"; commitShaBefore?: string }> {
  const rollbackStrategy =
    override?.rollbackStrategy ??
    (project.defaultRollbackStrategy as "snapshot" | "git" | undefined) ??
    "git";

  let commitShaBefore = override?.commitShaBefore;
  if (!commitShaBefore) {
    const lastGood = await repos.deployment
      .getLatestSuccessfulForBranch(project.id, branch)
      .catch(() => null);
    commitShaBefore = lastGood?.commitSha ?? undefined;
  }

  return { rollbackStrategy, commitShaBefore };
}

/**
 * Single source of truth for a deployment snapshot's TARGET — deployTarget +
 * serverId + runtimeMode. Used by BOTH deploy entry points (requestBuildAccess
 * and triggerDeployment) so they can never diverge on where a project deploys.
 *
 * Precedence:
 *   - deployTarget: explicit per-deploy override (the wizard picker)
 *       > cloudWorkspaceId (the canonical "is a cloud project" primitive)
 *       > the project's ACTIVE deployment's last target (what it runs on now)
 *       > undefined (host default, resolved later by the pipeline's resolver).
 *   - serverId: ONLY kept when the resolved target is "server". For cloud/local
 *       it is dropped, so a non-server deploy can't carry a stale serverId and
 *       mis-route (the bug the unconditional inheritance had).
 *   - runtimeMode: override > project.runtimeMode column > active-meta.
 */
export async function resolveSnapshotTarget(
  project: Project,
  override?: { deployTarget?: DeployTarget; serverId?: string; runtimeMode?: "bare" | "docker" },
): Promise<{ deployTarget?: DeployTarget; serverId?: string; runtimeMode?: "bare" | "docker" }> {
  const activeMeta = project.activeDeploymentId
    ? ((await repos.deployment.findById(project.activeDeploymentId).catch(() => null))
        ?.meta as DeploymentConfigSnapshot | null)
    : null;

  const deployTarget: DeployTarget | undefined =
    override?.deployTarget ??
    (project.cloudWorkspaceId ? "cloud" : (activeMeta?.deployTarget ?? undefined)) ??
    undefined;

  const serverId =
    deployTarget === "server"
      ? (override?.serverId ?? activeMeta?.serverId ?? undefined)
      : undefined;

  const runtimeMode =
    override?.runtimeMode ?? toRuntimeMode(project.runtimeMode) ?? activeMeta?.runtimeMode;

  return { deployTarget, serverId, runtimeMode };
}

function resolveRuntimeImage(project: Project): string {
  const hasServer = project.hasServer ?? !!project.startCommand?.trim();
  const stackId = (
    project.framework && project.framework in STACKS ? project.framework : "unknown"
  ) as StackId;

  if (!hasServer) {
    return getRuntimeImage("static", project.packageManager ?? undefined);
  }

  return getRuntimeImage(stackId, project.packageManager ?? undefined);
}

/** Parse productionPaths from DB text (comma-separated) with STACKS fallback. */
function parseProductionPaths(
  raw: string | null | undefined,
  framework: string | null | undefined,
): string[] {
  if (raw)
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  if (framework && framework in STACKS) {
    const paths = STACKS[framework as StackId] as StackDefinition;
    return paths.productionPaths ? [...paths.productionPaths] : [];
  }
  return [];
}

/** Encrypt a plaintext key-value map. Returns null if empty. */
export function encryptEnvVars(envVars?: Record<string, string>): Record<string, string> | null {
  if (!envVars || Object.keys(envVars).length === 0) return null;
  const encrypted: Record<string, string> = {};
  for (const [k, v] of Object.entries(envVars)) {
    encrypted[k] = encrypt(v);
  }
  return encrypted;
}

/**
 * Load a deployment + its project, refusing if their organizations don't
 * agree. The calling route's permission middleware already verified the
 * caller is a member of the deployment's org; this is a defense-in-depth
 * check against a deployment ever outliving a project moving orgs.
 */
export async function loadDeployment(deploymentId: string) {
  const dep = await repos.deployment.findById(deploymentId);
  if (!dep) throw new NotFoundError("Deployment", deploymentId);

  const project = await repos.project.findById(dep.projectId);
  if (!project) throw new NotFoundError("Deployment", deploymentId);

  if (dep.organizationId !== project.organizationId) {
    throw new NotFoundError("Deployment", deploymentId);
  }

  return { dep, project };
}

/** Throw if the project already has an in-progress deployment. */
export async function checkNoActiveBuild(projectId: string) {
  const { rows } = await repos.deployment.listByProject(projectId, {
    page: 1,
    perPage: SYSTEM.DEPLOYMENTS.MAX_CONCURRENT_PER_PROJECT + 1,
  });
  const active = rows.find((d) => ["queued", "building", "deploying"].includes(d.status));
  if (active) {
    throw new ForbiddenError(
      `A deployment is already in progress (${active.id}). Cancel it first or wait for it to complete.`,
    );
  }
}

/**
 * Which enabled services have an env var (project-level or service-scoped)
 * modified since the active deployment went live — i.e. need an env-only
 * refresh. A project-level change (serviceId null) affects EVERY service.
 * Returns null when there's no active deployment/anchor to compare against
 * (first deploy → forceAll handles it). Values are never read, only
 * updatedAt, so no decryption is involved.
 */
async function resolveEnvDirtyServiceIds(
  project: Project,
  environment: string,
): Promise<Set<string> | null> {
  if (!project.activeDeploymentId) return null;
  const active = await repos.deployment.findById(project.activeDeploymentId).catch(() => null);
  // Anchor on the active deployment's createdAt: any env var touched after it
  // started is (conservatively) treated as needing a refresh. Biases safe —
  // once redeployed, the new active's createdAt post-dates the change, so it
  // won't keep re-refreshing.
  const anchor = active?.createdAt ?? null;
  if (!anchor) return null;

  const [meta, services] = await Promise.all([
    repos.project.listEnvVarChangeMeta(project.id, environment).catch(() => []),
    repos.service.listByProject(project.id).catch(() => []),
  ]);
  const enabledIds = services.filter((s) => s.enabled).map((s) => s.id);

  // A project-level (unscoped) env change touches every service.
  if (meta.some((m) => m.serviceId === null && m.updatedAt > anchor)) {
    return new Set(enabledIds);
  }
  const perService = new Set(
    meta
      .filter((m) => m.serviceId !== null && m.updatedAt > anchor)
      .map((m) => m.serviceId as string),
  );
  return new Set(enabledIds.filter((id) => perService.has(id)));
}

export async function createQueuedDeployment(opts: {
  projectId: string;
  /** Org that owns this deployment. Pass project.organizationId — the
   *  scoping key for the row. (Actor attribution lives on the audit
   *  layer, not on the deployment row.) */
  organizationId: string;
  branch: string;
  environment: string;
  framework: string;
  meta: DeploymentConfigSnapshot;
  envVars: Record<string, string> | null;
  commitSha?: string;
  commitMessage?: string;
  trigger?: string;
  /** Rollback policy for THIS deployment. Defaults to 'git' (matches
   *  resolveRollbackContext + the project default). */
  rollbackStrategy?: "snapshot" | "git";
  /** SHA active before this deploy — used by git-strategy rollback. */
  commitShaBefore?: string;
  /** Force-rebuild every service regardless of changed paths. */
  forceAll?: boolean;
  /** Smart per-service targeting — passed through to the executor via meta. */
  serviceIds?: string[];
  /** Subset of serviceIds to recreate WITHOUT rebuilding (env-only refresh). */
  refreshServiceIds?: string[];
  /** Changed-file paths traced for this version (file/root tracing). */
  changedPaths?: string[] | null;
  changedPathsTruncated?: boolean;
}) {
  // Persist the smart-deploy serviceIds onto the snapshot so the
  // executor can find them without re-resolving from request scope.
  let meta: DeploymentConfigSnapshot = opts.meta;
  if (opts.serviceIds && opts.serviceIds.length > 0) {
    meta = { ...meta, targetServiceIds: opts.serviceIds };
  }
  if (opts.refreshServiceIds && opts.refreshServiceIds.length > 0) {
    meta = { ...meta, refreshServiceIds: opts.refreshServiceIds };
  }

  // Version is NOT assigned here. A version number represents a shipped
  // release (a successful deploy of a commit), so it's assigned in onSuccess —
  // per-commit, reusing the number when the same commit is redeployed. Failed
  // and in-flight deploys stay version=null and show no badge.

  // The insert is atomic against the one-active-per-project index: undefined
  // means another deployment won/holds the slot (raced past checkNoActiveBuild,
  // or a queued/building one already exists). Surface as a 403, same as the
  // early-rejection path — no error-code/message inspection needed.
  const dep = await repos.deployment.create({
    projectId: opts.projectId,
    organizationId: opts.organizationId,
    branch: opts.branch,
    commitSha: opts.commitSha,
    commitMessage: opts.commitMessage,
    trigger: opts.trigger ?? "manual",
    environment: opts.environment,
    framework: opts.framework,
    status: "queued",
    // Release/dist deploy identity, from the resolved snapshot. Like commit_sha
    // (not the human `version` counter): set at CREATE so it's queryable while
    // the build is in flight — drives new-version suppression + webhook dedupe.
    releaseVersion: meta.releaseVersion ?? null,
    meta,
    envVars: opts.envVars,
    // Default to git: most projects are GitHub-backed and re-cloning
    // at the previous commit_sha is cheaper than archiving artifacts.
    // Callers that need snapshot pass it explicitly (or set the
    // per-project default via project.defaultRollbackStrategy).
    rollbackStrategy: opts.rollbackStrategy ?? "git",
    commitShaBefore: opts.commitShaBefore,
    forceAll: opts.forceAll ?? false,
    changedPaths: opts.changedPaths ?? null,
    changedPathsTruncated: opts.changedPathsTruncated ?? false,
  });
  if (!dep) {
    throw new ForbiddenError(
      "Another deployment is already in progress for this project. Wait for it to finish or cancel it.",
    );
  }

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

  // Supersede any lingering `reconciling` deployment for this project (a prior
  // connection-loss deploy that never got verified). This new deploy replaces
  // it, so mark the old one `failed` — status only, no container destroy: the
  // compose in-place replacement path handles the old containers, and an
  // unreachable host would just hang here. Best-effort.
  await repos.deployment
    .supersedeReconciling(opts.projectId, dep.id)
    .catch((err) =>
      console.warn(`[build] supersede reconciling for ${opts.projectId} failed:`, err),
    );

  // Creating a new deployment IS the decision on any prior partial-failure
  // "keep or reject" that's still pending for this project — retry / redeploy /
  // webhook all supersede it. Clear it at CREATE time (not deferred to
  // onDeploymentReady, which never fires if this build stays building or fails)
  // so the "Action Required" banner + modal disappear immediately and can't
  // re-arm the retry loop. Best-effort, matching supersedeReconciling above.
  await repos.deployment
    .supersedePendingDecisions(opts.projectId, dep.id)
    .catch((err) =>
      console.warn(`[build] supersede pending decisions for ${opts.projectId} failed:`, err),
    );

  return dep;
}

/** Subscribe to live build logs by deployment ID (dep_xxx). */
export { subscribe as subscribeToBuildSession } from "./session-manager";

/** Resolve a pending pipeline prompt (e.g. port conflict). */
export async function respondToPrompt(
  deploymentId: string,
  action: string,
): Promise<boolean> {
  await loadDeployment(deploymentId);
  return sessionManager.respondToPrompt(deploymentId, action);
}

/**
 * Default public endpoint for a deploy that supplied none: a free subdomain from
 * the project slug. Static sites route by path, server apps by port — an endpoint
 * with neither is dropped downstream (see deriveEnvironmentPublicEndpoints), so
 * pick the one the project's shape needs.
 */
function defaultFreeEndpoint(project: {
  slug: string;
  hasServer: boolean;
  port: number | null;
}): { domain: string; domainType: "free"; port?: string; targetPath?: string } {
  return project.hasServer && project.port
    ? { domain: project.slug, domainType: "free", port: String(project.port) }
    : { domain: project.slug, domainType: "free", targetPath: "/" };
}

export async function requestBuildAccess(ctx: RequestContext, input: BuildAccessInput) {
  const {
    projectId,
    branch,
    environment,
    envVars,
    publicEndpoints,
    buildStrategy,
    deployTarget,
    serverId,
    runtimeMode,
    serviceDeploymentMode,
    services,
    cloudResourceTier,
    cloudResourceCustom,
    forwardGitCredentials,
    cloneStrategy,
  } = input;

  const project = await repos.project.findById(projectId);
  if (!project) {
    throw new NotFoundError("Project", projectId);
  }
  // Org-membership is verified by the route-level requirePermission
  // middleware before this is reached.
  // GitHub access gate: default-deny for everyone but the org owner —
  // a member can deploy a GitHub-backed project only when granted this
  // repo. Hard-stop here so they can't fall through to their personal
  // token on a local build (owner-control bypass) or fail mid-build.
  await assertGitHubRepoAccess(ctx, {
    owner: project.gitOwner,
    repo: project.gitRepo,
  });

  await checkNoActiveBuild(project.id);

  const resolvedBranch = await resolveProjectBranch(ctx, project, branch);
  const projectDomains = await listProjectRouteRows(project.id);
  let routeState = await resolveProjectRouteState(project, { projectDomains });
  const snapshot = buildConfigSnapshot(project, resolvedBranch);

  // Release/dist source: resolve version → prebuilt dist dir → snapshot.localPath
  // (no build). Runs here, not in the sync buildConfigSnapshot, because the
  // cache-miss path downloads. Everything downstream sees a plain localPath deploy.
  if (isReleaseProvider(project.gitProvider)) {
    await applyReleaseSourceToSnapshot(project, snapshot);
  }

  // Caller-supplied endpoints win. If the caller omitted them (an MCP/API deploy)
  // AND the project has no route yet, default a free subdomain from the project
  // slug — otherwise a static deploy creates an UNBOUND page (404) and a server
  // deploy gets no public URL. The dashboard wizard always sends one; this is parity.
  //
  // NOT for services projects: a services deploy exposes PER SERVICE (each row
  // carries its own publicEndpoints), so there is no project-level domain to
  // default. An internal-only services stack (e.g. a migrated postgres/redis)
  // must deploy with no public route — defaulting a free .opsh.io project domain
  // here made self-hosted migration fail preflight (free domains need cloud edge).
  const isServicesDeploy = serviceDeploymentMode === "services" || !!services?.length;
  let nextPublicEndpoints = publicEndpoints;
  if (
    nextPublicEndpoints === undefined &&
    routeState.publicEndpoints.length === 0 &&
    !isServicesDeploy
  ) {
    nextPublicEndpoints = [defaultFreeEndpoint(project)];
  }

  if (nextPublicEndpoints !== undefined) {
    const routing = await syncProjectRouteState(project, {
      projectDomains,
      nextPublicEndpoints,
      slug: routeState.publicEndpoints.find((endpoint) => endpoint.domainType === "free")?.domain,
    });
    routeState = routing;
  }

  const requestedServiceMode =
    serviceDeploymentMode === "single"
      ? "single"
      : serviceDeploymentMode === "services" || services?.length
        ? "services"
        : undefined;

  if (requestedServiceMode) {
    snapshot.serviceDeploymentMode = requestedServiceMode;
  }
  if (requestedServiceMode === "services" && services?.length) {
    snapshot.composeServices = services;
    // Persist compose services to the canonical service table NOW, at
    // deploy-request time — not only deep inside the compose pipeline. A build
    // that FAILS before the pipeline's own sync (clone/prepare error, image
    // pull, etc.) would otherwise leave the project with ZERO service rows, so
    // the config-edit wizard (which reads the service table) collapses to
    // single-app even though the compose config is right here. syncFromCompose
    // is idempotent and strictly owns compose rows, so filter out monorepo
    // entries (they'd create ghost compose rows) exactly like the pipeline does.
    // Best-effort: a persist failure must never block the deploy.
    const composeOnly = services.filter((s) => serviceKind(s) === "compose");
    if (composeOnly.length) {
      await repos.service
        .syncFromCompose(project.id, composeOnly)
        .catch((err) =>
          console.warn(
            `[requestBuildAccess] failed to persist compose services: ${safeErrorMessage(err)}`,
          ),
        );
    }
  }
  const { useServicePipeline, servicePreflightServices } = await resolveServicePipelineMode(
    project,
    snapshot,
  );

  // Resolve the snapshot's target (deployTarget + serverId + runtimeMode) from
  // the single source of truth shared with triggerDeployment — UI override >
  // cloudWorkspaceId > active-deployment meta. Keeps the two deploy entry points
  // from diverging on where a project deploys.
  const resolvedTarget = await resolveSnapshotTarget(project, { deployTarget, serverId, runtimeMode });
  snapshot.deployTarget = resolvedTarget.deployTarget;
  snapshot.serverId = resolvedTarget.serverId;
  snapshot.runtimeMode = resolvedTarget.runtimeMode;

  // Folder-upload: point this deploy at the source the browser uploaded.
  //   - cloud (oblien-direct): adopt the pre-provisioned workspace, skip clone.
  //   - self-hosted (api-relay): build from the staging dir like a local folder.
  // The session/workspace outlive this call (session TTL; workspace made
  // permanent on deploy), so nothing is disposed here.
  if (input.uploadSessionId) {
    const session = getFolderSession(input.uploadSessionId);
    if (!session || session.orgId !== ctx.organizationId) {
      throw new AppError("Upload session not found or expired — re-upload the folder.", 400);
    }
    if (session.mode === "oblien-direct") {
      snapshot.uploadWorkspaceId = session.workspaceId;
      snapshot.sourceStaged = true;
      snapshot.deployTarget = "cloud";
    } else {
      snapshot.localPath = session.stagingDir;
    }
  }

  // Persist an EXPLICIT runtime-isolation choice (the deploy "sandbox vs direct"
  // modal pick) onto the project so it STICKS. Without this the choice lives only
  // in this one deployment's snapshot: the modal re-asks every deploy, a later
  // config-save reads project.runtimeMode (still null) and writes the host
  // default, and a redeploy then resolves to that default (bare) — silently
  // flipping a docker/sandbox project to direct-on-host. Best-effort: a failed
  // persist must not block the deploy. Only write when it actually changed.
  if (
    (runtimeMode === "bare" || runtimeMode === "docker") &&
    runtimeMode !== project.runtimeMode
  ) {
    await repos.project
      .update(project.id, { runtimeMode })
      .catch((err) =>
        console.warn(`[requestBuildAccess] failed to persist runtimeMode: ${safeErrorMessage(err)}`),
      );
  }

  // Resolve effective build strategy via settings service.
  // Pass deployTarget so that — absent an explicit per-deploy choice — the
  // cloud target defaults to a cloud-side build (right toolchain, no host
  // resource burn). See settingsService.resolveStrategy priority chain.
  snapshot.buildStrategy = await settingsService.resolveStrategy(
    snapshot.framework,
    buildStrategy ?? snapshot.buildStrategy,
    { deployTarget: snapshot.deployTarget },
  );
  // Per-deploy git credential forwarding choice (desktop-only; default off).
  // We carry the raw choice; the build pipeline enforces desktop + server-build
  // gating before opening the relay, so a forged flag elsewhere is inert.
  if (forwardGitCredentials === true) {
    snapshot.forwardGitCredentials = true;
  }
  // Per-deploy clone location. "server" makes a docker deploy clone on the build
  // host (relay on desktop, token otherwise); the pipeline gates it. Default
  // "api-host" (clone on the orchestrator + transfer) when unset.
  if (cloneStrategy === "server" || cloneStrategy === "api-host") {
    snapshot.cloneStrategy = cloneStrategy;
  }

  // Openship Cloud resource tier — only a SERVER-BACKED cloud (Oblien)
  // deploy provisions a workspace sized by these resources. Static (Pages)
  // deploys have no workspace to size, and non-cloud targets keep the
  // project's own resource config, so the picker is ignored for them.
  // The resolved ResourceConfig rides the existing `snapshot.resources`
  // plumbing → prodResources → runtime.deploy / ensureServiceGroup →
  // cloud.ts (cpus/memory_mb/disk_size_mb).
  if (snapshot.deployTarget === "cloud" && snapshot.hasServer && cloudResourceTier) {
    snapshot.resources = resolveCloudResourceConfig(cloudResourceTier, cloudResourceCustom);
  }

  // ── Preflight: validate config + domain before creating any resources ──
  await runDeploymentPreflight(snapshot, routeState, {
    ctx,
    composeServices: servicePreflightServices,
    multiService: useServicePipeline,
    gitOwner: project.gitOwner,
    projectId: project.id,
  });
  const env = environment || "production";

  // ── Resolve commit info from the branch HEAD ────
  const { commitSha, commitMessage } = await resolveLatestCommitInfo(
    ctx,
    project,
    snapshot.branch,
  );

  // ── Resolve rollback context (shared helper — single default) ─────────
  const { rollbackStrategy, commitShaBefore } = await resolveRollbackContext(
    project,
    snapshot.branch,
  );

  // Caller-supplied envVars win (and get persisted as the new project
  // defaults below); when this deploy request didn't include any — the
  // typical wizard/CLI "just redeploy" call — fall back to the project's
  // already-saved env vars, the same way triggerDeployment's fresh-deploy
  // path does. Without this, a bare/server-build deploy silently ships with
  // no env at all even though `PATCH /api/projects/:id/env` succeeded.
  let deploymentEnvVars = encryptEnvVars(envVars);
  if (!deploymentEnvVars) {
    const rawEnvMap = await repos.project.getEnvMap(project.id, env);
    deploymentEnvVars = Object.keys(rawEnvMap).length > 0 ? rawEnvMap : null;
  }

  const dep = await createQueuedDeployment({
    projectId: project.id,
    organizationId: project.organizationId,
    branch: snapshot.branch,
    commitSha,
    commitMessage,
    environment: env,
    framework: snapshot.framework,
    meta: metaWithPrevious(snapshot, project),
    envVars: deploymentEnvVars,
    rollbackStrategy,
    commitShaBefore,
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

  // Kick off the build BEFORE returning so the dashboard can attach via the
  // safe GET /:id/stream path (startBuild=false) instead of the racy POST
  // /:id/build round-trip. Without this, the dashboard had to make a second
  // call that both starts the build AND opens SSE — when that call stalled
  // (common during cloud-workspace provisioning), the SSE reconnect gate
  // refused to retry and the user saw an empty terminal until refresh.
  //
  // Mirrors `redeployBuildSession`'s kickoff — same race, same fix. startBuild
  // is idempotent (see its guard) so a stale follow-up POST is a no-op.
  await kickoffBuild(project, dep);

  return {
    success: true,
    deployment_id: dep.id,
    project_id: project.id,
  };
}


export async function cancelBuildSession(deploymentId: string) {
  const { dep, project } = await loadDeployment(deploymentId);

  if (!["queued", "building", "deploying"].includes(dep.status)) {
    throw new ForbiddenError("Cannot cancel a deployment that is not in progress");
  }

  const buildSession = await repos.deployment.findBuildSessionByDeploymentId(deploymentId);

  // 1. Abort the running build process. Best-effort - if the build already
  //    finished or never started this is a no-op.
  const { runtime } = platform();
  if (dep.status === "building" && buildSession) {
    await runtime.cancelBuild(buildSession.id).catch(() => {});
  }

  // 2. Tear down whatever the deploy had already provisioned. The shared
  //    deployment manifest enumerates ALL containers (deployment + each
  //    service) and ALL images (deployment + each service's built image),
  //    deduplicated. Volumes are deliberately NOT cleaned - cancel !=
  //    delete, and the user may retry.
  const manifest = await collectDeploymentManifest(dep, project).catch(
    (): CleanupManifest => ({ projectId: dep.projectId, resources: [] }),
  );
  if (manifest.resources.length > 0) {
    await executeCleanup(manifest).catch((err) => {
      // Per-item failures are already isolated inside executeCleanup, so we
      // only land here on an unexpected crash. Log and continue - cancel
      // still has to mark the deployment cancelled, leak or no leak.
      console.error(`[CANCEL] Cleanup crashed for ${dep.id}:`, err);
    });
  }

  // 3. Surface service-level cancellation in the SSE stream so the UI stops
  //    showing per-service spinners.
  const snapshot = dep.meta as DeploymentConfigSnapshot | null;
  if (snapshot?.serviceDeploymentMode !== "single") {
    const services = await repos.service.listByProject(dep.projectId).catch(() => []);
    for (const svc of services) {
      sessionManager.broadcastServiceStatus(dep.id, {
        serviceName: svc.name,
        serviceId: svc.id,
        status: "failed",
        error: "Deployment cancelled",
      });
    }
  }

  // 4. Persist the cancelled status + close the SSE stream.
  // INVARIANT: cancel writes the DEPLOYMENT row only — NEVER the project row.
  // activeDeploymentId (the last successful release) is left untouched, so a
  // cancelled redeploy has zero effect on the project's live state.
  await repos.deployment.updateStatus(dep.id, "cancelled");
  if (buildSession) {
    await repos.deployment.finishBuildSession(buildSession.id, "cancelled", 0);
  }
  // Broadcast cancelled AFTER service statuses so UI receives the service updates first
  sessionManager.updateStatus(dep.id, "cancelled");

  return { success: true, message: "Deployment cancelled" };
}

export async function redeployBuildSession(
  ctx: RequestContext,
  deploymentId: string,
  opts?: { useExistingCommit?: boolean; trigger?: string; preDeployBackup?: boolean },
) {
  const { dep: oldDep, project } = await loadDeployment(deploymentId);
  // The Openship control plane updates itself via the CLI — never a redeploy.
  // The apply-update endpoint (updates.service) reaches redeploy directly, and
  // the self-app is a repo-less release project so the GitHub gate below
  // short-circuits without catching it — guard explicitly here too, matching
  // triggerDeployment. Otherwise "Apply update" no-ops on the adopt deployment
  // and fakes success while the running control plane is untouched.
  if (project.appTemplateId === "openship") {
    throw new ForbiddenError(
      "The Openship control plane updates itself — run the CLI upgrade, not a redeploy.",
    );
  }
  // GitHub access gate (default-deny): a member can redeploy a
  // GitHub-backed project only when granted this repo.
  await assertGitHubRepoAccess(ctx, {
    owner: project.gitOwner,
    repo: project.gitRepo,
  });
  const resolvedBranch = await resolveProjectBranch(ctx, project, oldDep.branch ?? undefined);

  // Prefer the old deployment's snapshot; fall back to a fresh one from the project
  const frozenMeta = oldDep.meta as DeploymentConfigSnapshot | null;
  const meta = frozenMeta ?? buildConfigSnapshot(project, resolvedBranch);
  const branch = meta.branch || resolvedBranch;

  if (!frozenMeta) {
    const t = await resolveSnapshotTarget(project);
    meta.deployTarget = t.deployTarget;
    meta.serverId = t.serverId;
    meta.runtimeMode = t.runtimeMode;
    meta.buildStrategy = await settingsService.resolveStrategy(meta.framework, meta.buildStrategy, {
      deployTarget: meta.deployTarget,
    });
  }

  // Release/dist source: refresh the resolved dist dir. useExistingCommit →
  // redeploy the SAME version; default → newest advertised (parity with the
  // "redeploy latest commit" semantics below). Re-resolving also guards against
  // a frozen snapshot whose cached dist dir was since pruned.
  if (isReleaseProvider(project.gitProvider)) {
    await applyReleaseSourceToSnapshot(project, meta, {
      version: opts?.useExistingCommit ? frozenMeta?.releaseVersion : undefined,
    });
  }

  // Two redeploy modes:
  //   default            — rebuild against the LATEST commit on the branch.
  //                        This is "redeploy this branch" semantics; what
  //                        the auto-redeploy hooks and the main deploy UI use.
  //   useExistingCommit  — rebuild against THE SAME commit the old deployment
  //                        used. The dashboard offers this as a fallback when
  //                        an old deployment's artifact has been purged from
  //                        the retention window — gives the user back that
  //                        specific code without a manual git+redeploy dance.
  const { commitSha, commitMessage } =
    opts?.useExistingCommit && oldDep.commitSha
      ? {
          commitSha: oldDep.commitSha,
          commitMessage: oldDep.commitMessage ?? `Redeploy ${oldDep.commitSha.slice(0, 7)}`,
        }
      : await resolveLatestCommitInfo(ctx, project, branch);

  // ── Refresh compose services from current DB state ─────────────────────
  // The old snapshot's `composeServices` is frozen to whatever existed when
  // it was created. If the user added (or disabled) a service since then,
  // the redeploy must see the current shape - otherwise newly-added Postgres
  // / Redis / etc. rows would sit in the DB but never actually deploy.
  //
  // listProjectComposeServices returns BOTH kind="compose" AND
  // kind="monorepo" rows, so this refresh picks up newly-added sub-apps too
  // (e.g. a user adding `apps/admin` to a project that previously had only
  // `apps/web`).
  //
  // We deliberately don't touch `serviceDeploymentMode` - the downstream
  // pipeline gate (shouldUseProjectServicePipeline) re-queries the DB and
  // chooses the right mode regardless. Forcing it here would silently
  // override an explicit user choice on the original deployment.
  // Reconcile upstream compose drift BEFORE reading the rows, so this redeploy
  // picks up repo changes on unedited services (and flags edited ones). See
  // reconcileComposeDrift — best-effort, never blocks.
  await reconcileComposeDrift(ctx, project, branch);

  const currentComposeRows = await listProjectComposeServices(project.id).catch(() => []);
  const currentComposeServices = projectServicesToDeployableServices(
    currentComposeRows.filter((s) => s.enabled),
  );
  const refreshedMeta: DeploymentConfigSnapshot = {
    ...meta,
    composeServices: currentComposeServices.length > 0 ? currentComposeServices : undefined,
  };

  // ── Resolve rollback context (shared helper — single default) ─────────
  const { rollbackStrategy, commitShaBefore } = await resolveRollbackContext(
    project,
    branch,
  );

  // "update" wants a snapshot of the OLD state before the (destructive) tag
  // roll-forward — the safety net for stateful apps (n8n/Ghost/Convex volumes).
  // Redeploy deliberately doesn't (rollback preserves the prior artifact), so
  // this is gated on the caller opting in.
  if (opts?.preDeployBackup) {
    await firePreDeployBackups({
      projectId: project.id,
      organizationId: project.organizationId,
    }).catch(() => {});
  }

  const dep = await createQueuedDeployment({
    projectId: project.id,
    organizationId: project.organizationId,
    branch,
    commitSha,
    commitMessage,
    trigger: opts?.trigger ?? "redeploy",
    environment: oldDep.environment,
    framework: oldDep.framework || refreshedMeta.framework,
    meta: metaWithPrevious(refreshedMeta, project),
    envVars: oldDep.envVars as Record<string, string> | null,
    rollbackStrategy,
    commitShaBefore,
  });

  // Kick off the actual build. Without this, the new deployment row would
  // sit in "queued" status forever - the main deploy UI worked around this
  // by following up with POST /:id/build, but the dashboard's auto-redeploy
  // call sites (ServicesTab, ServiceDetailPanel) don't, and end-users see
  // a stuck "Queued" pill. startBuild is idempotent (see its guard below),
  // so the main UI's follow-up POST is a no-op instead of an error.
  await kickoffBuild(project, dep);

  return {
    success: true,
    deployment_id: dep.id,
    project_id: project.id,
  };
}

export async function startBuild(deploymentId: string) {
  const { dep, project } = await loadDeployment(deploymentId);

  // Idempotent for already-running / completed deployments. redeploy now
  // auto-triggers the build, but the existing main-deploy UI still POSTs
  // /:id/build right after to attach its SSE stream - we want that POST to
  // succeed (so SSE attaches to the running session) instead of 400'ing.
  // Terminal states (ready/failed/cancelled) are also "do nothing, return ok".
  if (["building", "deploying", "ready", "failed", "cancelled"].includes(dep.status)) {
    return {
      success: true,
      deployment_id: dep.id,
      project_id: project.id,
      alreadyStarted: true as const,
    };
  }

  if (!["queued"].includes(dep.status)) {
    throw new ForbiddenError(`Build session is in an unexpected state: ${dep.status}`);
  }

  const buildSessionId = await kickoffBuild(project, dep);
  if (!buildSessionId) throw new NotFoundError("BuildSession for deployment", deploymentId);

  return {
    success: true,
    deployment_id: dep.id,
    project_id: project.id,
  };
}

export async function triggerDeployment(
  ctx: RequestContext,
  data: {
    projectId: string;
    branch?: string;
    commitSha?: string;
    commitMessage?: string;
    environment?: string;
    trigger?: string;
    /**
     * Smart per-service deploy: when provided, only these services are
     * (re)built. Other enabled services are still tracked as
     * `service_deployment` rows with `status='skipped'` so the project
     * has a complete fan-out record for this deployment.
     */
    serviceIds?: string[];
    /**
     * How the rollback artifact for THIS deployment is preserved.
     * `'snapshot'` (default) → archive image + workspace.
     * `'git'`               → no artifact archive; rollback re-clones
     *                         at `commitShaBefore` and rebuilds.
     */
    rollbackStrategy?: "snapshot" | "git";
    /**
     * Commit SHA that was active BEFORE this deploy — the git-strategy
     * rollback target. Required for `rollbackStrategy: 'git'`.
     */
    commitShaBefore?: string;
    /**
     * Force a rebuild of every enabled service even if its root
     * directory's files didn't change. Set by the dashboard toggle, by
     * commit-message tokens (`[force]`, `[force-deploy]`,
     * `[redeploy-all]`), and by config-touch detection.
     */
    forceAll?: boolean;
    /**
     * Repo-root-relative paths changed in this push (webhook only). Passed to
     * the compose-drift reconciler so it can skip the repo scan when the compose
     * file wasn't among them. Absent on manual triggers → reconcile runs.
     */
    changedPaths?: string[] | null;
    /**
     * Smart per-service routing for a MANUAL multi-service redeploy: trace the
     * files changed between the active deployment's commit and the new HEAD and
     * rebuild ONLY the affected services (same detection the webhook uses). Used
     * by the dashboard "Redeploy" button. Falls back to a full rebuild for
     * single-app projects, same-commit / config-only redeploys, or when the
     * diff can't be determined. Ignored when forceAll/serviceIds is set.
     */
    smartRoute?: boolean;
    /**
     * ATOMIC redeploy of a PAST deployment's exact config + env (git-strategy
     * rollback). When set, the new deployment ships this frozen snapshot + env
     * VERBATIM instead of rebuilding from the project's current (mutable)
     * columns / env_var table — so a rollback runs exactly what originally ran,
     * even if the project config or env changed since. Leave undefined for a
     * normal deploy (fresh snapshot from the project).
     */
    reuseSnapshot?: {
      meta: DeploymentConfigSnapshot;
      envVars: Record<string, string> | null;
    };
    /**
     * REFRESH: re-apply the current runtime env to the active deployment
     * WITHOUT pulling a new commit or rebuilding. Recreates the env-changed
     * services (or all enabled if none are dirty) from their EXISTING images.
     * Reuses the active deployment's commit — never touches git or the image
     * builder. Dashboard "Refresh" button.
     */
    refresh?: boolean;
    /**
     * Release/dist source: deploy THIS specific version (the `release` webhook
     * passes the published tag). Omitted for a manual redeploy, which re-resolves
     * the newest advertised version. Ignored for non-release projects.
     */
    releaseVersion?: string;
  },
) {
  const project = await repos.project.findById(data.projectId);
  if (!project) {
    throw new NotFoundError("Project", data.projectId);
  }
  // The Openship control plane IS the running host service, not a redeployable
  // workload — it updates itself via the CLI. It's a release-provider project, so
  // the git/localPath 403 below would NOT catch it; guard it explicitly.
  if (project.appTemplateId === "openship") {
    throw new ForbiddenError(
      "The Openship control plane updates itself — run the CLI upgrade, not a redeploy.",
    );
  }
  // Org-membership verified at the route boundary. No userId equality
  // check here — that would block team members.

  // A release/dist-source project has neither a git URL nor a stored localPath —
  // its dist dir is resolved per-deploy by applyReleaseSourceToSnapshot below.
  if (!project.gitUrl && !project.localPath && !isReleaseProvider(project.gitProvider)) {
    throw new ForbiddenError("Project has no git repository or local path configured");
  }
  // GitHub access gate (default-deny; webhook ctx is the org owner and
  // passes). Covers manual trigger / redeploy paths routed through here.
  await assertGitHubRepoAccess(ctx, {
    owner: project.gitOwner,
    repo: project.gitRepo,
  });

  const branch = await resolveProjectBranch(ctx, project, data.branch);
  const environment = data.environment ?? "production";

  // Skip an auto (webhook) deploy whose commit is already in-flight or live —
  // closes the App + repo-webhook double-deploy window. Manual/forceAll bypass.
  if (data.trigger === "webhook" && !data.forceAll && data.commitSha) {
    const inFlight = await repos.deployment
      .findInProgressByCommit(project.id, data.commitSha)
      .catch(() => undefined);
    const active = project.activeDeploymentId
      ? await repos.deployment.findById(project.activeDeploymentId).catch(() => null)
      : null;
    const existing = inFlight ?? (active?.commitSha === data.commitSha ? active : null);
    if (existing) {
      console.log(
        `[Deploy] project ${project.id}: webhook deploy for ${data.commitSha} skipped — already ${inFlight ? "in progress" : "live"} (${existing.id}).`,
      );
      return { deployment: existing, skipped: true as const };
    }
  }

  await checkNoActiveBuild(project.id);

  // Reconcile upstream compose drift before the pipeline reads service rows —
  // covers webhook (git push) + manual triggers. Skip atomic rollback: it must
  // ship the frozen snapshot verbatim. `changedPaths` (webhook) lets it skip the
  // repo scan when the push didn't touch the compose file. Best-effort; never blocks.
  if (!data.reuseSnapshot && data.trigger !== "rollback") {
    await reconcileComposeDrift(ctx, project, branch, data.changedPaths);
  }

  // ATOMIC rollback path: reuse the target deployment's frozen snapshot verbatim
  // (its build config was already resolved + valid at original-deploy time).
  // Normal path: build a fresh snapshot from the project's current columns.
  const reuse = data.reuseSnapshot;
  const snapshot = reuse
    ? ({ ...reuse.meta } as DeploymentConfigSnapshot)
    : buildConfigSnapshot(project, branch);
  const routeState = await resolveProjectRouteState(project);

  // Resolve the snapshot's target (deployTarget + serverId + runtimeMode) from
  // the single source of truth shared with requestBuildAccess. buildConfigSnapshot
  // only knows cloud-vs-undefined (it can't see which server a self-hosted project
  // last deployed to — that lives in the deployment meta), so without this a
  // redeploy/webhook of a self-hosted *server* project loses its target and, on a
  // SaaS instance, defaults to cloud → wrong cloud preflight → 403. The resolver
  // gates serverId on target==="server" so a non-server deploy can't carry a stale
  // serverId. (reuse/rollback already carries the frozen target — leave it.)
  if (!reuse) {
    const resolvedTarget = await resolveSnapshotTarget(project);
    snapshot.deployTarget = resolvedTarget.deployTarget;
    snapshot.serverId = resolvedTarget.serverId;
    snapshot.runtimeMode = resolvedTarget.runtimeMode;
  }

  // Release/dist source: resolve the version (webhook-supplied tag, else newest)
  // → prebuilt dist dir → snapshot.localPath, no build. A reused (rollback)
  // snapshot already froze its localPath + releaseVersion, so leave it untouched.
  if (!reuse && isReleaseProvider(project.gitProvider)) {
    await applyReleaseSourceToSnapshot(project, snapshot, { version: data.releaseVersion });
  }

  if (!reuse) {
    // Non-UI callers (CI, webhook, manual API) don't pass buildStrategy, so the
    // snapshot inherits `undefined` from buildConfigSnapshot and the later
    // fallback at resolveBuildGitToken collapses everything to "server". Run
    // it through resolveStrategy so a non-cloud stack with a "local" default
    // gets the same answer the UI would give — single source of truth. A reused
    // snapshot already froze its resolved strategy, so leave it untouched.
    snapshot.buildStrategy = await settingsService.resolveStrategy(
      snapshot.framework,
      snapshot.buildStrategy,
      { deployTarget: snapshot.deployTarget },
    );
  }

  const { useServicePipeline, servicePreflightServices } = await resolveServicePipelineMode(
    project,
    snapshot,
  );

  // ── Preflight: validate config before creating any resources ────
  await runDeploymentPreflight(snapshot, routeState, {
    ctx,
    composeServices: servicePreflightServices,
    multiService: useServicePipeline,
    gitOwner: project.gitOwner,
    projectId: project.id,
  });

  // Env: a reused snapshot ships the EXACT encrypted env captured with the
  // target deployment (atomic rollback); a fresh deploy reads the project's
  // current (already-encrypted) env_var table.
  let encryptedEnvVars: Record<string, string> | null;
  if (reuse) {
    encryptedEnvVars = reuse.envVars;
  } else {
    const rawEnvMap = await repos.project.getEnvMap(project.id, environment);
    encryptedEnvVars = Object.keys(rawEnvMap).length > 0 ? rawEnvMap : null;
  }

  // ── Resolve commit info: fetch HEAD from GitHub if not provided ────
  let commitSha = data.commitSha;
  let commitMessage = data.commitMessage;
  if (data.refresh) {
    // Refresh recreates the running containers with current env — it never
    // pulls new code or builds. Reuse the active deployment's commit if it has
    // one (for display/versioning), but DON'T require it: a local/compose
    // project may carry no commit, and refresh doesn't need one. Only require
    // that something is actually deployed to refresh.
    const active = project.activeDeploymentId
      ? await repos.deployment.findById(project.activeDeploymentId).catch(() => null)
      : null;
    if (!active) {
      throw new Error("Nothing to refresh yet — deploy the project first.");
    }
    commitSha = active.commitSha ?? commitSha;
    commitMessage = commitMessage ?? active.commitMessage ?? undefined;
  }
  // Fetch HEAD only for a real (build) deploy — a refresh must never touch git.
  if (!commitSha && !data.refresh) {
    const head = await resolveLatestCommitInfo(ctx, project, branch);
    commitSha = head.commitSha;
    commitMessage = commitMessage ?? head.commitMessage;
  }

  // ── Resolve rollback context (shared helper — single default) ─────────
  // Explicit caller arg wins so the git-strategy rollback path can flip on a
  // per-rollback basis even when the project default is "snapshot".
  const { rollbackStrategy, commitShaBefore } = await resolveRollbackContext(project, branch, {
    rollbackStrategy: data.rollbackStrategy,
    commitShaBefore: data.commitShaBefore,
  });
  // ── Smart per-service routing (manual multi-service redeploy) ─────────
  // Resolve which services to (re)build via the shared helper — the one
  // resolution concern that mirrors the other resolveX helpers. Inert unless
  // smartRoute is set and the caller hasn't already targeted services / this
  // isn't a reuse rollback. See resolveSmartRoute for the fallback policy.
  const {
    forceAll: resolvedForceAll,
    serviceIds: resolvedServiceIds,
    changedPaths: resolvedChangedPaths,
  } = await resolveSmartRoute(ctx, project, {
    smartRoute: data.smartRoute,
    forceAll: data.forceAll,
    serviceIds: data.serviceIds,
    isReuse: !!reuse,
    commitSha,
    commitShaBefore,
  });

  // ── Env-only refresh: when the router picked a code-changed subset, ALSO
  //    recreate env-changed services with fresh env but WITHOUT rebuilding.
  //    Strictly ADDITIVE — it only adds services to the deploy set (never
  //    removes), so a missed detection can't drop a real rebuild and a false
  //    positive merely recreates a container. A forceAll deploy (same OR
  //    different commit) stays a full rebuild — env applies through it, and the
  //    dedicated Refresh action is the surgical env-only path. Only on the
  //    smart-redeploy path (not an explicit/forced/reuse deploy). ──
  let finalForceAll = resolvedForceAll;
  let finalServiceIds = resolvedServiceIds;
  let refreshServiceIds: string[] | undefined;
  if (data.smartRoute && !data.forceAll && !data.serviceIds?.length && !reuse) {
    const envDirty = await resolveEnvDirtyServiceIds(project, environment);
    if (envDirty && envDirty.size > 0 && !finalForceAll && finalServiceIds) {
      // Code-changed subset + env-only services → deploy the union; the
      // env-only ones (not code-changed) refresh without a rebuild.
      const codeChanged = new Set(finalServiceIds);
      refreshServiceIds = [...envDirty].filter((id) => !codeChanged.has(id));
      finalServiceIds = [...new Set([...finalServiceIds, ...envDirty])];
    }
  }

  // ── Refresh override: recreate services from their existing images with
  //    current env, no build/clone. Targets env-changed services (respects a
  //    running DB when only an app service's env changed); falls back to all
  //    enabled so the button always re-applies config. Every targeted service
  //    is ALSO a refresh service → excluded from the build → empty buildable →
  //    the build phase (and its clone) is skipped entirely. ──
  if (data.refresh) {
    const enabledIds = (await repos.service.listByProject(project.id).catch(() => []))
      .filter((s) => s.enabled)
      .map((s) => s.id);
    // Target precedence: explicit serviceIds (per-service refresh from the UI)
    // → env-changed services (surgical, leaves a running DB alone) → all
    // enabled (single-app, or a manual "refresh everything").
    let target: string[];
    if (data.serviceIds && data.serviceIds.length > 0) {
      target = data.serviceIds.filter((id) => enabledIds.includes(id));
    } else {
      const envDirty = await resolveEnvDirtyServiceIds(project, environment);
      target = envDirty && envDirty.size > 0 ? [...envDirty] : enabledIds;
    }
    // An empty target must NOT fall through: createQueuedDeployment only writes
    // targetServiceIds/refreshServiceIds when non-empty, so an empty set would
    // leave forceAll=false with no subset → the compose build treats it as
    // "build everything" and re-clones — the exact opposite of a refresh. Fail
    // loudly instead.
    if (target.length === 0) {
      throw new Error("Nothing to refresh — no enabled services to re-apply config to.");
    }
    finalForceAll = false;
    finalServiceIds = target;
    refreshServiceIds = target;
  }

  const dep = await createQueuedDeployment({
    projectId: project.id,
    organizationId: project.organizationId,
    branch,
    commitSha,
    commitMessage,
    trigger: data.trigger ?? "manual",
    environment,
    framework: snapshot.framework,
    meta: metaWithPrevious(snapshot, project),
    envVars: encryptedEnvVars,
    rollbackStrategy,
    commitShaBefore,
    forceAll: finalForceAll,
    serviceIds: finalServiceIds,
    refreshServiceIds,
    changedPaths: resolvedChangedPaths ?? null,
  });

  const buildSessionId = await kickoffBuild(project, dep);
  if (!buildSessionId) throw new Error("Build session was not created");

  return {
    deployment: dep,
  };
}
