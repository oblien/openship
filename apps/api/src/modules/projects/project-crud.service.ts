/**
 * Project CRUD service - create, read, update, list, ensure.
 */

import { repos, type Deployment, type NewProject, type Project, type Server } from "@repo/db";
import {
  slugify,
  NotFoundError,
  ConflictError,
  ForbiddenError,
  ValidationError,
  SYSTEM,
  safeErrorMessage,
  compareSemver,
  isReleaseProvider,
  isBehind,
  GITHUB_REPO,
  normalizeRollbackWindow,
  normalizeAliasStrict,
  aliasConflictsWithSiblings,
  normalizeFramework,
  type ReleaseSource,
  type UpdatableIdentity,
} from "@repo/core";
import type { ResourceConfig } from "@repo/adapters";
import { encodeResources } from "../../lib/resources";
import { resolveLatestVersion, resolveLatestReleaseTag, readApiVersion } from "../../lib/release-resolver";
import { resolveLatestImageDigest } from "../../lib/image-registry";
import { env } from "../../config";
import { assertResourceInOrg } from "../../lib/controller-helpers";
import type { RequestContext } from "../../lib/request-context";
import {
  resolveDefaultBranch,
  listBranches as listGitHubBranches,
  getLatestCommit,
  resolveWebhookStrategy,
} from "../github/github.service";
import { getInstallationIdByOrg, getInstallUrl } from "../github/github.auth";
import { domainWebhookUrl } from "../../lib/public-url";
import { ensureSharedWebhook } from "./project-git-webhook";
import {
  deriveEnvironmentPublicEndpoints,
  deriveNextProjectRouteState,
  listProjectRouteRows,
  persistProjectRouteState,
  reapplyProjectLiveRoutes,
  resolveProjectRouteState,
  syncProjectRouteState,
  type ProjectRouteState,
} from "../domains/project-route.service";
import { applyProjectRouting } from "../domains/routing-apply.service";
import { syncProjectManagedEdge } from "./project-runtime.service";
import { normalizeStoredPublicEndpoints, publicEndpointHostname } from "../../lib/public-endpoints";
import { assertFreeEndpointsAllowed } from "../../lib/free-domain-guard";
import { assertValidCustomDomains, customHostnamesOf } from "../../lib/custom-domain-guard";
import { hasMaskedValue, unmaskEnv } from "../../lib/secret-env";
import { getFolderSession } from "./folder/session-store";
import type {
  TCreateProjectBody,
  TCreateProjectEnvironmentBody,
  TEnsureProjectBody,
  TUpdateProjectBody,
} from "./project.schema";
import { UpdateProjectBody } from "./project.schema";

/**
 * Mass-assignment allow-list for PATCH /projects/:id — the exact set of
 * client-editable fields (the UpdateProjectBody schema surface). The request
 * body is only TYPE-cast (no runtime validation), so `updateProject` MUST build
 * its DB patch from this list and never spread the raw body — otherwise a
 * project:write caller could set internal state columns (activeDeploymentId,
 * organizationId, …). Derived columns (slug, gitUrl) are set explicitly, not here.
 */
const PROJECT_UPDATE_KEYS = Object.keys(UpdateProjectBody.properties);

/**
 * Repo-IDENTITY columns the generic updateProject must NOT set — only the
 * validated linker (POST /git/link → linkProjectRepo) may repoint a project's
 * repo, with branch/installation/webhook validation + sibling fan-out. A raw
 * PATCH of these would be an unvalidated cross-repo repoint. gitBranch is
 * intentionally excluded (stays editable, parity with setBranch); gitUrl is
 * derived by the linker and never set via PATCH.
 */
const GIT_SOURCE_IDENTITY_KEYS = new Set([
  "gitProvider",
  "gitOwner",
  "gitRepo",
  "installationId",
]);

/** Derived from the route validator so the accepted fields can't drift from it. */
type EnsureProjectBody = TEnsureProjectBody;

/** One entry of the ensure body's `services` — the compose row shape on the wire. */
type ParsedComposeServiceInput = NonNullable<EnsureProjectBody["services"]>[number];

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** The deploy target + server aren't project columns — they live in the active
 *  deployment's `meta` JSON. This is the one place that parse happens, so every
 *  caller (enrichProject, its batch variant, getGitInfo) reads them the same
 *  way. Server *name* resolution stays at the call site because single vs batch
 *  fetch it differently (one `server.get` vs a prefetched map). */
function readDeployMeta(dep: Deployment | null | undefined): {
  deployTarget: string | null;
  serverId: string | null;
} {
  const meta = (dep?.meta ?? null) as { deployTarget?: string; serverId?: string } | null;
  return {
    deployTarget: meta?.deployTarget ?? null,
    serverId: meta?.serverId ?? null,
  };
}

// The attention predicates live in a dependency-free leaf module so the
// pending-actions aggregator can share them without importing this file's graph.
// Imported (this file calls one below) AND re-exported, because the
// project.service barrel is the established import surface for callers.
import { deploymentIsBlocked, deploymentRoutingUnsynced } from "./deployment-flags";
export { deploymentIsBlocked, deploymentRoutingUnsynced };

/** The live release's human version + state, surfaced on project cards so the
 *  UI can show "which v is live" and flag a partial deploy that is still
 *  awaiting the operator's keep/reject decision (`awaitingDecision`). Derived
 *  from the active deployment row (already fetched by the enrich callers). */
function readActiveDeploymentSummary(dep: Deployment | null | undefined): {
  activeVersion: number | null;
  activeDeploymentStatus: string | null;
  awaitingDecision: boolean;
  routingUnsynced: boolean;
} {
  const meta = (dep?.meta ?? null) as {
    composeDeployment?: { decision?: string };
    edgeUnsynced?: boolean;
    deployWarning?: string;
  } | null;
  return {
    activeVersion: dep?.version ?? null,
    activeDeploymentStatus: dep?.status ?? null,
    awaitingDecision: meta?.composeDeployment?.decision === "pending",
    // Live, but the free .opsh.io edge route didn't sync — surfaced as
    // "Action Required" with a Retry routing action (see routing/retry).
    routingUnsynced: deploymentRoutingUnsynced(dep),
  };
}

/** Enrich a project row with computed fields. `deployTarget` is the
 *  only signal the dashboard needs — `deployTarget === "cloud"` IS
 *  the cloud-project test; the dashboard combines it with its own
 *  CloudContext.connected state to decide whether to render the
 *  "Reconnect Openship Cloud" gate. No duplicate booleans here. */
export async function enrichProject(p: Project) {
  const production = p.resources as ResourceConfig | null;
  const build = p.buildResources as ResourceConfig | null;

  // Resolve deploy target + server (id + name) from the active deployment's meta
  let deployTarget: string | null = null;
  let serverId: string | null = null;
  let serverName: string | null = null;
  let activeDep: Deployment | null = null;
  if (p.activeDeploymentId) {
    activeDep = (await repos.deployment.findById(p.activeDeploymentId)) ?? null;
    ({ deployTarget, serverId } = readDeployMeta(activeDep));
  }
  // The durable project.serverId is the source of truth for the server binding;
  // meta.serverId is a per-deploy snapshot a fresh/partial deploy can drop. Fall
  // back to the column so the binding (and its name) survive a stale snapshot.
  serverId = serverId ?? p.serverId ?? null;
  if (serverId) {
    const server = await repos.server.get(serverId);
    serverName = server?.name || server?.sshHost || null;
  }

  return {
    ...p,
    deployTarget,
    serverId,
    serverName,
    ...readActiveDeploymentSummary(activeDep),
    // isCloud decides the fallback when nothing is configured: the metered free
    // tier on cloud, NO limits self-hosted (the machine is the cap).
    resources: encodeResources(production, build, p.sleepMode ?? "auto_sleep", p.port ?? 3000, {
      isCloud: deployTarget === "cloud",
    }),
  };
}

/**
 * Batch variant of enrichProject — pre-fetches every active deployment
 * + every referenced server in two SQL round trips for N projects,
 * then enriches each project from the lookup maps. Used by the home
 * page (getHome) where the per-project query fan-out is the hottest
 * source of N+1 latency.
 *
 * Per-project query count: 0 (data is pre-fetched).
 * Total SQL cost: 1 (deployment.findManyById) + 1 (server.getMany).
 */
export async function enrichProjectsBatch(
  projects: Project[],
): Promise<Array<Awaited<ReturnType<typeof enrichProject>>>> {
  const activeDeploymentIds = projects
    .map((p) => p.activeDeploymentId)
    .filter((id): id is string => Boolean(id));
  const deployments = await repos.deployment
    .findManyById(activeDeploymentIds)
    .catch(() => new Map<string, Deployment>());

  const serverIds = new Set<string>();
  for (const d of deployments.values()) {
    const meta = d.meta as { serverId?: string } | null;
    if (meta?.serverId) serverIds.add(meta.serverId);
  }
  // Prefetch the durable column's servers too — enrich coalesces to it when the
  // snapshot meta dropped serverId, so its name must be in the map (see below).
  for (const p of projects) {
    if (p.serverId) serverIds.add(p.serverId);
  }
  const servers = await repos.server
    .getMany(Array.from(serverIds))
    .catch(() => new Map<string, Server>());

  return projects.map((p) => {
    const production = p.resources as ResourceConfig | null;
    const build = p.buildResources as ResourceConfig | null;

    let deployTarget: string | null = null;
    let serverId: string | null = null;
    let serverName: string | null = null;
    let activeDep: Deployment | null = null;
    if (p.activeDeploymentId) {
      activeDep = deployments.get(p.activeDeploymentId) ?? null;
      ({ deployTarget, serverId } = readDeployMeta(activeDep));
    }
    serverId = serverId ?? p.serverId ?? null;
    if (serverId) {
      const server = servers.get(serverId);
      serverName = server?.name || server?.sshHost || null;
    }

    return {
      ...p,
      deployTarget,
      serverId,
      serverName,
      ...readActiveDeploymentSummary(activeDep),
      // isCloud decides the fallback when nothing is configured: the metered
      // free tier on cloud, NO limits self-hosted (the machine is the cap).
      resources: encodeResources(production, build, p.sleepMode ?? "auto_sleep", p.port ?? 3000, {
        isCloud: deployTarget === "cloud",
      }),
    };
  });
}

