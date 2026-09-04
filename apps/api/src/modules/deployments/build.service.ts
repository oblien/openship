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
  compareCommitSha,
  getRuntimeImage,
  isFullCommitSha,
  isReleaseProvider,
  releaseArtifactKind,
  renderReleaseImage,
  looksLikeSecretKey,
  resolveProjectVolumes,
  type StackId,
  type DeployTarget,
  type BuildStrategy,
  type StackDefinition,
  type ReleaseSource,
  type SourceKind,
  type BuildKind,
  type WorkloadType,
  type OpenshipEnv,
} from "@repo/core";
import type { LogEntry, ResourceConfig } from "@repo/adapters";
import { resolveCloudResourceConfig } from "./cloud-resources";
import { resolveEnvDirtyServiceIds } from "./env-drift";
import type { TBuildAccessBody } from "./deployment.schema";
import { platform } from "../../lib/controller-helpers";
import { decryptEnvMap, encrypt } from "../../lib/encryption";
import { getCommitByRef, getLatestCommit, getRepository, resolveLatestMatchingTagCommit } from "../github/github.service";
import { assertGitHubRepoAccess } from "../github/github-access";
import { resolveSmartRoute } from "./smart-route";
import { snapshotNeedsGitSource, withoutPinnedArtifacts } from "./pinned-artifacts";
import { deploymentWorkload, projectToClass, snapshotToClass } from "./deployment-class";
import {
  resolveProjectInfo,
  resolveProjectSourceEnv,
  type ProjectInfo,
  type ProjectSourceEnv,
} from "./prepare.service";
import { ComposeConfigurationError } from "./compose-configuration-error";
import { getFolderSession } from "../projects/folder/session-store";
import { hasMaskedValue, isMaskedValue, unmaskEnv } from "../../lib/secret-env";
import { assertValidCustomDomains, customHostnamesOf } from "../../lib/custom-domain-guard";
import {
  assertBuildMinutesAvailable,
  assertPlanAllowsDeployShape,
  assertPlanAllowsResourceTier,
} from "../../lib/plan-guard";
import { type RequestContext } from "../../lib/request-context";
import { type PortCheckResult } from "../../lib/deployment-runtime";
import { requireOrgServer } from "../../lib/server-target";
import * as sessionManager from "./session-manager";
import {
  requestDeploymentCancellation,
  waitForDeploymentQuiescence,
} from "./deployment-cancellation";
import {
  collectDeploymentManifest,
  executeCleanup,
  type CleanupManifest,
} from "../projects/project-cleanup.service";
import { runPreflightChecks, PREFLIGHT_ERROR_CODES, type PreflightResult } from "./preflight";
import {
  isMultiServiceProject,
  listProjectComposeServices,
  projectServicesToDeployableServices,
  shouldUseProjectServicePipeline,
} from "./compose";
import * as settingsService from "../settings/settings.service";
import { type DeployableService, serviceKind } from "../../lib/deployable-service";
import {
  listProjectRouteRows,
  resolveProjectRouteState,
  syncProjectRouteState,
} from "../domains/project-route.service";
import { kickoffBuild, resolveServicePipelineMode } from "./build-pipeline";
import { assertExactServiceTargets } from "./exact-service-targets";
import {
  resolveReleaseDist,
  resolveReleaseVersion,
  ReleaseVersionUnavailableError,
} from "../../lib/release-resolver";
import { commitSourceKey, projectBranch } from "../projects/project-crud.service";
import { env } from "../../config";

function throwPreflightFailure(preflight: PreflightResult): never {
  const failedChecks = preflight.checks.filter((check) => check.status === "fail");
  const failures = failedChecks.map((check) => `${check.label}: ${check.message}`).join("; ");
  const codes = Array.from(
    new Set(
      failedChecks.map((check) => check.code).filter((code): code is string => Boolean(code)),
    ),
  );
  // A github-credential failure is ACTIONABLE — the dashboard maps these codes
  // to the DeployCredentialModal (install App / add token / connect server /
  // build local). Surface one even when other checks also failed, so the user
  // gets the modal instead of a generic "checks failed" toast.
  const CREDENTIAL_CODES: string[] = [
    PREFLIGHT_ERROR_CODES.GITHUB_CLI_REMOTE_BUILD_REJECTED,
    PREFLIGHT_ERROR_CODES.GITHUB_REMOTE_TOKEN_REQUIRED,
    PREFLIGHT_ERROR_CODES.GITHUB_APP_INSTALLATION_REQUIRED,
  ];
  const credentialCode = CREDENTIAL_CODES.find((c) => codes.includes(c));
  const errorCode =
    credentialCode ??
    (codes.length === 1 && failedChecks.every((check) => check.code === codes[0])
      ? codes[0]
      : "PRE_DEPLOY_CHECKS_FAILED");

  throw new AppError(`Pre-deploy checks failed: ${failures}`, 403, errorCode);
}