function projectGitUrl(owner?: string | null, repo?: string | null) {
  return owner && repo ? `https://github.com/${owner}/${repo}.git` : undefined;
}

function resolveProjectSource(data: TCreateProjectBody) {
  // Release/dist source: a prebuilt dist, no git repo and no stored localPath
  // (its dir is resolved per-deploy). The source repo, if any, lives in
  // releaseSource — the project-level gitOwner/gitRepo columns stay null so the
  // commit-drift path is never taken for it.
  const isRelease = isReleaseProvider(data.gitProvider);
  // Release/dist deploys resolve a prebuilt dir onto THIS box's filesystem
  // (download + extract into ~/.openship) — a self-hosted runtime concern.
  // Blocked in cloud mode, same as localPath below: the SaaS builds in Oblien
  // sandboxes and must never write a tenant's dist onto the shared control plane.
  if (isRelease && env.CLOUD_MODE) {
    throw new ForbiddenError("Release/dist source projects are not available in cloud mode");
  }
  const safeLocalPath = !isRelease && data.localPath && !env.CLOUD_MODE ? data.localPath : undefined;
  const gitOwner = isRelease || safeLocalPath ? undefined : data.gitOwner;
  const gitRepo = isRelease || safeLocalPath ? undefined : data.gitRepo;

  return {
    safeLocalPath,
    gitOwner,
    gitRepo,
    gitProvider: isRelease ? "release" : safeLocalPath ? "local" : (data.gitProvider ?? "github"),
    gitUrl: projectGitUrl(gitOwner, gitRepo),
    releaseSource: isRelease ? ((data.releaseSource as ReleaseSource | undefined) ?? null) : null,
  };
}

function normalizeEnvironmentSlug(input?: string | null, fallback = "production") {
  return slugify(input || fallback) || fallback;
}

/**
 * The compose pin as it should hit the column: a trimmed path, or NULL to go back
 * to detecting the root. Blank-means-null in ONE place, because every write path
 * needs it — the settings form sends `""` for a blanked field, and the deploy
 * wizard sends `""` when the user clears the pin. Returning `""` instead would
 * leave a falsy-but-present value that still counts as "declared" downstream.
 */
function normalizeComposePath(value: string | null | undefined): string | null {
  return value?.trim() ? value.trim() : null;
}

function environmentNameFromSlug(slug: string) {
  return (
    slug
      .split("-")
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ") || "Production"
  );
}

async function ensureProjectApp(
  data: TCreateProjectBody,
  slug: string,
  organizationId: string,
) {
  let app = await repos.projectGroup.findBySlugInOrg(organizationId, slug);
  if (app) return { app, created: false };

  const source = resolveProjectSource(data);

  app = await repos.projectGroup.create({
    organizationId,
    name: data.name,
    slug,
    gitProvider: source.gitProvider,
    gitOwner: source.gitOwner,
    gitRepo: source.gitRepo,
    gitUrl: source.gitUrl,
    installationId: data.installationId,
  });

  return { app, created: true };
}

function buildProductionProjectInput(
  groupId: string,
  data: TCreateProjectBody,
  slug: string,
  routing: ProjectRouteState,
  organizationId: string,
): Omit<NewProject, "id"> {
  const source = resolveProjectSource(data);

  return {
    organizationId,
    groupId,
    name: data.name,
    slug,
    environmentName: "Production",
    environmentSlug: "production",
    environmentType: "production",
    localPath: source.safeLocalPath,
    gitProvider: source.gitProvider,
    gitOwner: source.gitOwner,
    gitRepo: source.gitRepo,
    gitBranch: data.gitBranch ?? "main",
    gitUrl: source.gitUrl,
    releaseSource: source.releaseSource,
    installationId: data.installationId,
    autoDeploy: !!(env.CLOUD_MODE && source.gitOwner && source.gitRepo),
    framework: normalizeFramework(data.framework),
    packageManager: data.packageManager ?? "npm",
    installCommand: data.installCommand,
    buildCommand: data.buildCommand,
    outputDirectory: data.outputDirectory,
    productionPaths: data.productionPaths,
    // undefined (not declared) leaves the column NULL, which resolves to the
    // stack's persistentPaths at deploy — that's what makes it zero-config.
    volumes: data.volumes,
    rootDirectory: data.rootDirectory,
    composePath: normalizeComposePath(data.composePath),
    startCommand: data.startCommand,
    buildImage: data.buildImage,
    productionMode: data.productionMode ?? (data.hasServer === false ? "static" : "host"),
    port: data.port ?? 3000,
    hasServer: data.hasServer ?? true,
    hasBuild: data.hasBuild ?? true,
    workspacePrepareCommand:
      data.projectType === "monorepo"
        ? data.monorepoWorkspace?.prepareCommand ?? null
        : null,
    routingConfig: data.routingConfig ?? null,
    rollbackWindow:
      data.rollbackWindow !== undefined ? normalizeRollbackWindow(data.rollbackWindow) : null,
    cloudArchiveStrategy: data.cloudArchiveStrategy ?? undefined,
    defaultRollbackStrategy: data.defaultRollbackStrategy ?? undefined,
    // Edge→app upstream addressing. Omitted → schema default "auto" (loopback-
    // port). The wizard seeds this from the user's route-strategy default.
    routeStrategy: data.routeStrategy ?? undefined,
    // Deploy-time readiness gate. Omitted → null → OFF: the deploy does no
    // post-start waiting. Only set when the wizard's Health section (or
    // openship.json's `readiness`) opted in.
    readiness: data.readiness ?? null,
    isApp: data.isApp ?? false,
    appTemplateId: data.appTemplateId ?? null,
    // Services / docker(-compose) projects can only run on the Docker runtime, so
    // pin it at creation — same rule the deploy wizard applies via
    // normalizeRuntimeMode. Without this the row's runtime_mode is null, the
    // deploy resolves to "bare", and a compose deploy fails with "services are
    // not supported on the bare runtime". Git apps/monorepos stay null (chosen at
    // deploy time).
    runtimeMode:
      data.projectType === "services" || data.projectType === "docker" ? "docker" : null,
  };
}

async function persistMonorepoApps(
  projectId: string,
  data: TCreateProjectBody,
): Promise<void> {
  if (data.projectType !== "monorepo" || !data.monorepoApps?.length) return;

  // #336: monorepo rows are masked on read too (withDrift has no kind filter),
  // so a client echoing them back sends the sentinel — unmask-merge against the
  // stored row before persisting, same rule as persistComposeServices, else an
  // edit clobbers the stored secret / ships "••••••••" into the container.
  //
  // The rows are read for the hostname gate too (#342): a sub-app's custom domain
  // becomes a vhost like any other, so a bogus one is refused here — except when
  // the row already carries it, which is just this payload echoing stored state back.
  const needsRows =
    data.monorepoApps.some((app) => hasMaskedValue(app.environment)) ||
    customHostnamesOf(data.monorepoApps).length > 0;
  const storedRows = needsRows
    ? await repos.service.listByProjectKind(projectId, "monorepo").catch(() => [])
    : [];
  const storedEnvByName = new Map<string, Record<string, string>>(
    storedRows.map((row) => [row.name, (row.environment as Record<string, string> | null) ?? {}]),
  );
  assertValidCustomDomains(data.monorepoApps, { known: customHostnamesOf(storedRows) });

  await repos.service.syncMonorepoApps(
    projectId,
    data.monorepoApps.map((app) => ({
      name: app.name,
      rootDirectory: app.rootDirectory,
      framework: app.framework ?? null,
      packageManager: app.packageManager ?? null,
      buildImage: app.buildImage ?? null,
      installCommand: app.installCommand ?? null,
      buildCommand: app.buildCommand ?? null,
      startCommand: app.startCommand ?? null,
      outputDirectory: app.outputDirectory ?? null,
      port: app.port ?? null,
      enabled: app.enabled ?? true,
      exposed: app.exposed ?? true,
      exposedPort: app.port != null ? String(app.port) : null,
      domain: app.domain ?? null,
      customDomain: app.customDomain ?? null,
      domainType: app.domainType ?? "free",
      environment: hasMaskedValue(app.environment)
        ? unmaskEnv(app.environment, storedEnvByName.get(app.name) ?? null)
        : app.environment ?? {},
    })),
  );
}

/**
 * Persist the compose services carried by an ensure request — the counterpart to
 * `persistMonorepoApps` for the OTHER multi-app shape.
 *
 * The folder-upload flow (folder/scan → projects/ensure → deployments/build/access)
 * has no other step that owns the parsed compose: without this, `ensure` created
 * the project and dropped the scan's `services`, so the first deploy ran the
 * services pipeline against ZERO rows and failed with "No services were found
 * for this project" (#334).
 *
 * `syncFromCompose` OWNS the compose rows (creates/updates listed ones, removes
 * unlisted), so the caller must send the whole set — the same contract as
 * POST /projects/:id/services/sync. Monorepo rows are a different `kind` and
 * survive untouched.
 *
 * #336: the scan MASKS compose env on output, so a client echoing its `services`
 * back sends the `••••••••` sentinel. Unmask-merge before persisting — same rule
 * as every other write path (syncComposeServices, createService, build/access):
 * restore from the upload session the scan captured pre-mask, else the stored row,
 * else drop the key. The sentinel is never written.
 */
async function persistComposeServices(
  projectId: string,
  organizationId: string,
  data: EnsureProjectBody,
): Promise<void> {
  if (!data.services?.length) return;

  // #342: a compose service's custom domain becomes a vhost like the project's own,
  // so it gets the same shape gate — exempting hostnames the stored rows already
  // carry, so re-syncing a project that holds a bad one isn't refused outright.
  // Only reads the rows when a custom hostname is actually in play.
  if (customHostnamesOf(data.services).length) {
    const rows = await repos.service.listByProject(projectId).catch(() => []);
    assertValidCustomDomains(data.services, { known: customHostnamesOf(rows) });
  }

  let services: ParsedComposeServiceInput[] = data.services;
  if (services.some((svc) => hasMaskedValue(svc.environment))) {
    // Same precedence as requestBuildAccess: stored rows first, then the upload
    // session — for a fresh scan the uploaded compose is the newer truth.
    const realEnvByName = new Map<string, Record<string, string>>();
    for (const row of await repos.service.listByProject(projectId).catch(() => [])) {
      realEnvByName.set(row.name, (row.environment as Record<string, string> | null) ?? {});
    }
    const session = data.uploadSessionId ? getFolderSession(data.uploadSessionId) : undefined;
    if (session && session.orgId === organizationId) {
      for (const svc of session.services ?? []) {
        if (svc.name && svc.environment) realEnvByName.set(svc.name, svc.environment);
      }
    }
    services = services.map((svc) => {
      if (!hasMaskedValue(svc.environment)) return svc;
      const restored = unmaskEnv(svc.environment, realEnvByName.get(svc.name) ?? null);
      if (Object.keys(restored).length < Object.keys(svc.environment ?? {}).length) {
        // Warn so a secret lost this way is traceable (mirrors createService).
        console.warn(
          `[ensureProject] service "${svc.name}": dropped masked env value(s) with no stored source` +
            (data.uploadSessionId ? "" : " — pass uploadSessionId to restore them"),
        );
      }
      return { ...svc, environment: restored };
    });
  }

  await repos.service.syncFromCompose(projectId, services);
}

async function createProductionProject(
  data: TCreateProjectBody,
  slug: string,
  organizationId: string,
) {
  // Atomic free-domain gate — same rule and shape as updateProject. When the
  // caller EXPLICITLY sends endpoints, a free (*.opsh.io) route only resolves
  // behind the Openship Cloud edge, so refuse BEFORE any group/project row is
  // written on a disconnected instance (no dead "Pending" route persisted). The
  // auto-derived default (data.publicEndpoints undefined) is deliberately NOT
  // gated — that path must keep working on a self-hosted instance.
  if (data.publicEndpoints !== undefined) {
    await assertFreeEndpointsAllowed(
      organizationId,
      normalizeStoredPublicEndpoints(data.publicEndpoints),
    );
  }
  // Same placement, same reason as the free-endpoint gate above: refuse a bogus
  // custom hostname BEFORE ensureProjectApp writes a project-group row, so a rejected
  // create leaves nothing behind (the funnel and the persist* helpers below would
  // each catch it, but only after that row exists). Unconditional: a brand-new
  // project has no prior hostnames, so everything in the body is net-new. #342
  // `services` only exists on the ensure body (which creates through here too).
  assertValidCustomDomains([
    { publicEndpoints: data.publicEndpoints },
    ...(data.monorepoApps ?? []),
    ...((data as Partial<EnsureProjectBody>).services ?? []),
  ]);
  const { app, created: appCreated } = await ensureProjectApp(data, slug, organizationId);
  const routing = deriveNextProjectRouteState({
    slug,
  }, {
    nextPublicEndpoints: data.publicEndpoints,
    slug,
  });

  try {
    const created = await repos.project.create(
      buildProductionProjectInput(app.id, data, slug, routing, organizationId),
    );
    await persistProjectRouteState(created.id, routing.publicEndpoints);
    await persistMonorepoApps(created.id, data);
    return created;
  } catch (err) {
    if (appCreated) {
      await repos.projectGroup.softDelete(app.id).catch(() => {});
    }
    throw err;
  }
}

/**
 * Create a `services` project while PRESERVING an explicit project id — the
 * re-import path (recovering an Openship project from a server's manifest). The
 * preserved id means the server's still-running containers (labelled
 * `openship.project=<id>`) re-attach immediately: teardown/reclaim/network
 * reconcile recognize them, and a later redeploy replaces same-id containers
 * cleanly. The slug is preserved when free, else uniquified (so the free
 * subdomain regenerates to the original). Enforces the quota and creates a
 * fresh project group; rolls the group back if the project insert fails.
 *
 * This deliberately does NOT go through `ensureProject` (name-based dedupe +
 * generated id) — re-import needs the exact id and a create-only path.
 */
export async function createServicesProjectWithId(opts: {
  id: string;
  name: string;
  slug: string;
  organizationId: string;
  hasBuild?: boolean;
  runtimeMode?: "bare" | "docker";
  gitProvider?: string | null;
  gitOwner?: string | null;
  gitRepo?: string | null;
  gitBranch?: string | null;
  autoDeploy?: boolean;
}): Promise<Project> {
  await assertProjectQuota(opts.organizationId);
  const slug = await uniqueProjectSlug(opts.organizationId, opts.slug);

  const group = await repos.projectGroup.create({
    organizationId: opts.organizationId,
    name: opts.name,
    slug,
    gitProvider: opts.gitProvider ?? undefined,
    gitOwner: opts.gitOwner ?? undefined,
    gitRepo: opts.gitRepo ?? undefined,
    gitUrl: projectGitUrl(opts.gitOwner, opts.gitRepo),
  });

  try {
    const routing = deriveNextProjectRouteState({ slug }, { slug });
    const created = await repos.project.create({
      id: opts.id,
      organizationId: opts.organizationId,
      groupId: group.id,
      name: opts.name,
      slug,
      environmentName: "Production",
      environmentSlug: "production",
      environmentType: "production",
      gitProvider: opts.gitProvider ?? "github",
      gitOwner: opts.gitOwner ?? undefined,
      gitRepo: opts.gitRepo ?? undefined,
      gitBranch: opts.gitBranch ?? "main",
      gitUrl: projectGitUrl(opts.gitOwner, opts.gitRepo),
      autoDeploy: !!opts.autoDeploy,
      framework: "unknown", // services project — the stack lives on each service row
      packageManager: "npm",
      hasServer: true,
      hasBuild: opts.hasBuild ?? false,
      // services ⇒ docker runtime (same rule buildProductionProjectInput applies).
      runtimeMode: opts.runtimeMode === "bare" ? "bare" : "docker",
    });
    await persistProjectRouteState(created.id, routing.publicEndpoints);
    return created;
  } catch (err) {
    await repos.projectGroup.softDelete(group.id).catch(() => {});
    throw err;
  }
}

/**
 * Link a GitHub repo to a project — the reusable core of the `linkRepo`
 * controller, callable WITHOUT a Hono Context (the migration orchestrator links
 * a repo to a freshly-adopted project, and it only has a RequestContext). Sets
 * the project's git fields, resolves the default branch, registers a push
 * webhook per the instance's strategy, and propagates the source to sibling
 * environments. Returns a discriminated outcome so each caller maps its own
 * response: the controller → HTTP JSON (incl. the app-not-installed install_url),
 * the orchestrator → best-effort log. Does NOT audit — the controller owns that.
 */
export type LinkProjectRepoOutcome =
  | { ok: true; owner: string; repo: string; branch: string; strategy: string; autoDeploy: boolean }
  | { ok: false; code: "not_found" }
  | { ok: false; code: "invalid"; message: string }
  | { ok: false; code: "app_not_installed"; owner: string; installUrl: string };

export async function linkProjectRepo(
  ctx: RequestContext,
  projectId: string,
  input: { owner: string; repo: string; branch?: string; installationId?: number },
): Promise<LinkProjectRepoOutcome> {
  const { organizationId } = ctx;
  const owner = input.owner?.trim();
  const repo = input.repo?.trim();
  if (!owner || !repo) return { ok: false, code: "invalid", message: "owner and repo are required" };

  const project = await repos.project.findById(projectId);
  try {
    assertResourceInOrg(project, "Project", organizationId, projectId);
  } catch {
    return { ok: false, code: "not_found" };
  }

  const gitUrl = projectGitUrl(owner, repo);
  const defaultBranch = await resolveDefaultBranch(ctx, owner, repo, input.branch);

  const gitFields: Record<string, unknown> = {
    gitProvider: "github",
    gitOwner: owner,
    gitRepo: repo,
    gitBranch: defaultBranch,
    gitUrl,
  };

  const strategy = await resolveWebhookStrategy(project!);

  if (strategy === "app") {
    const resolvedInstId = await getInstallationIdByOrg(organizationId, owner);
    if (!resolvedInstId) {
      return { ok: false, code: "app_not_installed", owner, installUrl: getInstallUrl() };
    }
    gitFields.installationId = resolvedInstId;
    gitFields.autoDeploy = true;
  } else if (strategy === "domain" || strategy === "repo") {
    // Register/reuse the repo webhook via the SHARED reconciler (org+repo scoped,
    // deactivates a superseded hook, fans the webhookId across same-repo projects)
    // — the exact path setAutoDeploy uses, instead of a bespoke registerWebhook.
    // A failure just means no auto-deploy yet; the link still succeeds and the
    // user can enable it later.
    const webhookUrl =
      strategy === "domain" ? domainWebhookUrl(project!.webhookDomain!) : undefined;
    const hookId = await ensureSharedWebhook(ctx, project!, owner, repo, webhookUrl).catch(
      () => null,
    );
    if (hookId) {
      gitFields.webhookId = hookId;
      gitFields.autoDeploy = true;
    }
  }

  await repos.project.update(projectId, gitFields);
  if (project!.groupId) {
    const sharedGitFields = {
      gitProvider: "github",
      gitOwner: owner,
      gitRepo: repo,
      gitUrl,
      installationId: (gitFields.installationId as number | undefined) ?? input.installationId,
      ...(typeof gitFields.webhookId === "number" ? { webhookId: gitFields.webhookId } : {}),
    };
    await repos.projectGroup.update(project!.groupId, {
      gitProvider: "github",
      gitOwner: owner,
      gitRepo: repo,
      gitUrl,
      installationId: (gitFields.installationId as number | undefined) ?? input.installationId,
    });
    const siblings = await repos.project.listByGroup(project!.groupId);
    await Promise.all(
      siblings
        .filter((sibling) => sibling.id !== projectId)
        .map((sibling) => repos.project.update(sibling.id, sharedGitFields)),
    );
  }

  return { ok: true, owner, repo, branch: defaultBranch, strategy, autoDeploy: !!gitFields.autoDeploy };
}