/** Wrap a snapshot with the project's currently-active deployment id (rollback target). */
export function metaWithPrevious(
  snapshot: DeploymentConfigSnapshot,
  project: Project,
): DeploymentConfigSnapshot {
  return {
    ...snapshot,
    previousActiveDeploymentId: project.activeDeploymentId ?? undefined,
    envCapture: "flat-v1",
  };
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
    /** Catalog app this project instantiates + whether it has ever been live, so
     *  the app's declared host minimum is matched against the target machine. */
    appTemplateId?: string | null;
    firstDeploy?: boolean;
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
    ...(opts.appTemplateId !== undefined ? { appTemplateId: opts.appTemplateId } : {}),
    ...(opts.firstDeploy !== undefined ? { firstDeploy: opts.firstDeploy } : {}),
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
  /** Resolved persistent mounts (compose syntax) — the project's declaration or
   *  the stack default. Snapshotted so a redeploy of an OLD deployment mounts
   *  what that deployment mounted, not what the project says today. */
  volumes: string[];
  rootDirectory: string;
  port: number;
  startCommand: string;
  resources: ResourceConfig | null;
  buildResources: ResourceConfig | null;
  /** Whether the project needs a running server (false = static, deploy via Pages) */
  hasServer: boolean;
  /** Whether the project needs a build step (false = deploy source directly) */
  hasBuild: boolean;
  /**
   * Deployment class frozen at request time (issue #538). The three orthogonal
   * axes every downstream reads via `snapshotToClass` — source (clone-or-not),
   * build (how the artifact is produced), workload (web / worker / static).
   * Absent on snapshots frozen before #538; `snapshotToClass` then derives them
   * from the legacy fields above, so rollback of an old release stays correct.
   */
  source?: SourceKind;
  build?: BuildKind;
  workload?: WorkloadType;
  /** Absolute path to a local project directory (alternative to repoUrl) */
  localPath?: string;
  /**
   * Release source (gitProvider === "release"). Resolved by
   * `applyReleaseSourceToSnapshot` in the async entry points: the semver plus
   * either an extracted archive (`localPath`) or a concrete registry image
   * (`releaseImageRef`). Captured so history, rollback, and drift all share the
   * same stable anchor; neither artifact runs a source build.
   */
  releaseVersion?: string;
  /** Raw upstream tag (for example `v1.2.3`). Kept separately from the
   * normalized releaseVersion so an image template using `{tag}` is stable. */
  releaseTag?: string;
  /** Concrete prebuilt image selected for this release. This is deliberately
   * separate from buildImage, which is the builder used for source builds. */
  releaseImageRef?: string;
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
  /** PINNED ARTIFACTS: serviceName → an already-present image ref that deploys
   *  verbatim (no build, no pull). Two producers: the migration cutover's
   *  one-time handover, and a rollback restoring a past release's retained
   *  images. A plain Redeploy strips them so it rebuilds natively. Read through
   *  `pinned-artifacts.ts`, consumed by buildComposeImages. */
  handoverImages?: Record<string, string>;
  /** Single-app twin of `handoverImages` — the whole release is this one image.
   *  Set by a rollback restore; consumed by the single-app build phase. */
  handoverAppImage?: string;
  /** Env-only refresh of a single app. Reuse this active deployment's retained
   * artifact and fail closed if it is unavailable — never fall into a rebuild. */
  refreshAppDeploymentId?: string;
  /** STATIC twin: a retained release DIRECTORY on the host to promote again
   *  (static releases have no image). Set by a rollback restore. */
  handoverStaticDir?: string;
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
  /**
   * Where this release SERVES its static files from, relative to its release
   * root. Written by the deploy pipeline; documented on `DeploymentMeta`, which
   * is the same `deployment.meta` blob viewed from the read side.
   *
   * Declared here because the snapshot view READS it back: a rollback that
   * reuses this release's pinned directory must serve the doc-root the files
   * were actually extracted into, which cannot be recomputed (a self-hosted
   * static builds in a Docker sandbox but persists `runtimeMode: "bare"`). See
   * `reusedReleaseRouting`.
   */
  staticServeOutputDir?: string;
  previousActiveDeploymentId?: string;
  /**
   * Shape of this row's `envVars` capture. `"flat-v1"` = one unscoped
   * `Record<key, encryptedValue>` with no service scoping and no provenance, so
   * a key that was project-scoped at capture is indistinguishable from a
   * service-scoped one. A rollback replays this map over every service (see
   * `frozenEnvWins`), and the restore-plan diff marks affected keys
   * `scopeAmbiguous` for exactly that reason. Absent on rows written before this
   * field existed — which are also flat-v1; the stamp exists so a future scoped
   * capture can be told apart without guessing.
   */
  envCapture?: "flat-v1";
  /**
   * Smart per-service target list. When set, only these service ids
   * are (re)built; others are recorded as `service_deployment` rows
   * with `status='skipped'` so the fan-out has a complete record.
   */
  targetServiceIds?: string[];
  /** Force registry-backed images to be pulled even when the same mutable tag
   * already exists locally. This is deployment intent, not durable project
   * configuration, and is cleared when a snapshot is reused. */
  forcePullImages?: boolean;
  /**
   * `targetServiceIds` is an EXCLUSIVE scope, not just a build subset: a service outside
   * it is never deployed, never failed and never reaped.
   *
   * Without it, an untargeted service is only spared if the deploy can CARRY it forward —
   * which reads `project.activeDeploymentId`, so a project with no previous release cannot
   * carry anything and the "spared" service is deployed normally. A migration reusing
   * already-running containers in place needs the stronger guarantee: it has no previous
   * deployment at that moment, and deploying one of those rows would put a SECOND
   * container on the original's bare volumes.
   */
  strictServiceScope?: boolean;
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
export function buildConfigSnapshot(project: Project, branch?: string): DeploymentConfigSnapshot {
  const deploymentClass = projectToClass(project);

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
    runtimeImage: resolveRuntimeImage(project),
    packageManager: project.packageManager!,
    installCommand: project.installCommand!,
    buildCommand: project.buildCommand!,
    outputDirectory: project.outputDirectory!,
    productionPaths: parseProductionPaths(project.productionPaths, project.framework),
    volumes: resolveProjectVolumes(project.volumes as string[] | null, project.framework),
    rootDirectory: project.rootDirectory || "",
    port: project.port ?? 3000,
    startCommand: project.startCommand!,
    resources: (project.resources as ResourceConfig) || null,
    buildResources: (project.buildResources as ResourceConfig) || null,
    hasServer: project.hasServer ?? !!project.startCommand?.trim(),
    hasBuild: project.hasBuild ?? true,
    // Freeze the resolved three-axis class once (issue #538). Downstream reads
    // it via snapshotToClass and never re-derives — a redeploy of THIS release
    // classifies as it did the day it was built, even after the project's flags
    // change.
    ...deploymentClass,
    localPath: deploymentClass.source === "upload" ? project.localPath || undefined : undefined,
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
 * Resolve a release-source project (`gitProvider === "release"`) into one
 * explicit frozen artifact. Archive releases resolve to a local directory;
 * image releases render a concrete registry reference. `buildImage` is never
 * touched: it configures source-build sandboxes and is not a deploy artifact.
 *
 * Version precedence lives in resolveReleaseVersion: explicit webhook/redeploy
 * tag → pinnedVersion → newest advertised. There is intentionally no fallback
 * to OpenShip's own package version for arbitrary projects.
 *
 * Mutates `snapshot` in place and returns the resolved semver (no leading "v").
 */
export async function applyReleaseSourceToSnapshot(
  project: Project,
  snapshot: DeploymentConfigSnapshot,
  opts?: { version?: string },
): Promise<string> {
  const source = (project.releaseSource as ReleaseSource | null) ?? null;
  if (!source) {
    throw new AppError(
      `Project ${project.id} has gitProvider "release" but no releaseSource configured.`,
      400,
      "RELEASE_SOURCE_MISSING",
    );
  }

  let release: Awaited<ReturnType<typeof resolveReleaseVersion>>;
  try {
    release = await resolveReleaseVersion(source, { version: opts?.version });
  } catch (err) {
    if (err instanceof ReleaseVersionUnavailableError) {
      throw new AppError(err.message, 424, "RELEASE_VERSION_UNAVAILABLE");
    }
    throw err;
  }

  if (releaseArtifactKind(source) === "image") {
    if (snapshotToClass(snapshot).workload === "static") {
      throw new AppError(
        "A prebuilt container image must run as a web app or worker, not a static-file deployment.",
        400,
        "RELEASE_IMAGE_STATIC_UNSUPPORTED",
      );
    }
    snapshot.releaseImageRef = renderReleaseImage(source.imageTemplate!, release);
    snapshot.releaseVersion = release.version;
    snapshot.releaseTag = release.tag;
    snapshot.releaseRepo = source.mode === "github" ? source.repo : undefined;
    snapshot.releaseAsset = undefined;
    snapshot.repoUrl = "";
    snapshot.localPath = undefined;
    snapshot.installCommand = "";
    snapshot.buildCommand = "";
    snapshot.hasBuild = false;
    snapshot.source = "image";
    snapshot.build = "prebuilt";
    if (!project.cloudWorkspaceId) snapshot.runtimeMode = "docker";
    return release.version;
  }

  // Archive resolution downloads + extracts onto this control plane. Registry
  // images do not, so only this legacy artifact kind is unavailable in SaaS.
  if (env.CLOUD_MODE) {
    throw new ForbiddenError("Release archive projects are not available in cloud mode");
  }

  const result = await resolveReleaseDist({
    name: project.slug || project.id,
    version: release.version,
    source,
  });

  // Deploy the prebuilt dist as-is: point localPath at it, drop any git repo,
  // and never build. Install still runs iff the project keeps hasBuild=true
  // (install-only apps like webmail); a pure static/binary dist sets hasBuild=false.
  snapshot.localPath = result.dir;
  snapshot.repoUrl = "";
  snapshot.buildCommand = "";
  snapshot.releaseVersion = result.version;
  snapshot.releaseTag = release.tag;
  snapshot.releaseImageRef = undefined;
  snapshot.releaseAsset = result.asset;
  snapshot.releaseRepo = source.mode === "github" ? source.repo : undefined;
  return result.version;
}

async function resolveLatestCommitInfo(ctx: RequestContext, project: Project, branch: string) {
  if (!project.gitOwner || !project.gitRepo) {
    return {};
  }

  let head: { sha: string; message: string } | null = null;
  if (
    branch.startsWith("refs/tags/") ||
    branch.startsWith("tags/") ||
    (branch.includes("*") && !branch.startsWith("refs/heads/") && !branch.startsWith("heads/"))
  ) {
    head = await resolveLatestMatchingTagCommit(ctx, project.gitOwner, project.gitRepo, branch).catch(() => null);
  }
  if (!head) {
    head = await getLatestCommit(ctx, project.gitOwner, project.gitRepo, branch);
  }
  if (head?.sha && branch === projectBranch(project)) {
    try {
      await repos.updateStatus.upsert({
        organizationId: project.organizationId,
        projectId: project.id,
        kind: "commit",
        checkedAt: new Date(),
        detail: {
          key: commitSourceKey(project),
          latestSha: head.sha,
          latestMessage: head.message ?? null,
        },
      });
    } catch {
      // Cache persistence is best-effort; a deploy must not fail after GitHub
      // already returned a usable commit merely because this write failed.
    }
  }
  return head ? { commitSha: head.sha, commitMessage: head.message } : {};
}

/**
 * Canonicalize a caller-supplied commit ref to the commit's full sha.
 *
 * `POST /deployments` takes `commitSha` as a free string — `openship deploy
 * --commit 1eeaf76`, the MCP deploy tool, a CI script — and git checks out
 * anything it is given, so an abbreviated sha builds exactly the right code while
 * the row records a name nothing downstream can match by value: the drift check
 * compares it against a 40-char branch HEAD (which is how a project deployed at
 * `1eeaf76` ends up being offered `1eeaf76` as a new commit, permanently), the
 * commit-status API rejects a short sha outright, and the in-flight webhook dedupe
 * misses. Resolved ONCE here, before anything compares or stores it.
 *
 * Fail-soft: an unresolvable ref (no GitHub repo, no credential, rate limit) is
 * kept verbatim. The deploy still knows how to check it out; only the bookkeeping
 * is less precise, and that is not worth failing a deploy over.
 */
async function canonicalizeCommitRef(
  ctx: RequestContext,
  project: Project,
  ref: string | undefined,
): Promise<string | undefined> {
  const trimmed = ref?.trim();
  if (!trimmed || isFullCommitSha(trimmed)) return trimmed;
  if (!project.gitOwner || !project.gitRepo) return trimmed;
  const found = await getCommitByRef(ctx, project.gitOwner, project.gitRepo, trimmed).catch(
    () => null,
  );
  return found?.sha ?? trimmed;
}

async function resolveProjectBranch(ctx: RequestContext, project: Project, branch?: string) {
  const configuredBranch = branch?.trim() || project.gitBranch?.trim();
  if (configuredBranch) {
    if (
      project.gitOwner &&
      project.gitRepo &&
      (configuredBranch.startsWith("refs/tags/") ||
        configuredBranch.startsWith("tags/") ||
        (configuredBranch.includes("*") && !configuredBranch.startsWith("refs/heads/") && !configuredBranch.startsWith("heads/")))
    ) {
      const match = await resolveLatestMatchingTagCommit(ctx, project.gitOwner, project.gitRepo, configuredBranch).catch(() => null);
      if (match?.tag) return match.tag;
    }
    return configuredBranch;
  }

  if (project.gitOwner && project.gitRepo) {
    const repository = await getRepository(ctx, project.gitOwner, project.gitRepo);
    return repository.default_branch;
  }

  return "main";
}

function withComposeImageSource(
  service: DeployableService,
  source: Pick<DeployableService, "image" | "advanced">,
): DeployableService {
  const advanced = { ...(service.advanced ?? {}) };
  const imageTemplate = source.advanced?.imageTemplate;
  if (imageTemplate) {
    // Copy the unresolved-variable array too: this becomes release metadata and
    // must not share mutable request/session state with a later scan.
    advanced.imageTemplate = {
      expression: imageTemplate.expression,
      unresolvedVariables: [...imageTemplate.unresolvedVariables],
      ...(imageTemplate.sourceValue !== undefined && { sourceValue: imageTemplate.sourceValue }),
    };
  } else {
    delete advanced.imageTemplate;
  }

  return {
    ...service,
    image: source.image,
    ...(Object.keys(advanced).length > 0 ? { advanced } : { advanced: undefined }),
  };
}

/** Copy the source-owned Docker build arguments and their interpolation marker
 * without replacing unrelated advanced settings edited in the wizard. */
function withComposeBuildArgsSource(
  service: DeployableService,
  source: Pick<DeployableService, "buildArgs" | "advanced">,
): DeployableService {
  const advanced = { ...(service.advanced ?? {}) };
  if (Object.hasOwn(source.advanced ?? {}, "buildArgTemplateKeys")) {
    advanced.buildArgTemplateKeys = [...(source.advanced?.buildArgTemplateKeys ?? [])];
  } else {
    delete advanced.buildArgTemplateKeys;
  }

  return {
    ...service,
    buildArgs: source.buildArgs ? { ...source.buildArgs } : undefined,
    ...(Object.keys(advanced).length > 0 ? { advanced } : { advanced: undefined }),
  };
}

function withComposeBuildSource(
  service: DeployableService,
  source: Pick<DeployableService, "image" | "buildArgs" | "advanced">,
): DeployableService {
  return withComposeBuildArgsSource(withComposeImageSource(service, source), source);
}

/**
 * A deploy-wizard payload is allowed to own routing/runtime edits, but a fresh
 * source reconciliation owns image/build inputs and their interpolation
 * provenance. Re-attach those fields from the canonical rows so an older
 * browser tab cannot overwrite a just-resolved image or build argument with its
 * scan-time value.
 */
function mergeCanonicalComposeBuildSource(
  requested: DeployableService[],
  canonical: DeployableService[],
): DeployableService[] {
  const byName = new Map(
    canonical
      .filter((service) => serviceKind(service) === "compose")
      .map((service) => [service.name, service]),
  );
  return requested.map((service) => {
    if (serviceKind(service) !== "compose") return service;
    const source = byName.get(service.name);
    return source ? withComposeBuildSource(service, source) : service;
  });
}

/**
 * Folder scans happen before the wizard collects project env. Re-scan the same
 * uploaded bytes with the final deployment env, then replace source-owned build
 * inputs. A caller that actually changed the image after the initial scan keeps
 * that literal override and loses the stale image-template marker; build args
 * have no wizard editor and always come from the refreshed source.
 */
function mergeRefreshedFolderBuildSource(
  current: DeployableService[],
  initialScan: DeployableService[],
  refreshedScan: DeployableService[],
): DeployableService[] {
  const initialByName = new Map(initialScan.map((service) => [service.name, service]));
  const refreshedByName = new Map(refreshedScan.map((service) => [service.name, service]));

  return current.map((service) => {
    if (serviceKind(service) !== "compose") return service;
    const refreshed = refreshedByName.get(service.name);
    if (!refreshed) return service;

    const initial = initialByName.get(service.name);
    if (initial && service.image !== initial.image) {
      // The image changed after scan, so it is operator-owned literal input.
      // Never leave the scan's expression attached to reinterpret that edit.
      return withComposeBuildArgsSource(
        withComposeImageSource(service, { image: service.image, advanced: undefined }),
        refreshed,
      );
    }
    return withComposeBuildSource(service, refreshed);
  });
}

function sameComposeBuildSource(a: DeployableService[], b: DeployableService[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((service, index) => {
    const other = b[index];
    return (
      other?.name === service.name &&
      other.image === service.image &&
      JSON.stringify(other.buildArgs ?? null) === JSON.stringify(service.buildArgs ?? null) &&
      JSON.stringify(other.advanced?.imageTemplate ?? null) ===
        JSON.stringify(service.advanced?.imageTemplate ?? null) &&
      JSON.stringify(other.advanced?.buildArgTemplateKeys ?? null) ===
        JSON.stringify(service.advanced?.buildArgTemplateKeys ?? null)
    );
  });
}

/**
 * Re-parse the project's current docker-compose source and 3-way reconcile it against the
 * stored service rows (repos.service.reconcileFromCompose): services the user
 * hasn't edited auto-update to the repo; edited services are preserved and flagged
 * (`driftSpec`) for review. Existing rows reconcile best-effort. Bootstrapping an
 * explicitly compose-shaped project is strict: a bad/empty declared file must
 * block instead of silently falling through to the generic single-app builder.
 * Non-compose projects are unchanged. GitHub and local-path sources converge on
 * resolveProjectInfo, so deploy has one parser and one 3-way merge policy.
 *
 * `changedPaths` (webhook only) is an optimization: when we have a definite,
 * non-empty changed-file list that does NOT include a compose file, skip drift
 * scans for an already-materialized project. Bootstrap always scans once: an
 * optimization must not leave a declared compose project with zero services.
 * When the list is absent (manual redeploy) or empty, reconcile runs to be safe.
 * Image-only Compose rows also always refresh: old rows cannot prove whether
 * their stored string was authored literally or produced by missing interpolation.
 */
const COMPOSE_PATH_RE = /(^|\/)(docker-compose|compose)\.ya?ml$/i;
function composeCouldHaveChanged(project: Project, changedPaths: string[]): boolean {
  const declared = project.composePath?.trim().replace(/^\.\//, "").replace(/\/$/, "");
  return changedPaths.some((rawPath) => {
    const changed = rawPath.replace(/^\.\//, "");
    // openship.json can itself declare the complete native service set and its
    // buildArgs, so it is a Compose-source change even when no YAML changed.
    if (changed.toLowerCase() === "openship.json") return true;
    if (COMPOSE_PATH_RE.test(changed)) return true;
    if (!declared) return false;
    return changed === declared || changed.startsWith(`${declared}/`);
  });
}

/** A stored baseline written before a newly modeled compose field existed must
 * be normalized once even when the triggering push only changed application
 * code. `buildArgs` is the version marker here: every current `toComposeSpec`
 * writes it (including `{}`), while pre-#689 baselines omit it. A null baseline
 * likewise still needs its first repo reconciliation. */
function composeRowsNeedBaselineUpgrade(
  rows: Array<{ kind?: string | null; importedSpec?: unknown }>,
): boolean {
  return rows.some((row) => {
    if (row.kind !== "compose") return false;
    const baseline = row.importedSpec;
    return !baseline || typeof baseline !== "object" || !Object.hasOwn(baseline, "buildArgs");
  });
}

async function reconcileComposeSource(
  ctx: RequestContext,
  project: Project,
  branch: string,
  options: {
    changedPaths?: string[] | null;
    interpolationEnv?: Record<string, string>;
  } = {},
): Promise<ProjectInfo | undefined> {
  let bootstrapping = false;
  const localPath = project.localPath?.trim();
  const isLocalSource = Boolean(localPath);
  try {
    if (!isLocalSource && (!project.gitOwner || !project.gitRepo)) return;
    const composeRows = await listProjectComposeServices(project.id);
    const hasComposeRows = composeRows.some((s) => s.kind === "compose");
    // Image-only rows created by an older release carry no provenance, so we
    // cannot tell a literal image from one whose `${VAR}` was already erased.
    // Re-read those sources even for code-only webhooks. Current templated rows
    // need the same refresh when project env changes; literal image-only rows
    // pay a conservative source read in exchange for never guessing about an
    // artifact. Source-built rows keep the changed-path fast path.
    const needsImageSourceRefresh = composeRows.some(
      (service) => serviceKind(service) === "compose" && !service.build,
    );
    bootstrapping = !hasComposeRows && isMultiServiceProject(project);
    if (!hasComposeRows && !bootstrapping) return; // not a compose project
    const needsBaselineUpgrade = composeRowsNeedBaselineUpgrade(composeRows);
    // changedPaths is only a drift optimization. A declared compose project
    // with no rows must scan once regardless of which file triggered the first
    // webhook; otherwise the service pipeline is selected with an empty service
    // set and the project can never bootstrap.
    if (
      !bootstrapping &&
      !needsBaselineUpgrade &&
      !isLocalSource &&
      options.changedPaths &&
      options.changedPaths.length > 0 &&
      !needsImageSourceRefresh &&
      !composeCouldHaveChanged(project, options.changedPaths)
    ) {
      return; // this push didn't touch the compose file → no drift possible
    }
    const composePath = project.composePath ?? undefined;
    // Without composePath, a subpath project re-scans at the detected root and
    // finds no compose (or the wrong one), so reconciliation silently stops.
    // Local wins when present because that is the build source transferred to a
    // remote server; any stale Git metadata must not change what gets parsed.
    const info = isLocalSource
      ? await resolveProjectInfo({
          source: "local",
          path: localPath!,
          composePath,
          env: options.interpolationEnv,
        })
      : await resolveProjectInfo({
          source: "github",
          owner: project.gitOwner!,
          repo: project.gitRepo!,
          branch,
          ctx,
          composePath,
          env: options.interpolationEnv,
        });
    const services = info.services ?? [];
    if (services.length === 0) {
      if (bootstrapping) {
        throw new Error(
          `The configured compose path "${project.composePath ?? "repository root"}" contains no services.`,
        );
      }
      return;
    }
    const { driftedNames } = await repos.service.reconcileFromCompose(project.id, services);
    if (driftedNames.length > 0) {
      console.log(
        `[compose-drift] ${project.id}: kept user edits on ${driftedNames.join(", ")} (pending review)`,
      );
    }
    return info;
  } catch (err) {
    if (bootstrapping || isLocalSource) {
      const action = bootstrapping ? "initialize" : "refresh";
      throw new AppError(
        `Could not ${action} compose services from "${project.composePath ?? "repository root"}": ${safeErrorMessage(err)}`,
        400,
      );
    }
    // A transient GitHub/API failure may safely keep the last imported
    // shape for an existing project. A file we did read but cannot represent
    // must fail closed: otherwise this deploy silently runs the stale service
    // definition after the author changed a build target, secret, SSH option,
    // malformed arg, or another unsupported Compose field.
    if (err instanceof ComposeConfigurationError) {
      throw new AppError(
        `Could not refresh compose services from "${project.composePath ?? "repository root"}": ${safeErrorMessage(err)}`,
        400,
      );
    }
    console.warn(`[compose-source] reconcile skipped for ${project.id}:`, err);
    return undefined;
  }
}

/**
 * Read the small environment-only slice of a Git/local source when Compose
 * reconciliation did not already return it. This keeps explicit single-app
 * mode free of Compose parsing while giving every deployment entry point the
 * same openship.json environment semantics.
 */
async function resolveLifecycleSourceEnv(
  ctx: RequestContext,
  project: Project,
  branch: string,
): Promise<ProjectSourceEnv | undefined> {
  if (isReleaseProvider(project.gitProvider)) return undefined;
  const localPath = project.localPath?.trim();
  if (!localPath && (!project.gitOwner || !project.gitRepo)) return undefined;

  try {
    return localPath
      ? await resolveProjectSourceEnv(
          { source: "local", path: localPath },
          project.rootDirectory ?? "",
        )
      : await resolveProjectSourceEnv(
          {
            source: "github",
            owner: project.gitOwner!,
            repo: project.gitRepo!,
            branch,
            ctx,
          },
          project.rootDirectory ?? "",
        );
  } catch (err) {
    if (localPath) {
      throw new AppError(`Could not read project environment: ${safeErrorMessage(err)}`, 400);
    }
    console.warn(`[source-env] refresh skipped for ${project.id}:`, err);
    return undefined;
  }
}

/** Freeze an auto-discovered service shape into the release snapshot. This is
 * what makes a composePath bootstrap visible in deployment metadata and keeps a
 * later rollback self-contained. An explicit single-app choice never reaches
 * this helper because resolveServicePipelineMode returns false for it. */
function freezeResolvedServicePipeline(
  snapshot: DeploymentConfigSnapshot,
  resolved: { useServicePipeline: boolean; servicePreflightServices: DeployableService[] },
): void {
  if (!resolved.useServicePipeline) return;
  snapshot.serviceDeploymentMode ??= "services";
  if (!snapshot.composeServices?.length && resolved.servicePreflightServices.length > 0) {
    snapshot.composeServices = resolved.servicePreflightServices;
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
 *       > project.serverId (the DURABLE server binding — survives a fresh/partial
 *         snapshot that a redeploy would otherwise resolve to "local")
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

  // Target priority, highest first:
  //   1. explicit override (the caller chose a target for this deploy)
  //   2. cloud — a promoted project (canonical on the SaaS)
  //   3. project.serverId — the DURABLE server binding
  //   4. the active deployment's stamped target
  //   5. inferred "server" when the active meta carries a serverId
  // Step 3 is why a server-hosted project can no longer regress to "local" on a
  // fresh/partial snapshot (which then nulled its custom-domain ports). Steps 4–5
  // remain for legacy rows not yet backfilled: step 5 matches resolveEffectiveTarget
  // (which routes ANY serverId over SSH) and repairs migrated (adopt/reattach) metas
  // that set serverId but historically omitted deployTarget.
  let deployTarget: DeployTarget | undefined;
  if (override?.deployTarget) deployTarget = override.deployTarget;
  else if (project.cloudWorkspaceId) deployTarget = "cloud";
  else if (project.serverId) deployTarget = "server";
  else if (activeMeta?.deployTarget) deployTarget = activeMeta.deployTarget;
  else if (activeMeta?.serverId) deployTarget = "server";

  const serverId =
    deployTarget === "server"
      ? (override?.serverId ?? project.serverId ?? activeMeta?.serverId ?? undefined)
      : undefined;

  const runtimeMode =
    override?.runtimeMode ?? toRuntimeMode(project.runtimeMode) ?? activeMeta?.runtimeMode;

  return { deployTarget, serverId, runtimeMode };
}

function resolveRuntimeImage(project: Project): string {
  const stackId = (
    project.framework && project.framework in STACKS ? project.framework : "unknown"
  ) as StackId;

  // Only a STATIC site is served by the static (nginx) image. A worker is a normal
  // long-running container that happens to publish no port, so it runs the stack
  // base image exactly like a web app (#538-B) — routing through the workload axis
  // keeps this from mis-reading a worker's `hasServer=false` mirror as static.
  if (deploymentWorkload(project) === "static") {
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

type StoredProjectEnv = {
  key: string;
  value: string;
  isSecret: boolean;
};

/**
 * Resolve the env map submitted by the deploy wizard without destroying values
 * the browser was never allowed to read.
 *
 * The shared mask sentinel means "keep the stored value"; it is never itself an
 * environment value. Every real value, including an explicitly empty one, is
 * encrypted normally. A sentinel with no stored secret behind it is dropped.
 */
function resolveSubmittedProjectEnv(
  submitted: Record<string, string>,
  storedRows: StoredProjectEnv[],
): {
  encrypted: Record<string, string> | null;
  rows: Array<{ key: string; value: string; isSecret: boolean }>;
} {
  const storedByKey = new Map(storedRows.map((row) => [row.key, row]));
  const rows: Array<{ key: string; value: string; isSecret: boolean }> = [];

  for (const [key, submittedValue] of Object.entries(submitted)) {
    const stored = storedByKey.get(key);
    const preservesUnreadableSecret = stored?.isSecret === true && isMaskedValue(submittedValue);

    if (isMaskedValue(submittedValue) && !preservesUnreadableSecret) {
      // The mask is a transport sentinel, never an environment value. With no
      // matching saved secret there is nothing safe to recover.
      continue;
    }

    rows.push({
      key,
      value: preservesUnreadableSecret ? stored.value : encrypt(submittedValue),
      isSecret: stored?.isSecret ?? looksLikeSecretKey(key),
    });
  }

  const encrypted = Object.fromEntries(rows.map(({ key, value }) => [key, value]));
  return { encrypted: rows.length > 0 ? encrypted : null, rows };
}

type PersistableProjectEnv = { key: string; value: string; isSecret: boolean };
type SourceEnvInfo = ProjectSourceEnv;

function openshipEnvValue(value: OpenshipEnv[string]): { value: string; isSecret: boolean } {
  return typeof value === "string"
    ? { value, isSecret: false }
    : { value: value.value, isSecret: value.secret === true };
}

/**
 * Layer source-owned environment defaults underneath the project environment.
 *
 * The source is never trusted through the browser: `openship.json` and an
 * explicitly imported root `.env` arrive at build/access only as masked names,
 * then this server-side source scan recovers their values. Existing/supplied
 * project rows win. Newly inherited values are returned separately so callers
 * can persist them without replacing unrelated project-owned rows.
 */
function mergeSourceEnvDefaults(
  encryptedProjectEnv: Record<string, string> | null,
  sourceInfo: SourceEnvInfo | undefined,
  submitted?: Record<string, string>,
  selectedSourceEnvKeys: readonly string[] = [],
): {
  encrypted: Record<string, string> | null;
  additions: PersistableProjectEnv[];
} {
  const encrypted = { ...(encryptedProjectEnv ?? {}) };
  const sourceDefaults = new Map<string, { value: string; isSecret: boolean }>();

  for (const [key, value] of Object.entries(sourceInfo?.openshipEnv ?? {})) {
    sourceDefaults.set(key, openshipEnvValue(value));
  }

  // A root `.env` remains opt-in. New clients send a values-free key list so an
  // existing project's full env map stays server-owned; masked entries in the
  // legacy full payload remain supported. Recover only those selected keys,
  // never every value discovered beside the source tree.
  const selectedRootEnvKeys = new Set(selectedSourceEnvKeys);
  for (const [key, value] of Object.entries(submitted ?? {})) {
    if (isMaskedValue(value)) selectedRootEnvKeys.add(key);
  }
  for (const key of selectedRootEnvKeys) {
    if (!sourceDefaults.has(key) && sourceInfo?.rootEnv && Object.hasOwn(sourceInfo.rootEnv, key)) {
      sourceDefaults.set(key, {
        value: sourceInfo.rootEnv[key]!,
        isSecret: looksLikeSecretKey(key),
      });
    }
  }

  const additions: PersistableProjectEnv[] = [];
  for (const [key, source] of sourceDefaults) {
    if (Object.hasOwn(encrypted, key)) continue;
    const row = { key, value: encrypt(source.value), isSecret: source.isSecret };
    encrypted[key] = row.value;
    additions.push(row);
  }

  return {
    encrypted: Object.keys(encrypted).length > 0 ? encrypted : null,
    additions,
  };
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
  // The exact repository query includes a cancelled/terminal-looking row while
  // its claimed build worker is still unwinding. Status-only history paging can
  // neither prove worker completion nor guarantee the active row is on page 1.
  const [active] = await repos.deployment.listInFlightByProject(projectId);
  if (active) {
    const cancelling = active.status === "cancelled";
    throw new ForbiddenError(
      cancelling
        ? `The previous deployment is still finishing cancellation (${active.id}). ` +
            "Wait a few seconds and retry; a parallel redeploy is blocked until its worker stops."
        : `A deployment is already in progress (${active.id}). Cancel it first or wait for it to complete.`,
    );
  }
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
  /**
   * Treat `serviceIds` as an EXCLUSIVE scope: a service outside it is never deployed,
   * never failed, and never reaped — not merely "carried forward if we can".
   *
   * The distinction is load-bearing. Carry-forward has exactly one source,
   * `previousByServiceId` off `project.activeDeploymentId`, so a project with NO previous
   * deployment cannot carry anything: an untargeted service that is enabled and has an
   * image falls straight through to a normal deploy. That is how a migration's
   * adopt-in-place reuse set got a SECOND container on the still-running originals' bare
   * volumes. Set this whenever the untargeted services must be untouchable regardless of
   * whether a previous release exists.
   */
  strictServiceScope?: boolean;
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
  // Only meaningful WITH a scope — on its own it would describe an exclusion of nothing.
  if (opts.strictServiceScope && opts.serviceIds && opts.serviceIds.length > 0) {
    meta = { ...meta, strictServiceScope: true };
  }

  // Plan entitlements, checked BEFORE the row exists so an out-of-allowance org
  // gets a clean 402 instead of a `failed` deployment to clean up. This is THE
  // enforcement point: every deploy entry funnels here — requestBuildAccess,
  // redeployBuildSession (which runs no preflight, so a preflight-only gate would
  // be bypassed by the Redeploy button and by apply-update) and
  // triggerDeployment (webhook push, incoming webhooks, service-connection
  // auto-redeploy). Both gates no-op unless CLOUD_MODE.
  await assertPlanAllowsDeployShape(opts.organizationId, {
    workload: snapshotToClass(meta).workload,
    targetServiceIds: meta.targetServiceIds ?? null,
    // Workload alone is not enough: a compose/services project deploying ALL its
    // services carries no targetServiceIds, and if its `hasServer` is false the
    // workload resolves to "static" — so a container stack would read as a static
    // site. This is the same predicate the pipeline itself branches on, so the
    // gate and the executor can't disagree about what will run.
    usesServicePipeline: async () => {
      const project = await repos.project.findById(opts.projectId).catch(() => null);
      return project ? shouldUseProjectServicePipeline(project, meta.composeServices) : false;
    },
  });
  await assertBuildMinutesAvailable(opts.organizationId);

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
export async function respondToPrompt(deploymentId: string, action: string): Promise<boolean> {
  await loadDeployment(deploymentId);
  return sessionManager.respondToPrompt(deploymentId, action);
}

/**
 * Default public endpoint for a deploy that supplied none: a free subdomain from
 * the project slug. Static sites route by path, server apps by port — an endpoint
 * with neither is dropped downstream (see deriveEnvironmentPublicEndpoints), so
 * pick the one the project's shape needs.
 */
function defaultFreeEndpoint(project: { slug: string; hasServer: boolean; port: number | null }): {
  domain: string;
  domainType: "free";
  port?: string;
  targetPath?: string;
} {
  return project.hasServer && project.port
    ? { domain: project.slug, domainType: "free", port: String(project.port) }
    : { domain: project.slug, domainType: "free", targetPath: "/" };
}

export async function requestBuildAccess(
  ctx: RequestContext,
  input: BuildAccessInput,
  /**
   * INTERNAL-only options — deliberately a second argument rather than fields on
   * `BuildAccessInput`, which is the wire body. These values can change which services
   * are touched or bypass normal artifact acquisition, so only server-side callers get
   * to set them.
   */
  internal?: {
    strictServiceScope?: boolean;
    /** One-time migration image pins, keyed by canonical service name. */
    handoverImages?: Record<string, string>;
    /** Single-app counterpart to `handoverImages`. */
    handoverAppImage?: string;
  },
) {
  const {
    projectId,
    branch,
    environment,
    envVars,
    sourceEnvKeys,
    publicEndpoints,
    buildStrategy,
    deployTarget,
    serverId,
    runtimeMode,
    serviceDeploymentMode,
    services,
    serviceIds,
    refreshServiceIds,
    cloudResourceTier,
    cloudResourceCustom,
    cloneStrategy,
  } = input;

  const project = await repos.project.findById(projectId);
  if (!project) {
    throw new NotFoundError("Project", projectId);
  }
  // Validate an explicit host-root capability before compose reconciliation,
  // route persistence, or deployment-row creation. Runtime/preflight reuse the
  // same guard; this early call makes invalid/foreign targeting atomic even for
  // public repositories and folder uploads that need no Git credential probe.
  if (serverId) await requireOrgServer(serverId, ctx.organizationId);
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

  // Folder-upload: resolve the session UP FRONT — its scanned compose services
  // feed the service-mode decision below. The snapshot mutations it drives still
  // happen further down, after target resolution (which the upload mode overrides).
  const uploadSession = input.uploadSessionId ? getFolderSession(input.uploadSessionId) : undefined;
  if (input.uploadSessionId && (!uploadSession || uploadSession.orgId !== ctx.organizationId)) {
    throw new AppError("Upload session not found or expired — re-upload the folder.", 400);
  }

  // Resolve the deployment's project environment before parsing Compose. Image
  // interpolation is part of deployment configuration, so the source refresh
  // and the eventual build must see the exact same values. Keep the encrypted
  // map for the deployment row and decrypt only the in-memory interpolation copy.
  const deployEnvironment = environment || "production";
  let deploymentEnvVars: Record<string, string> | null;
  let submittedProjectEnv: Array<{ key: string; value: string; isSecret: boolean }> | undefined;
  if (envVars && Object.keys(envVars).length > 0) {
    const storedRows = await repos.project.listEnvVars(project.id, deployEnvironment, null);
    const resolved = resolveSubmittedProjectEnv(envVars, storedRows);
    deploymentEnvVars = resolved.encrypted;
    submittedProjectEnv = resolved.rows;
  } else {
    // A deployment snapshot is project-scoped. Service-scoped rows are loaded
    // live, per service, by the compose deployer and must not enter image
    // interpolation or leak into sibling services.
    const rawEnvMap = await repos.project.getEnvMap(project.id, deployEnvironment, null);
    deploymentEnvVars = Object.keys(rawEnvMap).length > 0 ? rawEnvMap : null;
  }
  const composeInterpolationEnv = decryptEnvMap(deploymentEnvVars ?? {});

  // A folder scan happens before the wizard collects project env. Re-read the
  // exact staged source now, against the deployment's frozen env, so Compose's
  // adjacent `.env` and the submitted project values participate in ONE
  // interpolation pass. Session-held parser output remains the comparison base
  // that lets us distinguish an unchanged preview from a literal caller edit.
  const initialUploadServices = uploadSession?.services ?? [];
  let refreshedUploadServices: DeployableService[] | undefined;
  let sourceInfo: SourceEnvInfo | undefined =
    uploadSession &&
    (uploadSession.rootEnv !== undefined || uploadSession.openshipEnv !== undefined)
      ? {
          rootEnv: uploadSession.rootEnv,
          openshipEnv: uploadSession.openshipEnv,
        }
      : undefined;
  if (uploadSession && serviceDeploymentMode !== "single" && uploadSession.services !== undefined) {
    try {
      const { scanFolderSession } = await import("../projects/folder/folder.service");
      const refreshed = await scanFolderSession(uploadSession, {
        env: composeInterpolationEnv,
        composePath: project.composePath ?? undefined,
        rememberServices: false,
      });
      sourceInfo = refreshed;
      refreshedUploadServices = refreshed.services;
    } catch (err) {
      throw new AppError(
        `Could not refresh the uploaded Compose source: ${safeErrorMessage(err)}`,
        400,
      );
    }
  }

  // The uploaded folder's compose file is the only description a new folder
  // deploy has of its service set. Adopt the refreshed scan when neither the
  // request nor the canonical table has rows yet.
  // `imageTemplate` is parser provenance, never client authority. Strip any
  // copy supplied on the wire; the canonical repo row / server-side upload scan
  // below is the only producer allowed to attach it again.
  let effectiveServices: DeployableService[] | undefined = services?.map((service) =>
    serviceKind(service) === "compose"
      ? withComposeImageSource(service, { image: service.image, advanced: undefined })
      : service,
  );
  if (
    !effectiveServices?.length &&
    serviceDeploymentMode !== "single" &&
    refreshedUploadServices?.length &&
    (await listProjectComposeServices(project.id)).length === 0
  ) {
    effectiveServices = refreshedUploadServices;
  }

  const resolvedBranch = await resolveProjectBranch(ctx, project, branch);

  // Reconcile the repo's compose BEFORE resolving the service set — the third
  // deploy entry point (alongside redeployBuildSession + triggerDeployment) that
  // must do this. Without it a deploy only ever sees the CURRENT service rows, so
  // a repo compose service that isn't in the collection yet (e.g. a migrated
  // stack whose repo adds `redis`) is never created or deployed. reconcileFromCompose
  // CREATES the missing ones (native) and, for freshly-adopted rows (importedSpec
  // null), bootstraps their baseline while KEEPING the adopted image — so mapped
  // services reuse their running image (no rebuild) and everything else in the
  // compose is taken from the repo. An explicit single-app deploy is an
  // authoritative topology choice: do not parse, materialize, or validate the
  // declared compose file behind the caller's back.
  if (serviceDeploymentMode !== "single") {
    const reconciled = await reconcileComposeSource(ctx, project, resolvedBranch, {
      interpolationEnv: composeInterpolationEnv,
    });
    sourceInfo ??= reconciled;
  }

  if (!sourceInfo) {
    if (uploadSession) {
      try {
        const { resolveFolderSessionSourceEnv } = await import("../projects/folder/folder.service");
        sourceInfo = await resolveFolderSessionSourceEnv(
          uploadSession,
          project.rootDirectory ?? "",
        );
      } catch (err) {
        throw new AppError(
          `Could not read uploaded project environment: ${safeErrorMessage(err)}`,
          400,
        );
      }
    } else {
      sourceInfo = await resolveLifecycleSourceEnv(ctx, project, resolvedBranch);
    }
  }

  // `openship.json.env` is a source-owned DEFAULT layer. Resolve it again from
  // the trusted source here (never from the masked browser payload), put saved /
  // explicitly submitted project values above it, and freeze the result onto
  // this deployment. This is the missing link in #795: the downstream Docker
  // adapter already consumes deployment env as build args, but the declared
  // values previously never entered that snapshot.
  const sourceEnv = mergeSourceEnvDefaults(
    deploymentEnvVars,
    sourceInfo,
    envVars,
    sourceEnvKeys,
  );
  deploymentEnvVars = sourceEnv.encrypted;

  // Source interpolation and the wizard payload have different ownership. The
  // source owns `image` + its raw expression; the wizard owns routing/runtime
  // edits. Merge after reconciliation so a stale browser scan cannot overwrite
  // the value just resolved from this deployment's env. Folder uploads use the
  // initial session scan as their edit baseline and the final-env re-scan as
  // their source of truth.
  if (serviceDeploymentMode !== "single") {
    const canonicalRows = await listProjectComposeServices(project.id);
    const canonicalServices = projectServicesToDeployableServices(canonicalRows);

    if (refreshedUploadServices) {
      let current = effectiveServices;
      if (!current?.length && canonicalServices.length > 0) {
        current = canonicalServices.filter((service) => service.enabled !== false);
      }
      if (!current?.length) current = refreshedUploadServices;

      // With no explicit request list, newly discovered services belong to the
      // uploaded source too. An explicit list remains an intentional topology
      // selection (the wizard supports removing a service before deploy).
      if (!services?.length) {
        const names = new Set(current.map((service) => service.name));
        current = [
          ...current,
          ...refreshedUploadServices.filter((service) => !names.has(service.name)),
        ];
      }

      const merged = mergeRefreshedFolderBuildSource(
        current,
        initialUploadServices,
        refreshedUploadServices,
      );
      if (effectiveServices?.length || !sameComposeBuildSource(current, merged)) {
        effectiveServices = merged;
      }
    } else if (effectiveServices?.length && canonicalServices.length > 0) {
      effectiveServices = mergeCanonicalComposeBuildSource(effectiveServices, canonicalServices);
    }
  }

  // Migration handover refs bypass build/pull, so they are both internal-only
  // and validated before any route or deployment write. The map is
  // keyed by the canonical service name consumed by pinnedServiceImage; a typo
  // must fail closed instead of silently rebuilding a transferred image.
  const handoverImages = internal?.handoverImages;
  const handoverAppImage = internal?.handoverAppImage?.trim();
  if (
    (handoverImages && Object.keys(handoverImages).length > 0) ||
    internal?.handoverAppImage !== undefined
  ) {
    const persistedServices = await listProjectComposeServices(project.id);
    const knownServiceNames = new Set([
      ...persistedServices.map((service) => service.name),
      ...(effectiveServices ?? []).map((service) => service.name),
    ]);
    const invalidEntries = Object.entries(handoverImages ?? {}).filter(
      ([name, ref]) => !knownServiceNames.has(name) || !ref.trim() || ref.trim().startsWith("/"),
    );
    if (invalidEntries.length > 0) {
      throw new AppError(
        `Invalid migration image handover for service${invalidEntries.length === 1 ? "" : "s"}: ${invalidEntries
          .map(([name]) => name)
          .join(", ")}`,
        400,
      );
    }
    if (
      internal?.handoverAppImage !== undefined &&
      (!handoverAppImage || handoverAppImage.startsWith("/"))
    ) {
      throw new AppError("Invalid migration application image handover", 400);
    }
  }

  // #336: the wizard sees compose env MASKED, so a deploy request can echo the
  // "••••••••" sentinel back. Recover the real values before they're persisted
  // to the snapshot / service rows (else containers launch with KEY=••••••••).
  // Recovery sources, all plaintext: the staged upload's scan (session.services,
  // captured pre-mask) and the stored service rows — which reconcileComposeSource
  // above just refreshed from a git repo's compose, so this also covers a git
  // first-deploy. A revealed-and-edited value arrives real and passes through.
  if (effectiveServices?.length && effectiveServices.some((s) => hasMaskedValue(s.environment))) {
    const realEnvByName = new Map<string, Record<string, string>>();
    for (const s of await listProjectComposeServices(project.id)) {
      realEnvByName.set(s.name, (s.environment as Record<string, string> | null) ?? {});
    }
    for (const s of uploadSession?.services ?? []) {
      if (s.name && s.environment) realEnvByName.set(s.name, s.environment);
    }
    effectiveServices = effectiveServices.map((s) =>
      s.environment && hasMaskedValue(s.environment)
        ? { ...s, environment: unmaskEnv(s.environment, realEnvByName.get(s.name) ?? null) }
        : s,
    );
  }

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
  // A service-FIRST project (docker-compose / services framework) is a services
  // deploy even when this request carries no service list — its rows already
  // describe the set. Keyed on the project's own framework, so a normal app that
  // merely had a sidecar service added still defaults its project domain below.
  const isServicesDeploy =
    serviceDeploymentMode === "services" ||
    !!effectiveServices?.length ||
    (serviceDeploymentMode !== "single" && isMultiServiceProject(project));
  let nextPublicEndpoints = publicEndpoints;
  if (
    nextPublicEndpoints === undefined &&
    routeState.publicEndpoints.length === 0 &&
    !isServicesDeploy &&
    // A worker is reached by nothing — it gets no default free subdomain (#538-B).
    // The route layer (project-route.service) also refuses to route one, but not
    // manufacturing the endpoint here keeps a portless deploy from ever synthesizing
    // a route it can't answer.
    deploymentWorkload(project) !== "worker"
  ) {
    nextPublicEndpoints = [defaultFreeEndpoint(project)];
  }

  if (nextPublicEndpoints !== undefined) {
    const routing = await syncProjectRouteState(project, {
      projectDomains,
      nextPublicEndpoints,
      slug: routeState.publicEndpoints.find((endpoint) => endpoint.domainType === "free")?.domain,
      // A deploy must never delete or null a user's custom domain, even
      // if this deploy's endpoint set omitted it or lost its port (e.g. a target
      // that mis-resolved to "local"). Pending verification is still durable
      // user configuration. The Domains editor keeps the default (off), so an
      // explicit removal there still applies.
      preserveCustomDomains: true,
    });
    routeState = routing;
  }

  const requestedServiceMode =
    serviceDeploymentMode === "single"
      ? "single"
      : serviceDeploymentMode === "services" || effectiveServices?.length
        ? "services"
        : undefined;

  if (requestedServiceMode) {
    snapshot.serviceDeploymentMode = requestedServiceMode;
  }
  // Migration image handover (one-time): mapped services deploy from their
  // transferred/running image with no build/pull. Only ever set by the migration
  // orchestrator's first deploy; a normal deploy leaves it unset → native build/pull.
  if (handoverImages && Object.keys(handoverImages).length > 0) {
    snapshot.handoverImages = Object.fromEntries(
      Object.entries(handoverImages).map(([name, ref]) => [name, ref.trim()]),
    );
  }
  if (handoverAppImage) snapshot.handoverAppImage = handoverAppImage;
  if (requestedServiceMode === "services" && effectiveServices?.length) {
    snapshot.composeServices = effectiveServices;
    // Persist compose services to the canonical service table NOW, at
    // deploy-request time — not only deep inside the compose pipeline. A build
    // that FAILS before the pipeline's own sync (clone/prepare error, image
    // pull, etc.) would otherwise leave the project with ZERO service rows, so
    // the config-edit wizard (which reads the service table) collapses to
    // single-app even though the compose config is right here. syncFromCompose
    // is idempotent and strictly owns compose rows, so filter out monorepo
    // entries (they'd create ghost compose rows) exactly like the pipeline does.
    // Best-effort: a persist failure must never block the deploy.
    const composeOnly = effectiveServices.filter((s) => serviceKind(s) === "compose");
    if (composeOnly.length) {
      // #342: these rows' custom hostnames become vhosts like any other, so they
      // carry the same shape gate as the service editors — and it runs on the set
      // ACTUALLY persisted, which includes the compose a folder upload adopts when
      // the request body carried no `services`. Net-new only: a deploy that echoes
      // back a hostname the rows already hold is never refused (a deploy is not the
      // place to enforce a cleanup). The project's OWN publicEndpoints are gated by
      // syncProjectRouteState further down. Costs a query only when a custom service
      // hostname is actually declared; throws BEFORE the best-effort persist below.
      if (customHostnamesOf(composeOnly).length) {
        const rows = await repos.service.listByProject(project.id).catch(() => []);
        assertValidCustomDomains(composeOnly, { known: customHostnamesOf(rows) });
      }
      await repos.service
        // removeMissing: false — deploy-time sync creates and updates only. A
        // service dropped from the compose file is removed by the explicit
        // reconcile path, which can tell an intentional deletion from a stale
        // snapshot; deleting here cascades its deploy history and orphans its
        // running container (see syncFromCompose's docblock).
        .syncFromCompose(project.id, composeOnly, { removeMissing: false })
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
  freezeResolvedServicePipeline(snapshot, { useServicePipeline, servicePreflightServices });

  // Resolve the snapshot's target (deployTarget + serverId + runtimeMode) from
  // the single source of truth shared with triggerDeployment — UI override >
  // cloudWorkspaceId > active-deployment meta. Keeps the two deploy entry points
  // from diverging on where a project deploys.
  const resolvedTarget = await resolveSnapshotTarget(project, {
    deployTarget,
    serverId,
    runtimeMode,
  });
  snapshot.deployTarget = resolvedTarget.deployTarget;
  snapshot.serverId = resolvedTarget.serverId;
  snapshot.runtimeMode = resolvedTarget.runtimeMode;

  // Folder-upload: point this deploy at the source the browser uploaded.
  //   - cloud (oblien-direct): adopt the pre-provisioned workspace, skip clone.
  //   - self-hosted (api-relay): build from the staging dir like a local folder.
  // The session/workspace outlive this call (session TTL; workspace made
  // permanent on deploy), so nothing is disposed here.
  if (uploadSession) {
    if (uploadSession.mode === "oblien-direct") {
      snapshot.uploadWorkspaceId = uploadSession.workspaceId;
      snapshot.sourceStaged = true;
      snapshot.deployTarget = "cloud";
    } else {
      snapshot.localPath = uploadSession.stagingDir;
    }
  }

  // Persist an EXPLICIT runtime-isolation choice (the deploy "sandbox vs direct"
  // modal pick) onto the project so it STICKS. Without this the choice lives only
  // in this one deployment's snapshot: the modal re-asks every deploy, a later
  // config-save reads project.runtimeMode (still null) and writes the host
  // default, and a redeploy then resolves to that default (bare) — silently
  // flipping a docker/sandbox project to direct-on-host. Best-effort: a failed
  // persist must not block the deploy. Only write when it actually changed.
  if ((runtimeMode === "bare" || runtimeMode === "docker") && runtimeMode !== project.runtimeMode) {
    await repos.project
      .update(project.id, { runtimeMode })
      .catch((err) =>
        console.warn(
          `[requestBuildAccess] failed to persist runtimeMode: ${safeErrorMessage(err)}`,
        ),
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
  // Git-credential forwarding is now a GENERIC per-operator preference (Settings →
  // Clone credentials), not a per-deploy toggle. Source it from the deploying
  // user's setting as an EXPLICIT boolean: clone-plan treats `!== false` as
  // eligible, so leaving it undefined when the setting is off would silently
  // re-enable the relay on desktop. The build pipeline still enforces desktop +
  // server-build + SSH gating before opening the relay.
  snapshot.forwardGitCredentials = await settingsService.getForwardGitToServer(ctx.userId);
  // Per-deploy clone location. "server" makes a docker deploy clone on the build
  // host (relay on desktop, token otherwise); the pipeline gates it. Default
  // "api-host" (clone on the orchestrator + transfer) when unset.
  if (cloneStrategy === "server" || cloneStrategy === "api-host") {
    snapshot.cloneStrategy = cloneStrategy;
  }

  // Openship Cloud resource tier — only a SERVER-BACKED cloud (Oblien)
  // deploy provisions a workspace sized by these resources. Both a web app and
  // a worker run a long-lived container that must be sized; only a static
  // (Pages) deploy has no workspace. Non-cloud targets keep the project's own
  // resource config, so the picker is ignored for them. The resolved
  // ResourceConfig rides the existing `snapshot.resources` plumbing →
  // prodResources → runtime.deploy / ensureServiceGroup → cloud.ts.
  if (
    snapshot.deployTarget === "cloud" &&
    snapshotToClass(snapshot).workload !== "static" &&
    cloudResourceTier
  ) {
    // The plan's per-service size cap, enforced HERE because Oblien cannot do it:
    // its vCPU/RAM ceilings are per-workspace and applied namespace-wide, and a
    // transient build workspace needs 4 vCPU / 8 GB — so the Oblien ceiling has to
    // be build-sized and is useless as a cap on a runtime service. This is the
    // point where the size is actually chosen, and it had NO bound of any kind:
    // `cloudResourceCustom` carries no min/max, so a free org could ask for 1024
    // vCPU and only find out from an opaque Oblien error mid-build.
    await assertPlanAllowsResourceTier(ctx.organizationId, {
      tier: cloudResourceTier,
      cpuCores: cloudResourceCustom?.cpuCores ?? null,
      memoryMb: cloudResourceCustom?.memoryMb ?? null,
    });
    snapshot.resources = resolveCloudResourceConfig(cloudResourceTier, cloudResourceCustom);
  }

  // ── Preflight: validate config + domain before creating any resources ──
  await runDeploymentPreflight(snapshot, routeState, {
    ctx,
    composeServices: servicePreflightServices,
    multiService: useServicePipeline,
    gitOwner: project.gitOwner,
    projectId: project.id,
    // An app project carries its catalog id; a never-deployed one is the only
    // deploy a host-capacity shortfall is allowed to refuse.
    appTemplateId: project.appTemplateId,
    firstDeploy: !project.activeDeploymentId,
  });
  const env = deployEnvironment;

  // ── Resolve commit info from the branch HEAD ────
  const { commitSha, commitMessage } = await resolveLatestCommitInfo(ctx, project, snapshot.branch);

  // ── Resolve rollback context (shared helper — single default) ─────────
  const { rollbackStrategy, commitShaBefore } = await resolveRollbackContext(
    project,
    snapshot.branch,
  );

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
    // Service-scoped folder-upload/MCP deploy: only these services are (re)built;
    // the rest carry forward on their existing containers. Without this a
    // folder-upload deploy rebuilt the WHOLE stack and needlessly recreated
    // stateful services (DBs/caches) on an unrelated change.
    serviceIds,
    refreshServiceIds,
    strictServiceScope: internal?.strictServiceScope,
  });

  // Store env vars on project as "latest defaults"
  if (submittedProjectEnv) {
    // These arrive as a flat map with no per-variable flag. New keys therefore
    // use the name heuristic, while resolveSubmittedProjectEnv keeps an existing
    // row's explicit flag and (for an unreadable secret) its exact ciphertext.
    await repos.project.bulkSetEnvVars(project.id, env, submittedProjectEnv);
  }
  if (sourceEnv.additions.length > 0) {
    // Add only missing source defaults after the optional full wizard replace.
    // This preserves the ownership rule: a saved/operator value always wins,
    // while headless and folder deploys gain newly declared defaults.
    await repos.project.mergeEnvVars(project.id, env, sourceEnv.additions, []);
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

/**
 * Cancel an in-flight deployment.
 *
 * `keepProvisioned` aborts the build and marks the row cancelled but SKIPS the
 * runtime teardown — the record-only ("remove from Openship only") delete needs
 * to quiesce an in-flight deploy while honoring its "nothing on the server is
 * touched" guarantee, so it must never destroy the containers/images the deploy
 * had already provisioned.
 */
export async function cancelBuildSession(
  deploymentId: string,
  opts: { keepProvisioned?: boolean } = {},
) {
  const { dep, project } = await loadDeployment(deploymentId);

  if (!["queued", "building", "deploying"].includes(dep.status)) {
    throw new ForbiddenError("Cannot cancel a deployment that is not in progress");
  }

  const buildSession = await repos.deployment.findBuildSessionByDeploymentId(deploymentId);

  // Win the outcome in the database BEFORE cleanup or transport cancellation.
  // This closes the read→cancel race where the worker could publish `ready`
  // while this handler was still collecting its cleanup manifest. The repo
  // transition only accepts queued/building/deploying; a release that became
  // ready first is left untouched.
  const cancellationMeta = opts.keepProvisioned
    ? {
        ...((dep.meta as Record<string, unknown> | null) ?? {}),
        cancellation: { keepProvisioned: true },
      }
    : undefined;
  if (
    !(await repos.deployment.cancelInFlight(
      dep.id,
      cancellationMeta ? { meta: cancellationMeta } : undefined,
    ))
  ) {
    throw new ForbiddenError("Cannot cancel a deployment that is no longer in progress");
  }

  // Cancel the OUTER deployment worker as well as the adapter's build command.
  // The image may already be complete while the worker is blocked in a prompt,
  // preflight, or a host-scoped provisioning lock; changing the DB row alone
  // leaves that worker holding the project lease indefinitely.
  requestDeploymentCancellation(dep.id, { keepProvisioned: opts.keepProvisioned });
  sessionManager.cancelPendingPrompt(dep.id);

  // 1. Abort the running build process. Best-effort - if the build already
  //    finished or never started this is a no-op.
  const { runtime } = platform();
  if (dep.status === "building" && buildSession) {
    await runtime.cancelBuild(buildSession.id).catch(() => {});
  }

  // 2. Exactly ONE owner tears runtime resources down. A claimed worker owns
  //    its build artifacts and containers and performs cancellation cleanup as
  //    it unwinds; racing it here can delete a resource between its activate and
  //    bookkeeping steps. Only a queued/unstarted deployment has no worker, so
  //    the handler owns that manifest. Volumes are never cleaned: cancel !=
  //    delete, and the user may retry.
  if (opts.keepProvisioned) {
    console.log(`[CANCEL] ${dep.id}: keeping provisioned resources (record-only delete)`);
  } else if (!buildSession?.startedAt) {
    // protectRetained: a cancelled compose deploy carries the LIVE release's
    // containerId/imageRef onto its own service rows for every service it hadn't
    // replaced yet, so an unprotected manifest tears down the running app.
    const manifest = await collectDeploymentManifest(dep, project, {
      protectRetained: true,
    }).catch((): CleanupManifest => ({ projectId: dep.projectId, resources: [] }));
    if (manifest.resources.length > 0) {
      await executeCleanup(manifest).catch((err) => {
        // Per-item failures are already isolated inside executeCleanup, so we
        // only land here on an unexpected crash. Log and continue - cancel
        // still has to mark the deployment cancelled, leak or no leak.
        console.error(`[CANCEL] Cleanup crashed for ${dep.id}:`, err);
      });
    }
  } else {
    console.log(`[CANCEL] ${dep.id}: worker owns runtime cleanup while cancellation unwinds`);
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
  if (buildSession) {
    // Record the time the build actually consumed, not 0. This is metered
    // (build_session.duration_ms is what the build-minute allowance sums), so a
    // hardcoded 0 made cancelling a free bypass: burn 14 minutes, cancel, pay
    // nothing, repeat. Derived from startedAt because the pipeline's own
    // onCancelled — which does write the real duration — races this write, and
    // last-write-wins was non-deterministic between the two. Both now agree.
    const elapsedMs = buildSession.startedAt
      ? Math.max(0, Date.now() - new Date(buildSession.startedAt).getTime())
      : 0;
    await repos.deployment.finishBuildSession(buildSession.id, "cancelled", elapsedMs);
    // If kickoff never acquired the execution lease, there is no worker whose
    // outer finally can acknowledge completion. Close that session here. The
    // repo predicate refuses this write when startedAt is non-null, so a real
    // worker remains visible to teardown until it actually returns.
    await repos.deployment.acknowledgeUnstartedBuildSession(buildSession.id);
  }
  // Broadcast cancelled AFTER service statuses so UI receives the service updates first
  sessionManager.updateStatus(dep.id, "cancelled");

  // A terminal-looking deployment row is not proof that its worker stopped.
  // Wait briefly for the outer pipeline finally to close the durable execution
  // lease. If it cannot do so in the cooperative window, keep the result
  // explicitly pending: callers must not claim cancellation completed or offer
  // an immediate redeploy while the old worker may still touch the target host.
  const quiescent = await waitForDeploymentQuiescence(dep.id, dep.projectId);
  if (!quiescent) {
    return {
      success: false,
      pending: true,
      status: "cancelling" as const,
      message:
        "Cancellation was requested, but the deployment worker is still stopping. " +
        "Redeploy remains blocked until cancellation finishes.",
    };
  }

  return {
    success: true,
    pending: false,
    status: "cancelled" as const,
    message: "Deployment cancelled",
  };
}

export async function redeployBuildSession(
  ctx: RequestContext,
  deploymentId: string,
  opts?: { useExistingCommit?: boolean; trigger?: string },
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
      "The Openship control plane updates itself — run `openship update` on the host, not a redeploy.",
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

  // Resources are a RUNTIME knob, not part of the build identity, so they must be
  // re-read from the project on every redeploy. Freezing them meant a
  // PATCH /projects/:id/resources was silently ignored forever: the container was
  // recreated from the original snapshot each time (and a manual
  // `docker update --memory` got wiped along with it). Reuse of the frozen
  // *source* (commit, build config) is still intentional — only these two fields
  // are refreshed. Rollback goes through triggerDeployment's reuseSnapshot path,
  // not here, so restoring an exact prior state is unaffected.
  meta.resources = (project.resources as ResourceConfig) || null;
  meta.buildResources = (project.buildResources as ResourceConfig) || null;

  if (!frozenMeta) {
    const t = await resolveSnapshotTarget(project);
    meta.deployTarget = t.deployTarget;
    meta.serverId = t.serverId;
    meta.runtimeMode = t.runtimeMode;
  }

  // buildStrategy is re-resolved on EVERY redeploy, frozen snapshot or not — it is a
  // policy answer about the instance, not part of the build identity, so it belongs
  // with `resources` above rather than with the frozen source.
  //
  // Passing the frozen value through as `explicit` keeps it: resolveStrategy returns
  // an explicit choice unchanged. The one thing it does NOT keep is a "local" that is
  // no longer permitted, because its CLOUD_MODE branch answers "server" before it
  // looks at `explicit`. That is the whole point — a project promoted from a
  // self-hosted install arrives with a frozen "local" and, while this sat inside the
  // `!frozenMeta` branch, every redeploy of it asked the cloud runtime to build on
  // the SaaS host. The runtime now refuses that too (HostBuildForbiddenError); this
  // is the half that keeps a legitimate deploy working instead of failing.
  meta.buildStrategy = await settingsService.resolveStrategy(meta.framework, meta.buildStrategy, {
    deployTarget: meta.deployTarget,
  });

  // Release/dist source: refresh the resolved dist dir. useExistingCommit →
  // redeploy the SAME version; default → newest advertised (parity with the
  // "redeploy latest commit" semantics below). Re-resolving also guards against
  // a frozen snapshot whose cached dist dir was since pruned.
  if (isReleaseProvider(project.gitProvider)) {
    // A same-version redeploy of an image release must replay the exact frozen
    // reference, even if the project template has since changed. The runtime
    // will re-pull it when the local artifact was pruned. Archive releases still
    // re-resolve their frozen version because their cached directory may be gone.
    const canReplayFrozenImage = opts?.useExistingCommit && Boolean(frozenMeta?.releaseImageRef);
    if (!canReplayFrozenImage) {
      await applyReleaseSourceToSnapshot(project, meta, {
        version: opts?.useExistingCommit
          ? (frozenMeta?.releaseTag ?? frozenMeta?.releaseVersion)
          : undefined,
      });
    }
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
  // reconcileComposeSource. A composePath bootstrap is intentionally strict;
  // an explicitly frozen single-app deployment must remain single and must not
  // materialize compose rows as a side effect of redeploying it.
  let currentProjectEnv = await repos.project.getEnvMap(project.id, oldDep.environment, null);
  let currentSourceInfo: SourceEnvInfo | undefined;
  if (meta.serviceDeploymentMode !== "single") {
    currentSourceInfo = await reconcileComposeSource(ctx, project, branch, {
      interpolationEnv: decryptEnvMap(currentProjectEnv),
    });
  }
  currentSourceInfo ??= await resolveLifecycleSourceEnv(ctx, project, branch);
  const sourceEnv = mergeSourceEnvDefaults(currentProjectEnv, currentSourceInfo);
  currentProjectEnv = sourceEnv.encrypted ?? {};
  if (sourceEnv.additions.length > 0) {
    await repos.project.mergeEnvVars(project.id, oldDep.environment, sourceEnv.additions, []);
  }

  const currentComposeRows = await listProjectComposeServices(project.id).catch(() => []);
  const currentComposeServices = projectServicesToDeployableServices(
    currentComposeRows.filter((s) => s.enabled),
  );
  // Strip PINNED ARTIFACTS: they are inputs to one specific deploy (a migration
  // cutover, or a rollback restoring a retained release). Carrying them onto a
  // Redeploy would keep re-deploying that stale image and never reclone+rebuild
  // (and 404 once the tag is reclaimed) — a redeployed project must behave like
  // a native repo project. A real rollback re-pins from its OWN target's meta.
  const forwardedMeta = withoutPinnedArtifacts(meta);
  const refreshedMeta: DeploymentConfigSnapshot = {
    ...forwardedMeta,
    composeServices: currentComposeServices.length > 0 ? currentComposeServices : undefined,
  };

  // ── Resolve rollback context (shared helper — single default) ─────────
  const { rollbackStrategy, commitShaBefore } = await resolveRollbackContext(project, branch);

  // Normal redeploy means current configuration + latest commit. The old
  // deployment's envVars is a release snapshot and belongs only to rollback.
  // Service-scoped rows stay out of this flat capture: the compose deployer
  // reads them live per service and applies them after compose inline env.
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
    envVars: Object.keys(currentProjectEnv).length > 0 ? currentProjectEnv : null,
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
  // Terminal states (ready/failed/cancelled/action_required) are also "do
  // nothing, return ok". `action_required` MUST be here: it is a settled failure
  // whose artifact is already gone, so without it this would re-run the build on
  // the existing row instead of no-op'ing, and the row's recorded blocker would
  // be overwritten mid-flight. Resolving a blocker creates a NEW deployment
  // (redeploy), it never restarts this one.
  if (
    [
      "building",
      "deploying",
      "ready",
      "failed",
      "cancelled",
      "action_required",
      "no_changes",
    ].includes(dep.status)
  ) {
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
    /**
     * Explicit registered-server target for CLI/API deploys. It is resolved by
     * the same snapshot-target and org-scoped preflight path as the dashboard;
     * omit it to retain the project's durable/active target.
     */
    serverId?: string;
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
    /** Internal deployment intent used by scoped incoming webhooks. Persisted
     * on this deployment's worker snapshot; deliberately not exposed by the
     * HTTP deployment controller. */
    forcePullImages?: boolean;
    /** Internal exclusive target scope. When true, services outside an
     * explicit serviceIds set are never started as a fallback when there is no
     * prior deployment to carry forward. */
    strictServiceScope?: boolean;
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
     * the compose-source reconciler so it can skip the GitHub scan when the compose
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
  if (data.serverId) await requireOrgServer(data.serverId, ctx.organizationId);
  // The Openship control plane IS the running host service, not a redeployable
  // workload — it updates itself via the CLI. It's a release-provider project, so
  // the git/localPath 403 below would NOT catch it; guard it explicitly.
  if (project.appTemplateId === "openship") {
    throw new ForbiddenError(
      "The Openship control plane updates itself — run `openship update` on the host, not a redeploy.",
    );
  }
  // Org-membership verified at the route boundary. No userId equality
  // check here — that would block team members.

  // Refuse for MISSING SOURCE only when this deploy actually needs source.
  //
  // A release/dist-source project has neither a git URL nor a stored localPath —
  // its dist dir is resolved per-deploy by applyReleaseSourceToSnapshot below.
  // Two more kinds legitimately have neither: a registry-image-only stack (an
  // adopted Docker migration, which builds nothing — the exemption preflight
  // already makes), and a ROLLBACK replaying pinned artifacts. Both used to be
  // refused here, before preflight could apply its own, smarter rule.
  if (
    !data.refresh &&
    !project.gitUrl &&
    !project.localPath &&
    !isReleaseProvider(project.gitProvider)
  ) {
    const sourceless = data.reuseSnapshot
      ? snapshotNeedsGitSource(data.reuseSnapshot.meta)
      : snapshotNeedsGitSource(
          { hasBuild: project.hasBuild ?? undefined },
          projectServicesToDeployableServices(
            (await listProjectComposeServices(project.id).catch(() => [])).filter((s) => s.enabled),
          ),
        );
    if (sourceless) {
      throw new ForbiddenError("Project has no git repository or local path configured");
    }
  }
  // GitHub access gate (default-deny; webhook ctx is the org owner and
  // passes). A reused snapshot that needs no Git source is an exact artifact
  // replay, so it must not be judged against a repository linked *after* the
  // target deployment was created. That is particularly important for a
  // release-image rollback after the project has since been relinked to Git.
  // Any replay that still clones source remains gated as usual.
  const needsGitRepositoryAccess =
    !data.reuseSnapshot || snapshotNeedsGitSource(data.reuseSnapshot.meta);
  if (needsGitRepositoryAccess) {
    await assertGitHubRepoAccess(ctx, {
      owner: project.gitOwner,
      repo: project.gitRepo,
    });
  }

  const branch = await resolveProjectBranch(ctx, project, data.branch);
  const environment = data.environment ?? "production";
  // Before the dedupe below and before anything stores it: one canonical sha, so
  // the row a webhook compares against and the row the drift check reads are
  // written in the same alphabet. See canonicalizeCommitRef.
  const requestedCommitSha = await canonicalizeCommitRef(ctx, project, data.commitSha);

  // Skip an auto (webhook) deploy whose commit is already in-flight or live —
  // closes the App + repo-webhook double-deploy window. Manual/forceAll bypass.
  if (data.trigger === "webhook" && !data.forceAll && requestedCommitSha) {
    const inFlight = await repos.deployment
      .findInProgressByCommit(project.id, requestedCommitSha)
      .catch(() => undefined);
    const active = project.activeDeploymentId
      ? await repos.deployment.findById(project.activeDeploymentId).catch(() => null)
      : null;
    const existing =
      inFlight ??
      (compareCommitSha(active?.commitSha, requestedCommitSha) === "same" ? active : null);
    if (existing) {
      console.log(
        `[Deploy] project ${project.id}: webhook deploy for ${requestedCommitSha} skipped — already ${inFlight ? "in progress" : "live"} (${existing.id}).`,
      );
      return { deployment: existing, skipped: true as const };
    }
  }

  await checkNoActiveBuild(project.id);

  // Reconcile upstream compose drift before the pipeline reads service rows —
  // covers webhook (git push) + manual triggers. Skip atomic rollback: it must
  // ship the frozen snapshot verbatim. `changedPaths` (webhook) lets it skip the
  // repo scan when the push didn't touch the compose file. Existing projects
  // reconcile best-effort; a declared compose project with no rows is strict so
  // it cannot silently fall through with an empty service set.
  if (data.strictServiceScope && !data.serviceIds?.length) {
    throw new AppError("An exact deployment scope requires at least one service ID", 400);
  }

  // Freeze the project env before source reconciliation. This same encrypted
  // map is attached to the deployment below, so Compose image interpolation
  // and the worker cannot observe two different configuration revisions.
  let encryptedEnvVars: Record<string, string> | null;
  if (data.reuseSnapshot) {
    encryptedEnvVars = data.reuseSnapshot.envVars;
  } else {
    const rawEnvMap = await repos.project.getEnvMap(project.id, environment, null);
    encryptedEnvVars = Object.keys(rawEnvMap).length > 0 ? rawEnvMap : null;
  }

  if (!data.reuseSnapshot && data.trigger !== "rollback") {
    let sourceInfo: SourceEnvInfo | undefined = await reconcileComposeSource(ctx, project, branch, {
      changedPaths: data.changedPaths,
      interpolationEnv: decryptEnvMap(encryptedEnvVars ?? {}),
    });
    sourceInfo ??= await resolveLifecycleSourceEnv(ctx, project, branch);
    const sourceEnv = mergeSourceEnvDefaults(encryptedEnvVars, sourceInfo);
    encryptedEnvVars = sourceEnv.encrypted;
    if (sourceEnv.additions.length > 0) {
      await repos.project.mergeEnvVars(project.id, environment, sourceEnv.additions, []);
    }
  }

  // Scoped internal callers (incoming deploy hooks) require an exact target
  // set. Re-check after compose reconciliation because that step can remove,
  // replace, or disable service rows after the hook-level validation ran. A
  // stale ID must fail before a deployment row is queued, never degrade into a
  // partial or broader deployment.
  if (data.strictServiceScope && data.serviceIds?.length) {
    try {
      assertExactServiceTargets(await repos.service.listByProject(project.id), data.serviceIds);
    } catch (err) {
      throw new AppError(safeErrorMessage(err), 400);
    }
  }

  // ATOMIC rollback path: reuse the target deployment's frozen snapshot verbatim
  // (its build config was already resolved + valid at original-deploy time).
  // Normal path: build a fresh snapshot from the project's current columns.
  const reuse = data.reuseSnapshot;
  const snapshot = reuse
    ? ({ ...reuse.meta } as DeploymentConfigSnapshot)
    : buildConfigSnapshot(project, branch);
  // This is an instruction for THIS run, not release configuration. In
  // particular, a rollback that reuses a snapshot from an incoming webhook
  // must not inherit its force-pull behavior.
  if (data.forcePullImages) snapshot.forcePullImages = true;
  else delete snapshot.forcePullImages;
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
    const resolvedTarget = await resolveSnapshotTarget(
      project,
      data.serverId ? { deployTarget: "server", serverId: data.serverId } : undefined,
    );
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

  {
    // Non-UI callers (CI, webhook, manual API) don't pass buildStrategy, so the
    // snapshot inherits `undefined` from buildConfigSnapshot and the later
    // fallback at resolveBuildGitToken collapses everything to "server". Run
    // it through resolveStrategy so a non-cloud stack with a "local" default
    // gets the same answer the UI would give — single source of truth.
    //
    // Runs for a REUSED (rollback) snapshot too. That looks like it contradicts
    // "restore the exact prior state", and for the source it would — but a frozen
    // explicit value is returned unchanged here, so the only thing a rollback loses
    // is a "local" the instance no longer permits, which it could not have honoured
    // anyway (the cloud runtime refuses it at the sink). Rolling back to a build that
    // cannot run is not a restored state.
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
  freezeResolvedServicePipeline(snapshot, { useServicePipeline, servicePreflightServices });

  // Resolve once, before preflight: a single-app refresh is a pinned-artifact
  // deploy, so preflight and git-token resolution must both see that it needs no
  // source/build. The active row is also the artifact owner for Bare releases.
  let refreshActive: Awaited<ReturnType<typeof repos.deployment.findById>> | null = null;
  if (data.refresh) {
    refreshActive = project.activeDeploymentId
      ? await repos.deployment.findById(project.activeDeploymentId).catch(() => null)
      : null;
    if (!refreshActive) {
      throw new AppError("Nothing to refresh yet — deploy the project first.", 409);
    }

    if (!useServicePipeline) {
      const workload = snapshotToClass(snapshot).workload;
      if (workload === "static") {
        throw new AppError(
          "This is a static site, so it has no running environment to refresh. Use Redeploy when its build environment changes.",
          409,
        );
      }
      if (snapshot.deployTarget === "cloud") {
        throw new AppError(
          "Apply without rebuilding is not available for this cloud app yet. Use Redeploy to apply its environment changes.",
          409,
        );
      }
      snapshot.refreshAppDeploymentId = refreshActive.id;
      if (refreshActive.imageRef) snapshot.handoverAppImage = refreshActive.imageRef;
    }
  }

  // ── Preflight: validate config before creating any resources ────
  await runDeploymentPreflight(snapshot, routeState, {
    ctx,
    composeServices: servicePreflightServices,
    multiService: useServicePipeline,
    gitOwner: project.gitOwner,
    projectId: project.id,
    // An app project carries its catalog id; a never-deployed one is the only
    // deploy a host-capacity shortfall is allowed to refuse.
    appTemplateId: project.appTemplateId,
    firstDeploy: !project.activeDeploymentId,
  });

  // ── Resolve commit info: fetch HEAD from GitHub if not provided ────
  let commitSha = requestedCommitSha;
  let commitMessage = data.commitMessage;
  if (data.refresh && refreshActive) {
    // Refresh never pulls new code. Keep the active commit only for display.
    commitSha = refreshActive.commitSha ?? commitSha;
    commitMessage = commitMessage ?? refreshActive.commitMessage ?? undefined;
  }
  // Fetch HEAD only for a deploy that actually needs SOURCE. A refresh must
  // never touch git; neither must a restore whose artifacts are all pinned (its
  // release may predate any commit at all — a local-path or folder-upload
  // project — and reaching for GitHub there would fail a rollback that has
  // everything it needs on disk).
  if (!commitSha && !data.refresh && snapshotNeedsGitSource(snapshot)) {
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
    if (target.length === 0 && useServicePipeline) {
      throw new AppError(
        "Nothing to refresh — this services project has no enabled services to re-apply config to.",
        409,
      );
    }
    finalForceAll = false;
    // A single app has no service rows by design. Its refresh marker above
    // drives retained-artifact reuse; leaving these undefined keeps it on the
    // single-app pipeline without turning an empty subset into "build all".
    finalServiceIds = target.length > 0 ? target : undefined;
    refreshServiceIds = target.length > 0 ? target : undefined;
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
    strictServiceScope: data.strictServiceScope,
    changedPaths: resolvedChangedPaths ?? null,
  });

  const buildSessionId = await kickoffBuild(project, dep);
  if (!buildSessionId) throw new Error("Build session was not created");

  return {
    deployment: dep,
  };
}