async function uniqueProjectSlug(organizationId: string, baseSlug: string) {
  let slug = baseSlug;
  let suffix = 2;

  while (await repos.project.findBySlugInOrg(organizationId, slug)) {
    slug = `${baseSlug}-${suffix}`;
    suffix += 1;
  }

  return slug;
}

/**
 * A cheap "current version" label for an app environment — the real axis for
 * apps (which have no meaningful git branch). Release/self/webmail → semver;
 * image apps → the running image tag. Null for git projects (they keep branch).
 */
async function resolveEnvVersion(row: Project, latest: Deployment | null): Promise<string | null> {
  if (row.appTemplateId === "openship" || row.appTemplateId === "mail-webmail") return readApiVersion();
  if (isReleaseProvider(row.gitProvider)) {
    const pinned = (row.releaseSource as ReleaseSource | null)?.pinnedVersion;
    return latest?.releaseVersion ?? pinned ?? null;
  }
  if (row.isApp && !row.gitOwner) {
    const services = await repos.service.listByProject(row.id).catch(() => []);
    const svc = services.find((s) => s.exposed && s.image) ?? services.find((s) => s.image);
    const ref = svc?.image;
    if (ref) return ref.includes(":") ? (ref.split(":").pop() ?? null) : "latest";
  }
  return null;
}

function environmentSummary(
  p: Project,
  latestStatus?: string | null,
  primaryDomain?: string | null,
  version?: string | null,
) {
  return {
    id: p.id,
    name: p.environmentName,
    slug: p.environmentSlug,
    type: p.environmentType,
    gitBranch: p.gitBranch ?? "main",
    projectSlug: p.slug,
    activeDeploymentId: p.activeDeploymentId,
    latestDeploymentStatus: latestStatus ?? null,
    primaryDomain,
    // App axis: version instead of branch. Null for git projects.
    version: version ?? null,
    isApp: !!p.isApp,
    gitProvider: p.gitProvider ?? null,
  };
}

function selectDisplayProject(rows: Project[]): Project | null {
  if (rows.length === 0) return null;
  return rows.find((row) => row.environmentSlug === "production") ?? rows[0]!;
}

function selectProjectForBranch(rows: Project[], branch?: string | null): Project | null {
  if (rows.length === 0) return null;

  const normalizedBranch = branch?.trim();
  if (normalizedBranch) {
    const byBranch = rows.find((row) => row.gitBranch === normalizedBranch);
    if (byBranch) return byBranch;
  }

  return selectDisplayProject(rows);
}

async function findProjectByAppSlug(
  organizationId: string,
  slug: string,
  branch?: string | null,
): Promise<Project | null> {
  const app = await repos.projectGroup.findBySlugInOrg(organizationId, slug);
  if (app) {
    return selectProjectForBranch(await repos.project.listByGroup(app.id), branch);
  }

  return (await repos.project.findBySlugInOrg(organizationId, slug)) ?? null;
}

// ─── Ensure project (create or return existing) ─────────────────────────────

/**
 * Enforce the project cap before creating one. On Openship Cloud (CLOUD_MODE) a
 * cloud org maps 1:1 to its owning SaaS user, so this per-org count IS the
 * per-user cap (env CLOUD_MAX_PROJECTS_PER_USER, default 2). Self-hosted is not
 * metered — it uses the high SYSTEM.PROJECTS.MAX_PER_USER safety cap. Called
 * from BOTH createProject and ensureProject so the folder-upload/ensure path
 * can't bypass it.
 */
async function assertProjectQuota(organizationId: string): Promise<void> {
  const cap = env.CLOUD_MODE
    ? env.CLOUD_MAX_PROJECTS_PER_USER
    : SYSTEM.PROJECTS.MAX_PER_USER;
  const { total } = await repos.projectGroup.listByOrganization(organizationId, {
    page: 1,
    perPage: 1,
  });
  if (total >= cap) {
    throw new ValidationError(`Project limit reached (${cap})`);
  }
}

export async function ensureProject(
  data: EnsureProjectBody,
  organizationId: string,
) {
  const nameSlug = slugify(data.name);
  const desiredSlug = data.slug || nameSlug;

  let project: Project | null = null;
  if (data.projectId) {
    project = (await repos.project.findById(data.projectId)) ?? null;
    assertResourceInOrg(project, "Project", organizationId, data.projectId);
  }

  if (!project) {
    project = await findProjectByAppSlug(organizationId, nameSlug, data.gitBranch);
  }
  if (!project && desiredSlug !== nameSlug) {
    project = await findProjectByAppSlug(organizationId, desiredSlug, data.gitBranch);
  }
  let created = false;

  if (!project) {
    // No existing match → this ensure will create. Enforce the cap here too
    // (the folder-upload deploy flow reaches creation only through ensure).
    await assertProjectQuota(organizationId);
    project = await createProductionProject(
      data,
      desiredSlug,
      organizationId,
    );
    created = true;
  } else {
    // Defensive: if we matched an existing project but its org_id doesn't
    // match the caller's active org, refuse. The auto-switch middleware
    // should have made these match before we get here, but the bare
    // ensure path can be called from edge code paths (CLI, deploy hooks).
    if (project.organizationId !== organizationId) {
      throw new NotFoundError("Project", data.projectId ?? desiredSlug);
    }
    const update: Record<string, unknown> = {};
    if (data.framework !== undefined) update.framework = normalizeFramework(data.framework);
    if (data.packageManager !== undefined) update.packageManager = data.packageManager;
    if (data.installCommand !== undefined) update.installCommand = data.installCommand;
    if (data.buildCommand !== undefined) update.buildCommand = data.buildCommand;
    if (data.outputDirectory !== undefined) update.outputDirectory = data.outputDirectory;
    if (data.productionPaths !== undefined) update.productionPaths = data.productionPaths;
    if (data.volumes !== undefined) update.volumes = data.volumes;
    if (data.rootDirectory !== undefined) update.rootDirectory = data.rootDirectory;
    if (data.composePath !== undefined) update.composePath = normalizeComposePath(data.composePath);
    if (data.startCommand !== undefined) update.startCommand = data.startCommand;
    if (data.buildImage !== undefined) update.buildImage = data.buildImage;
    if (data.port !== undefined) update.port = data.port;
    if (data.productionMode !== undefined) update.productionMode = data.productionMode;
    if (data.hasServer !== undefined) {
      update.hasServer = data.hasServer;
      if (data.productionMode === undefined && data.hasServer === false) {
        update.productionMode = "static";
      }
    }
    if (data.hasBuild !== undefined) update.hasBuild = data.hasBuild;
    if (data.projectType === "monorepo" && data.monorepoWorkspace !== undefined) {
      update.workspacePrepareCommand = data.monorepoWorkspace.prepareCommand ?? null;
    }
    if (data.routingConfig !== undefined) update.routingConfig = data.routingConfig;
    if (data.slug !== undefined && data.slug !== project.slug) {
      const existingProject = await repos.project.findBySlugInOrg(organizationId, data.slug);
      if (existingProject && existingProject.id !== project.id) {
        throw new ConflictError(`Project slug "${data.slug}" already exists`);
      }

      const existingApp = await repos.projectGroup.findBySlugInOrg(organizationId, data.slug);
      if (existingApp && existingApp.id !== project.groupId) {
        throw new ConflictError(`Project slug "${data.slug}" already exists`);
      }

      update.slug = data.slug;
    }
    if (data.gitBranch !== undefined && (data.projectId || !project.gitBranch)) {
      update.gitBranch = data.gitBranch;
    }
    if (data.localPath !== undefined) {
      const safePath = data.localPath && !env.CLOUD_MODE ? data.localPath : null;
      update.localPath = safePath;
      if (safePath) {
        update.gitProvider = "local";
        update.gitUrl = null;
      }
    }
    if (data.rollbackWindow !== undefined) {
      update.rollbackWindow =
        data.rollbackWindow === null ? null : normalizeRollbackWindow(data.rollbackWindow);
    }
    if (data.cloudArchiveStrategy !== undefined) {
      update.cloudArchiveStrategy = data.cloudArchiveStrategy;
    }

    if (Object.keys(update).length > 0) {
      await repos.project.update(project.id, update);
    }

    // Reconcile routes AFTER persisting the project (best-effort) so a route-sync
    // failure can't discard the field edits we just committed; the next deploy
    // re-syncs routes. Same ordering as updateOptions.
    if (
      data.publicEndpoints !== undefined ||
      update.slug !== undefined ||
      update.port !== undefined
    ) {
      await syncProjectRouteState(project, {
        nextPublicEndpoints: data.publicEndpoints,
        slug: typeof update.slug === "string" ? update.slug : project.slug,
      }).catch((err) =>
        console.warn(`[ensureProject] route sync failed (non-fatal): ${safeErrorMessage(err)}`),
      );
    }

    if (
      project.groupId &&
      typeof update.slug === "string" &&
      project.environmentSlug === "production"
    ) {
      await repos.projectGroup.update(project.groupId, { slug: update.slug });
    }

    // Re-sync monorepo sub-apps if the request carries them. The sync method
    // is idempotent - adds new rows, updates existing, removes stale ones.
    await persistMonorepoApps(project.id, data);
  }

  // Compose services, for BOTH branches (createProductionProject handles the
  // monorepo shape internally; this one shape is persisted in one place).
  await persistComposeServices(project.id, organizationId, data);

  return { success: true, project_id: project.id, created };
}

// ─── List projects ───────────────────────────────────────────────────────────

/**
 * List projects in scope, one display row per project app.
 *
 * Drives off `project` directly (not `project_app`) so the list and the detail
 * endpoint (`getProject`) agree on what's visible. The previous implementation
 * filtered apps first, which hid projects whose `project_app` row had been
 * soft-deleted while the project itself was still alive - a state the detail
 * endpoint happily returned, leaving the project reachable by URL but absent
 * from every listing.
 */
export async function listProjects(
  organizationId: string,
  opts?: { page?: number; perPage?: number },
) {
  const page = opts?.page ?? 1;
  const perPage = opts?.perPage ?? 20;

  // organizationId is required across the codebase — the route-level
  // requirePermission middleware ensures it's set before the controller runs.
  const { rows: projects } = await repos.project.listByOrganization(
    organizationId,
    { page: 1, perPage: 1000 },
  );

  const byGroup = new Map<string, Project[]>();
  for (const p of projects) {
    const list = byGroup.get(p.groupId) ?? [];
    list.push(p);
    byGroup.set(p.groupId, list);
  }

  const displays = Array.from(byGroup.values())
    .map(selectDisplayProject)
    .filter((p): p is Project => !!p)
    .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));

  const start = (page - 1) * perPage;
  const rows = displays.slice(start, start + perPage);

  return { rows, total: displays.length, page, perPage };
}

// ─── Get single project ──────────────────────────────────────────────────────

export async function getProject(projectId: string, organizationId: string) {
  const p = await repos.project.findById(projectId);
  assertResourceInOrg(p, "Project", organizationId, projectId);
  return enrichProject(p);
}

// ─── Create project ──────────────────────────────────────────────────────────

/** @scope org — only reads organizationId as a DB key. */
export async function createProject(
  data: TCreateProjectBody,
  organizationId: string,
) {
  const slug = slugify(data.name);

  await assertProjectQuota(organizationId);

  const existing = await findProjectByAppSlug(organizationId, slug);
  if (existing) throw new ConflictError(`Project "${data.name}" already exists`);

  // Multi-tenant SaaS: never trust a client-supplied installationId. It binds
  // the project to a GitHub App installation, and the push-webhook fan-out
  // deploys by matching project.installationId to the DELIVERY's installation
  // (webhook-push.ts triggerBranchDeployments). A tenant could otherwise claim
  // another org's installation id (or just reference another org's repo string)
  // and get fanned into that org's pushes — leaking the repo's commit metadata
  // into their delivery feed and triggering unauthorized deploys. Resolve the
  // installation from the caller's OWN org + owner; if this org hasn't installed
  // the App on that owner, drop it (null) so the project can never match — and
  // thus never join — another org's push delivery. (linkProjectRepo already
  // resolves it server-side; this closes the direct-create path.)
  if (env.CLOUD_MODE) {
    const owner = data.gitOwner?.trim();
    data.installationId = owner
      ? ((await getInstallationIdByOrg(organizationId, owner)) ?? undefined)
      : undefined;
  }

  const p = await createProductionProject(data, slug, organizationId);

  return enrichProject(p);
}

// ─── Update project ──────────────────────────────────────────────────────────

export async function updateProject(
  projectId: string,
  data: TUpdateProjectBody,
  organizationId: string,
) {
  const p = await repos.project.findById(projectId);
  assertResourceInOrg(p, "Project", organizationId, projectId);

  // Reject a bogus custom hostname before the field edits below are committed — the
  // route sync happens after them, so validating there alone would 400 a request
  // that had already written the rest of the patch. Net-new only (the endpoint list
  // is authoritative, so a save echoes back hostnames the project already has —
  // including any bad one predating this gate, which must stay removable). #342
  if (data.publicEndpoints !== undefined) {
    assertValidCustomDomains([{ publicEndpoints: data.publicEndpoints }], {
      known: (await listProjectRouteRows(projectId).catch(() => [])).map((row) => row.hostname),
    });
  }

  // SECURITY (mass-assignment): pick ONLY the allow-listed editable fields from
  // the (unvalidated, type-cast) request body. A raw `{ ...data }` spread let a
  // project:write caller write arbitrary project columns — e.g. activeDeploymentId
  // (repoint this project at another org's deployment → cross-tenant logs/container
  // controls) or organizationId. Unknown/internal keys are dropped here.
  const raw = data as Record<string, unknown>;
  const update: Record<string, unknown> = {};
  for (const key of PROJECT_UPDATE_KEYS) {
    // Repo identity is set ONLY by the validated linker (linkProjectRepo, POST
    // /git/link) — never this generic editor. A raw PATCH here would repoint a
    // project at another repo with no branch/installation/webhook validation and
    // no sibling fan-out. gitUrl is derived by the linker, so it's not set here
    // either (deriving it from an owner/repo we don't apply would desync it).
    if (GIT_SOURCE_IDENTITY_KEYS.has(key)) continue;
    if (raw[key] !== undefined) update[key] = raw[key];
  }
  if (data.name && data.name !== p.name) {
    const newSlug = slugify(data.name);
    const existing = await repos.project.findBySlugInOrg(organizationId, newSlug);
    if (existing && existing.id !== projectId) {
      throw new ConflictError(`Project "${data.name}" already exists`);
    }
    update.slug = newSlug;
  }

  if (data.rollbackWindow !== undefined) {
    update.rollbackWindow =
      data.rollbackWindow === null ? null : normalizeRollbackWindow(data.rollbackWindow);
  }

  // The body is type-cast, not runtime-validated (see PROJECT_UPDATE_KEYS note),
  // so reject a garbage routeStrategy before it reaches the column. Invalid
  // values would coerce to loopback-port at read time anyway; failing loudly
  // keeps the persisted value meaningful.
  if (
    update.routeStrategy !== undefined &&
    !["auto", "loopback-port", "container-ip"].includes(update.routeStrategy as string)
  ) {
    throw new ValidationError(
      "routeStrategy must be 'auto', 'loopback-port', or 'container-ip'",
    );
  }

  // ── monorepoSharedPaths validation ──────────────────────────────────
  // Reject any prefix that overlaps an existing service's rootDirectory:
  // configuring `packages/` as a shared path when `packages/web` is a
  // deployable service would force-rebuild every service on every push
  // to web (defeating the point of smart per-service deploys).
  if (data.monorepoSharedPaths !== undefined && data.monorepoSharedPaths !== null) {
    const normalize = (s: string) =>
      s.trim().replace(/^\/+/, "").replace(/\/+$/, "").toLowerCase();
    const prefixes = data.monorepoSharedPaths
      .map(normalize)
      .filter((s) => s.length > 0);
    if (prefixes.length > 0) {
      const services = await repos.service.listByProject(projectId).catch(() => []);
      const serviceRoots = services
        .map((s) => normalize(s.rootDirectory ?? ""))
        .filter((s) => s.length > 0);
      const overlap = prefixes.find((prefix) =>
        serviceRoots.some(
          (root) => root === prefix || root.startsWith(`${prefix}/`) || prefix.startsWith(`${root}/`),
        ),
      );
      if (overlap) {
        throw new ValidationError(
          `monorepoSharedPaths prefix "${overlap}" overlaps an existing service rootDirectory — a shared-path force would defeat smart per-service deploys`,
        );
      }
    }
    // Normalize empty → null so the change detector's null-check fires.
    update.monorepoSharedPaths = prefixes.length > 0 ? data.monorepoSharedPaths : null;
  }

  // ── defaultRollbackStrategy ────────────────────────────────────────
  if (data.defaultRollbackStrategy !== undefined) {
    if (data.defaultRollbackStrategy !== "git" && data.defaultRollbackStrategy !== "snapshot") {
      throw new ValidationError(
        `defaultRollbackStrategy must be "git" or "snapshot"`,
      );
    }
    update.defaultRollbackStrategy = data.defaultRollbackStrategy;
  }

  // ── internalAlias (single-app east-west hostname) ──────────────────
  // Normalize to a DNS label; empty/null clears it back to the default
  // `<slug>` alias. Reject an entry that carries no usable characters so a
  // garbage value never becomes the misleading `"service"` fallback.
  if (data.internalAlias !== undefined) {
    if (data.internalAlias === null || String(data.internalAlias).trim() === "") {
      update.internalAlias = null;
    } else {
      const alias = normalizeAliasStrict(String(data.internalAlias));
      if (!alias) {
        throw new ValidationError(
          "internalAlias must contain at least one letter or digit",
        );
      }
      // Reject an internalAlias that collides with a sidecar service's name or
      // custom alias on this project's network (embedded DNS is first-match).
      // Skip the check on a no-op re-save of the current value so a value that
      // already coexists stays editable. Not checked against the project's own
      // slug: internalAlias == slug is the same single-app container answering to
      // both names, not a collision. Runs BEFORE repos.project.update below.
      if (alias !== normalizeAliasStrict(p.internalAlias)) {
        const siblings = await repos.service.listByProject(projectId).catch(() => []);
        if (aliasConflictsWithSiblings(alias, siblings)) {
          throw new ValidationError(
            "internalAlias collides with a service name or alias on this project",
          );
        }
      }
      update.internalAlias = alias;
    }
  }

  await repos.project.update(projectId, update);

  // Reconcile routes AFTER persisting the project (best-effort) — a route-sync
  // failure must not discard the field edits already committed; the next deploy
  // re-syncs. Same ordering as updateOptions.
  if (
    data.publicEndpoints !== undefined ||
    update.slug !== undefined ||
    update.port !== undefined
  ) {
    // Snapshot the live hostnames before the sync so re-application can tear
    // down any the edit drops — AND so the free-cloud gate only fires for
    // NET-NEW free routes.
    const beforeState = await resolveProjectRouteState(p).catch(() => null);
    const previousHostnames = beforeState?.projectDomains.map((d) => d.hostname) ?? [];

    // Atomic gate: a free (*.opsh.io) route only resolves behind the Openship
    // Cloud edge — refuse before any write so a disconnected instance can't
    // INTRODUCE a dead route. Only gate endpoints whose hostname isn't already
    // live: re-validating the WHOLE set blocked removing/editing a route whenever
    // another, already-persisted free route stayed in the set (you can't remove
    // api.openship.io because app.openship.io is still there). Removal never
    // introduces anything, so it never gates. Skipped for slug/port re-syncs.
    if (data.publicEndpoints !== undefined) {
      // Already-live hostnames = DB domain rows ∪ the resolved route endpoints
      // (the latter also covers a PENDING route that has no domain row yet), so a
      // remaining pending route is never mistaken for net-new.
      const priorHosts = new Set(
        [
          ...previousHostnames,
          ...(beforeState?.publicEndpoints ?? []).map((e) => e.hostname),
        ]
          .filter((h): h is string => typeof h === "string" && h.length > 0)
          .map((h) => h.trim().toLowerCase()),
      );
      const netNew = normalizeStoredPublicEndpoints(data.publicEndpoints).filter((endpoint) => {
        const host = publicEndpointHostname(endpoint)?.trim().toLowerCase();
        return host ? !priorHosts.has(host) : false;
      });
      await assertFreeEndpointsAllowed(organizationId, netNew);
    }

    // Best-effort ONLY for incidental re-syncs (a slug/port edit) — the field
    // edit is already committed and the next deploy re-syncs routes. But when
    // the caller EXPLICITLY sent publicEndpoints, the domain add/edit IS the
    // operation: swallowing a failure here would return success while nothing
    // was persisted (silent drop). Fail loudly so the real reason (e.g. a slug
    // conflict) surfaces to the user instead of a false success.
    try {
      await syncProjectRouteState(p, {
        nextPublicEndpoints: data.publicEndpoints,
        slug: typeof update.slug === "string" ? update.slug : p.slug,
      });
    } catch (err) {
      if (data.publicEndpoints !== undefined) throw err;
      console.warn(`[updateProject] route sync failed (non-fatal): ${safeErrorMessage(err)}`);
    }

    // Re-apply the live route so a domain/port edit takes effect without a
    // redeploy. Remote routing can take longer than the dashboard's request
    // timeout (SSH connection + route removal/registration), while the domain
    // rows above are already canonical. Keep this best-effort work in the
    // background so the mutation can return success as soon as persistence is
    // complete instead of surfacing a false client-side timeout.
    const refreshed = await repos.project.findById(projectId);
    if (refreshed) {
      void (async () => {
        // `managedEdgeSyncedByCaller`: the `syncProjectManagedEdge` below already
        // covers every managed hostname on the project, including the ones added by
        // this edit. Letting the re-apply sync them too raced its own follow-up —
        // two challenges for one target, the second resetting the first's token.
        await reapplyProjectLiveRoutes(refreshed, previousHostnames, {
          managedEdgeSyncedByCaller: true,
        }).catch((err) =>
          console.warn(
            `[updateProject] live route re-apply failed (non-fatal): ${safeErrorMessage(err)}`,
          ),
        );
        // A free (*.opsh.io) domain resolves only through Openship Cloud's edge.
        // reapplyProjectLiveRoutes handles the self-hosted OpenResty side; the
        // managed edge must be re-registered too or an edited/added free URL
        // 404s with no signal. Only meaningful once deployed (no live target
        // otherwise — the next deploy syncs). On failure this sets
        // meta.edgeUnsynced so the project surfaces "Retry routing" instead of
        // silently returning a dead URL.
        if (refreshed.activeDeploymentId) {
          await syncProjectManagedEdge(refreshed, organizationId, {
            markOnFailure: true,
          }).catch((err) =>
            console.warn(
              `[updateProject] managed edge sync failed (non-fatal): ${safeErrorMessage(err)}`,
            ),
          );
        }
      })();
    }
  }

  // Editing the vercel.json routing (rewrites/redirects/headers) re-applies it to
  // the live deployment without a rebuild — the routing counterpart to the
  // domain/port re-sync above. Self-hosted → OpenResty, cloud → the Oblien edge;
  // best-effort internally.
  if (data.routingConfig !== undefined) {
    await applyProjectRouting(projectId);
  }

  if (p.groupId) {
    // Only non-source fields fan out here (name/slug). Repo identity is owned by
    // linkProjectRepo, which does its OWN group + sibling propagation — the
    // generic editor no longer sets git source, so it must not fan it out either.
    const appUpdate: Record<string, unknown> = {};
    if (typeof update.name === "string") appUpdate.name = update.name;
    if (typeof update.slug === "string" && p.environmentSlug === "production")
      appUpdate.slug = update.slug;
    if (Object.keys(appUpdate).length > 0) {
      await repos.projectGroup.update(p.groupId, appUpdate);
    }
  }
  const updated = await repos.project.findById(projectId);
  return enrichProject(updated!);
}

// ─── Project environments ───────────────────────────────────────────────────

export async function listProjectEnvironments(
  projectId: string,
  organizationId: string,
) {
  const p = await repos.project.findById(projectId);
  assertResourceInOrg(p, "Project", organizationId, projectId);

  const rows = await repos.project.listByGroup(p.groupId);
  const enriched = await Promise.all(
    rows.map(async (row) => {
      const [latest, primary] = await Promise.all([
        repos.deployment.findLatestByProject(row.id),
        repos.domain.getPrimaryByProject(row.id),
      ]);
      const version = await resolveEnvVersion(row, latest ?? null);
      return environmentSummary(row, latest?.status ?? null, primary?.hostname ?? null, version);
    }),
  );

  return enriched.sort((a, b) => {
    if (a.slug === "production") return -1;
    if (b.slug === "production") return 1;
    return a.name.localeCompare(b.name);
  });
}

export async function createProjectEnvironment(
  projectId: string,
  ctx: RequestContext,
  data: TCreateProjectEnvironmentBody,
) {
  const { userId, organizationId } = ctx;
  const base = await repos.project.findById(projectId);
  assertResourceInOrg(base, "Project", organizationId, projectId);

  const environmentSlug = normalizeEnvironmentSlug(
    data.environmentSlug ?? data.environmentName,
    "development",
  );
  const environmentName = data.environmentName?.trim() || environmentNameFromSlug(environmentSlug);
  const environmentType =
    data.environmentType ?? (environmentSlug === "production" ? "production" : "development");

  const existing = (await repos.project.listByGroup(base.groupId)).find(
    (row) => row.environmentSlug === environmentSlug,
  );
  if (existing) {
    throw new ConflictError(`Environment "${environmentName}" already exists`);
  }

  const app = await repos.projectGroup.findById(base.groupId);
  const projectSlug = await uniqueProjectSlug(
    organizationId,
    environmentSlug === "production" ? base.slug : `${app?.slug ?? base.slug}-${environmentSlug}`,
  );

  let productionBranch = base.gitBranch ?? undefined;
  if (!productionBranch && environmentType === "production" && base.gitOwner && base.gitRepo) {
    // userId here is the actor who triggered the action — used to authorize
    // the GitHub call against their installation token.
    productionBranch = await resolveDefaultBranch(ctx, base.gitOwner, base.gitRepo);
  }

  const gitBranch =
    data.gitBranch?.trim() ||
    (environmentType === "production" ? (productionBranch ?? "main") : environmentSlug);

  if ((data.sourceMode ?? "branch") === "branch" && base.gitOwner && base.gitRepo && gitBranch) {
    const branches = await listGitHubBranches(ctx, base.gitOwner, base.gitRepo);
    const exists = branches.some((branch) => branch.name === gitBranch);
    if (!exists) {
      throw new ValidationError(`Branch "${gitBranch}" was not found for ${base.gitOwner}/${base.gitRepo}`);
    }
  }

  const created = await repos.project.create({
    organizationId,
    groupId: base.groupId,
    // The catalog-app marker is a property of the whole cluster, not one
    // environment — carry it to every sibling so a new env of a catalog app
    // (e.g. a "staging" Convex) stays an app, and the cluster never drops off
    // the Apps tab when its production env is removed. (Until the marker is
    // moved onto project_app itself; see the rename plan.)
    isApp: base.isApp,
    appTemplateId: base.appTemplateId,
    name: app?.name ?? base.name,
    slug: projectSlug,
    environmentName,
    environmentSlug,
    environmentType,
    localPath: base.localPath,
    gitProvider: app?.gitProvider ?? base.gitProvider,
    gitOwner: app?.gitOwner ?? base.gitOwner,
    gitRepo: app?.gitRepo ?? base.gitRepo,
    gitBranch,
    gitUrl: app?.gitUrl ?? base.gitUrl,
    installationId: app?.installationId ?? base.installationId,
    framework: base.framework,
    packageManager: base.packageManager,
    installCommand: base.installCommand,
    buildCommand: base.buildCommand,
    outputDirectory: base.outputDirectory,
    productionPaths: base.productionPaths,
    volumes: base.volumes,
    rootDirectory: base.rootDirectory,
    composePath: base.composePath,
    startCommand: base.startCommand,
    buildImage: base.buildImage,
    productionMode: base.productionMode,
    port: base.port,
    hasServer: base.hasServer,
    hasBuild: base.hasBuild,
    resources: base.resources,
    buildResources: base.buildResources,
    sleepMode: base.sleepMode,
    rollbackWindow: base.rollbackWindow,
    cloudArchiveStrategy: base.cloudArchiveStrategy,
    defaultRollbackStrategy: base.defaultRollbackStrategy,
    webhookId: null,
    webhookDomain: null,
    autoDeploy: base.autoDeploy,
  });

  const baseRouteState = await resolveProjectRouteState(base);
  await persistProjectRouteState(
    created.id,
    deriveEnvironmentPublicEndpoints(baseRouteState.publicEndpoints, projectSlug),
  );

  return environmentSummary(created);
}

// ─── Source drift ────────────────────────────────────────────────────────────

/**
 * Drift — "is what's running behind what the source offers?" — has two halves,
 * and they have nothing in common but the comparison:
 *
 *   UPSTREAM ("what does the source offer?")  network. GitHub branch HEAD, the
 *     newest release tag, a registry digest per service. Rate-limited, slow, and
 *     no local event tells us when it changes — it can only be POLLED, which is
 *     why `update_status` caches it and `updates:scan` refreshes it.
 *
 *   DEPLOYED ("what is actually running?")  local. The active deployment's row.
 *     Free to read, and mutated by seven different code paths (deploy success,
 *     rollback, reconcile, activate, clear, self-deploy, migrate).
 *
 * Only the upstream half is cached. Caching the deployed half is what produced
 * "update available a1b2c3d → e4f5g6h" on a project whose deployment list showed
 * it shipped e4f5g6h days earlier: the row froze mid-window, and of the seven
 * writers only one could ever have invalidated it. Deriving it on read makes
 * that whole class of staleness unrepresentable — no invalidation hook to
 * forget, because there is nothing local left to invalidate.
 *
 * The upstream half is cached UNDER THE SOURCE IDENTITY it was polled for — a
 * branch key, a release-source key, an image ref. Change the branch or the tag
 * and the cached answer stops matching the question (`upstreamMatchesSource`),
 * so the reader re-polls instead of comparing against another source's HEAD.
 * That's why editing a project's source needs no invalidation call: a cache keyed
 * by what it describes cannot be asked the wrong question.
 *
 * So: `resolveUpstreamDrift` (cache this) + `resolveDeployedDrift` (never cache)
 * + `evaluateDrift` (compare). This module owns the three primitives and knows
 * nothing about the cache; `updates.service` owns the storage and the freshness
 * policy, and is the one place any surface asks "is this project behind?".
 */

/**
 * The cacheable half. Every variant carries the source identity it was resolved
 * for, so a cached copy can be matched against the project's current source.
 * Commit carries the FULL sha, not a display prefix — a truncated value can't be
 * compared.
 */
export type UpstreamDrift =
  | { supported: false }
  | {
      supported: true;
      mode: "commit";
      /** `owner/repo#branch` this HEAD was read from. */
      key: string;
      latestSha: string | null;
      latestMessage: string | null;
    }
  | {
      supported: true;
      mode: "release";
      /** Fingerprint of the release source this version came from. */
      key: string;
      latestVersion: string | null;
      pinned: boolean;
    }
  | {
      supported: true;
      mode: "image";
      /** Image ref → the digest that tag resolved to. Keyed by ref, so a retagged
       *  service is a miss rather than a comparison against another tag's digest. */
      digestByRef: Record<string, string | null>;
    };

/** What `evaluateDrift` (and so `getProjectDrift`) hands back to callers. */
export type DriftStatus = Awaited<ReturnType<typeof evaluateDrift>>;

/** Which of the three drift shapes a project has, from local fields only. */
export function driftMode(p: Project): "commit" | "release" | "image" {
  if (isReleaseProvider(p.gitProvider)) return "release";
  if (p.appTemplateId === "openship" || p.appTemplateId === "mail-webmail") return "release";
  return p.gitOwner && p.gitRepo ? "commit" : "image";
}

/** Git branch a commit-source project tracks. */
export function projectBranch(p: Project): string {
  return p.gitBranch?.trim() || "main";
}

/** Source identity for a commit project — everything that determines its HEAD. */
export function commitSourceKey(p: Project): string {
  return `${p.gitOwner ?? ""}/${p.gitRepo ?? ""}#${projectBranch(p)}`;
}

/**
 * Source identity for a release project. Only the fields `resolveLatestVersion`
 * actually consults: change any of them and the cached version is a different
 * question's answer.
 */
export function releaseSourceKey(p: Project): string {
  if (!isReleaseProvider(p.gitProvider)) return `self:${p.appTemplateId ?? ""}`;
  const s = (p.releaseSource as ReleaseSource | null) ?? null;
  if (!s) return "none";
  return [s.mode, s.repo ?? "", s.versionUrl ?? "", s.pinnedVersion ?? ""].join("|");
}

/** Image services whose upstream digest is worth resolving (image-only, enabled). */
async function imageServicesOf(p: Project) {
  const services = await repos.service.listByProject(p.id).catch(() => []);
  return services.filter((s) => s.image && !s.build && (s.enabled ?? true));
}

/**
 * Is there anything running to BE behind? Nothing to compare means drift is not a
 * question worth a network round-trip, so readers skip the poll entirely rather
 * than resolving a HEAD they'd only discard.
 *
 * The self-app and webmail qualify without a deployment row: they report the
 * running API's own version (see `resolveDeployedDrift`).
 */
export function hasDeployedSide(p: Project): boolean {
  return (
    Boolean(p.activeDeploymentId) ||
    p.appTemplateId === "openship" ||
    p.appTemplateId === "mail-webmail"
  );
}

/**
 * Does a previously-polled upstream still answer the question this project is
 * asking NOW? False for a repointed branch/repo, a swapped release source, a
 * retagged image — and for a project whose whole drift shape changed.
 *
 * This is what lets the cache carry no invalidation hooks: instead of every
 * source edit remembering to clear a row, the row simply stops matching and the
 * reader re-polls. Cheap (local fields; one indexed service read for image apps).
 */
export async function upstreamMatchesSource(p: Project, u: UpstreamDrift): Promise<boolean> {
  if (!u.supported || u.mode !== driftMode(p)) return false;
  if (u.mode === "commit") return u.key === commitSourceKey(p);
  if (u.mode === "release") return u.key === releaseSourceKey(p);
  const services = await imageServicesOf(p);
  if (services.length === 0) return false;
  // Every current ref must have been polled — a service added or retagged since
  // has no digest here, and guessing from a sibling's is how a retag reads as
  // "behind forever".
  return services.every((s) => Object.hasOwn(u.digestByRef, s.image!));
}

/**
 * Resolve the upstream half. `ctx` is only needed for the git-commit branch
 * (GitHub auth); release/image sources need none. A null ctx no longer means
 * "skip the check" — background sweeps pass an org-owner actor, see
 * `updates.service`.
 */
export async function resolveUpstreamDrift(
  ctx: RequestContext | null,
  p: Project,
): Promise<UpstreamDrift> {
  const mode = driftMode(p);

  if (mode === "release") {
    // Self-app + webmail ship from the oblien/openship release stream but carry
    // no releaseSource (they deploy via localPath/migration), so they'd otherwise
    // fall through to unsupported.
    if (!isReleaseProvider(p.gitProvider)) {
      const latestVersion = await resolveLatestReleaseTag(GITHUB_REPO).catch(() => null);
      return {
        supported: true,
        mode: "release",
        key: releaseSourceKey(p),
        latestVersion,
        pinned: false,
      };
    }
    const source = (p.releaseSource as ReleaseSource | null) ?? null;
    if (!source) return { supported: false };
    const latestVersion = source.pinnedVersion
      ? source.pinnedVersion.replace(/^v/, "")
      : await resolveLatestVersion(source);
    return {
      supported: true,
      mode: "release",
      key: releaseSourceKey(p),
      latestVersion,
      pinned: Boolean(source.pinnedVersion),
    };
  }

  if (mode === "image") {
    // Repo-less services/app projects (n8n/Convex/…): image-tag/digest drift.
    const imageServices = await imageServicesOf(p);
    if (imageServices.length === 0) return { supported: false };
    const refs = [...new Set(imageServices.map((s) => s.image!))];
    const digestByRef: Record<string, string | null> = {};
    await Promise.all(
      refs.map(async (ref) => {
        digestByRef[ref] = await resolveLatestImageDigest(ref).catch(() => null);
      }),
    );
    return { supported: true, mode: "image", digestByRef };
  }

  const head = ctx
    ? await getLatestCommit(ctx, p.gitOwner!, p.gitRepo!, projectBranch(p)).catch(() => null)
    : null;
  return {
    supported: true,
    mode: "commit",
    key: commitSourceKey(p),
    latestSha: head?.sha ?? null,
    latestMessage: head?.message ?? null,
  };
}

/** The live half, per mode. Local reads only — cheap enough to do on every read. */
type DeployedDrift =
  | { mode: "commit"; deployedSha: string | null }
  | { mode: "release"; currentVersion: string | null }
  | {
      mode: "image";
      deployedByService: Map<string, { ref?: string; digest?: string }>;
    };

/**
 * What's actually running. Mirrors `resolveUpstreamDrift`'s dispatch so the two
 * halves always describe the same source shape.
 */
export async function resolveDeployedDrift(
  p: Project,
  mode: "commit" | "release" | "image",
): Promise<DeployedDrift> {
  if (mode === "commit") {
    let deployedSha: string | null = null;
    if (p.activeDeploymentId) {
      const dep = await repos.deployment.findById(p.activeDeploymentId).catch(() => null);
      deployedSha = dep?.commitSha ?? null;
    }
    return { mode: "commit", deployedSha };
  }

  if (mode === "release") {
    // Self-app/webmail without a releaseSource track the running API's own
    // version — they never ship a releaseVersion through the pipeline.
    if (
      !isReleaseProvider(p.gitProvider) &&
      (p.appTemplateId === "openship" || p.appTemplateId === "mail-webmail")
    ) {
      return { mode: "release", currentVersion: readApiVersion() };
    }
    let currentVersion: string | null = null;
    if (p.activeDeploymentId) {
      const dep = await repos.deployment.findById(p.activeDeploymentId).catch(() => null);
      currentVersion = dep?.releaseVersion ?? null;
    }
    if (!currentVersion && p.appTemplateId === "openship") currentVersion = readApiVersion();
    return { mode: "release", currentVersion };
  }

  const deployedByService = new Map<string, { ref?: string; digest?: string }>();
  if (p.activeDeploymentId) {
    const sds = await repos.service.listByDeployment(p.activeDeploymentId).catch(() => []);
    for (const sd of sds) {
      deployedByService.set(sd.serviceId, {
        digest: sd.imageDigest ?? undefined,
        ref: sd.imageRef ?? undefined,
      });
    }
  }
  return { mode: "image", deployedByService };
}

/**
 * Compare a (possibly cached) upstream state against the live deployed state.
 *
 * Conservative by design: an unresolvable upstream (API failure, rate limit,
 * private registry) or a project with no successful deploy reports
 * `behind:false`, so we never show an "outdated" nudge we can't substantiate.
 */
export async function evaluateDrift(p: Project, upstream: UpstreamDrift) {
  if (!upstream.supported) return { supported: false as const };
  // A cached upstream describes the source it was polled from. If the project has
  // since been repointed (different repo, branch, release source), it answers a
  // question we're no longer asking — treat it as unknown, not as drift.
  if (upstream.mode !== driftMode(p)) return { supported: false as const };

  const deployed = await resolveDeployedDrift(p, upstream.mode);

  if (upstream.mode === "commit" && deployed.mode === "commit") {
    const latestSha = upstream.key === commitSourceKey(p) ? upstream.latestSha : null;
    const { deployedSha } = deployed;
    const behind = Boolean(latestSha && deployedSha && latestSha !== deployedSha);
    // Is the latest commit already deploying? Then there's nothing to redeploy —
    // it's in flight, so the nudge is suppressed. Computed live, which is why
    // pressing Update quiets every surface immediately.
    const latestInProgress =
      behind && latestSha
        ? Boolean(await repos.deployment.findInProgressByCommit(p.id, latestSha).catch(() => undefined))
        : false;
    return {
      supported: true as const,
      mode: "commit" as const,
      behind,
      latestInProgress,
      branch: projectBranch(p),
      latestSha,
      latestMessage: latestSha ? upstream.latestMessage : null,
      deployedSha,
    };
  }

  if (upstream.mode === "release" && deployed.mode === "release") {
    const latest = upstream.key === releaseSourceKey(p) ? upstream.latestVersion : null;
    const current = deployed.currentVersion;
    const behind = Boolean(latest && current && compareSemver(latest, current) > 0);
    const latestInProgress =
      behind && latest
        ? Boolean(
            await repos.deployment
              .findInProgressByReleaseVersion(p.id, latest)
              .catch(() => undefined),
          )
        : false;
    return {
      supported: true as const,
      mode: "release" as const,
      behind,
      latestInProgress,
      latestVersion: latest,
      currentVersion: current,
      pinned: upstream.pinned,
    };
  }

  if (upstream.mode === "image" && deployed.mode === "image") {
    // The live service list, not the polled one: a service added, removed or
    // retagged since the poll must be reflected now, not at the next scan.
    const imageServices = await imageServicesOf(p);
    if (imageServices.length === 0) return { supported: false as const };

    const services = imageServices.map((svc) => {
      const ref = svc.image!;
      const running = deployed.deployedByService.get(svc.id);
      // Keyed by the service's CURRENT ref — a retag since the poll is a miss.
      const latestDigest = Object.hasOwn(upstream.digestByRef, ref)
        ? upstream.digestByRef[ref]
        : null;
      const current: UpdatableIdentity = {
        kind: "image",
        ref: running?.ref ?? ref,
        digest: running?.digest,
      };
      const latest: UpdatableIdentity = {
        kind: "image",
        ref,
        digest: latestDigest ?? undefined,
      };
      return {
        serviceId: svc.id,
        name: svc.name,
        ref,
        deployedDigest: running?.digest ?? null,
        latestDigest,
        // Fail-soft: a digest we couldn't resolve is not evidence of drift.
        behind: latestDigest ? isBehind(current, latest) : false,
      };
    });
    return {
      supported: true as const,
      mode: "image" as const,
      behind: services.some((s) => s.behind),
      latestInProgress: false,
      services,
    };
  }

  return { supported: false as const };
}

// The composition of these three — for the project page's banner, the Apps tab,
// the home card and the issues feed alike — lives in `updates.service`
// (`getProjectDrift` / `listOrganizationUpdates`). There is deliberately no
// second entry point here: two compositions is how one surface starts answering
// "is this behind?" differently from another.

// ─── Git info ────────────────────────────────────────────────────────────────

export async function getGitInfo(projectId: string, organizationId: string) {
  const p = await repos.project.findById(projectId);
  assertResourceInOrg(p, "Project", organizationId, projectId);

  // Resolve deploy target from active deployment meta
  let deployTarget: string | null = null;
  if (p.activeDeploymentId) {
    const dep = await repos.deployment.findById(p.activeDeploymentId);
    ({ deployTarget } = readDeployMeta(dep));
  }

  return {
    gitProvider: p.gitProvider,
    gitOwner: p.gitOwner,
    gitRepo: p.gitRepo,
    gitBranch: p.gitBranch,
    gitUrl: p.gitUrl,
    installationId: p.installationId,
    webhookId: p.webhookId,
    webhookDomain: p.webhookDomain,
    autoDeploy: p.autoDeploy,
    defaultRollbackStrategy: p.defaultRollbackStrategy,
    deployTarget,
  };
}

export async function setBranch(
  projectId: string,
  branch: string,
  organizationId: string,
) {
  const p = await repos.project.findById(projectId);
  assertResourceInOrg(p, "Project", organizationId, projectId);

  await repos.project.update(projectId, { gitBranch: branch });
  return { success: true, branch };
}

// ─── Build options ───────────────────────────────────────────────────────────

export async function updateOptions(
  projectId: string,
  options: Record<string, unknown>,
  organizationId: string,
) {
  const p = await repos.project.findById(projectId);
  assertResourceInOrg(p, "Project", organizationId, projectId);

  const update: Record<string, unknown> = {};
  if (options.buildCommand !== undefined) update.buildCommand = options.buildCommand;
  if (options.installCommand !== undefined) update.installCommand = options.installCommand;
  if (options.outputDirectory !== undefined) update.outputDirectory = options.outputDirectory;
  if (options.productionPaths !== undefined) update.productionPaths = options.productionPaths;
  // Array-or-null only: the column feeds container mounts, and a string here
  // would land as a single nonsense bind. null restores the stack defaults.
  if (options.volumes !== undefined) {
    if (options.volumes !== null && !Array.isArray(options.volumes)) {
      throw new ValidationError("volumes must be an array of mount strings, or null");
    }
    update.volumes = options.volumes;
  }
  if (options.rootDirectory !== undefined) update.rootDirectory = options.rootDirectory;
  // String-or-null only. Empty/blank clears it: the settings form sends "" for a
  // blanked field, and no compose path means "go back to detecting the root".
  if (options.composePath !== undefined) {
    const composePath = options.composePath;
    if (composePath !== null && typeof composePath !== "string") {
      throw new ValidationError("composePath must be a string, or null");
    }
    update.composePath = normalizeComposePath(composePath);
  }
  if (options.startCommand !== undefined) update.startCommand = options.startCommand;
  if (options.productionPort !== undefined) update.port = options.productionPort;
  if (options.packageManager !== undefined) update.packageManager = options.packageManager;
  if (options.buildImage !== undefined) update.buildImage = options.buildImage;
  if (options.framework !== undefined) update.framework = options.framework;
  if (options.productionMode !== undefined) update.productionMode = options.productionMode;
  if (options.hasServer !== undefined) {
    update.hasServer = options.hasServer;
    if (options.productionMode === undefined && options.hasServer === false) {
      update.productionMode = "static";
    }
  }
  if (options.hasBuild !== undefined) update.hasBuild = options.hasBuild;
  // Runtime isolation mode (bare/docker) — editable in the Runtime tab; read by
  // buildConfigSnapshot so every deploy/redeploy respects the saved choice.
  // (Resources have their own dedicated path — projectsApi.setResources — so
  // we deliberately do NOT also write them here.)
  if (options.runtimeMode === "bare" || options.runtimeMode === "docker") {
    update.runtimeMode = options.runtimeMode;
  }

  // Persist the canonical config FIRST, then reconcile routes (best-effort) on a
  // port change. Ordering the project write before route-sync means a route-sync
  // failure can't leave config unsaved — and the next deploy re-syncs routes.
  if (Object.keys(update).length > 0) {
    await repos.project.update(projectId, update);
  }

  if (update.port !== undefined) {
    await syncProjectRouteState(p, { slug: p.slug });
  }

  const updated = await repos.project.findById(projectId);
  return enrichProject(updated!);
}

// ─── Project deployments ─────────────────────────────────────────────────────

export async function listProjectDeployments(
  projectId: string,
  organizationId: string,
  opts?: { page?: number; perPage?: number; environment?: string },
) {
  const p = await repos.project.findById(projectId);
  assertResourceInOrg(p, "Project", organizationId, projectId);

  const result = await repos.deployment.listByProject(projectId, opts);
  // Project favicon → the dashboard uses it as each row's logo instead of the
  // framework/Docker glyph (twin of deploymentService.listDeployments).
  return {
    ...result,
    rows: result.rows.map((d) => ({ ...d, favicon: p.favicon ?? null })),
  };
}

// ─── Deployment session ──────────────────────────────────────────────────────

export async function getLatestDeploymentSession(
  projectId: string,
  organizationId: string,
) {
  const p = await repos.project.findById(projectId);
  assertResourceInOrg(p, "Project", organizationId, projectId);

  if (!p.activeDeploymentId) {
    return { session: null };
  }

  const session = await repos.deployment.findBuildSessionByDeploymentId(p.activeDeploymentId);
  return {
    session: session
      ? {
          id: session.id,
          deploymentId: session.deploymentId,
          status: session.status,
          durationMs: session.durationMs,
        }
      : null,
  };
}

