/**
 * Service business logic - CRUD and compose sync.
 */

import { normalizeRoutingFields, repos, composeSpecDiff, type Service, type ServicePublicEndpoint } from "@repo/db";
import { serviceStatusToContainerState, isValidCustomHostname, ValidationError, type ServiceContainerState } from "@repo/core";
import {
  BuildLogger,
  isMultiServiceRuntime,
  type LogEntry,
  type ContainerStatus,
} from "@repo/adapters";
import { encrypt, decrypt } from "../../lib/encryption";
import { assertResourceInOrg, platform } from "../../lib/controller-helpers";
import type { RequestContext } from "../../lib/request-context";
import { resolveDeploymentPlatform } from "../../lib/deployment-runtime";
import { deployComposeServices } from "../deployments/compose/deploy.service";
import type { DeploymentConfigSnapshot } from "../deployments/build.service";
import { buildServiceRouteDomains, serviceCustomHostnames } from "../../lib/routing-domains";
import { ensurePendingServiceDomain, removeServiceDomain } from "../domains/domain.service";
import { buildUpstreamUrl, resolveRouteStrategy } from "../../lib/upstream-url";
import {
  reconcileProjectRoutes,
  type RouteRegister,
  type RouteRemove,
} from "../../lib/route-apply.service";
import type {
  TCreateServiceBody,
  TUpdateServiceBody,
  TSetServiceEnvVarsBody,
} from "./service.schema";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Verify a service exists and belongs to a project in the given org */
async function assertServiceAccess(
  ctx: RequestContext,
  projectId: string,
  serviceId: string,
) {
  const project = await repos.project.findById(projectId);
  assertResourceInOrg(project, "Project", ctx.organizationId, projectId);
  const svc = await repos.service.findById(serviceId);
  if (!svc || svc.projectId !== projectId) {
    throw new Error("service-not-found");
  }
  return { project, svc };
}

const trimOrNull = (value?: string | null) => {
  const trimmed = value?.trim();
  return trimmed || null;
};

/**
 * Patch-level wrapper around the canonical `normalizeRoutingFields` from
 * @repo/db. Same body - narrows `domainType` to the literal union the
 * service layer expects. Keeps a single source of truth: the DB repo
 * owns the trim/null/clear semantics, this layer just types them.
 */
function normalizeRoutingPatch(input: Parameters<typeof normalizeRoutingFields>[0]): {
  exposed: boolean;
  exposedPort: string | null;
  domain: string | null;
  customDomain: string | null;
  domainType: "free" | "custom";
  publicEndpoints: ServicePublicEndpoint[];
} {
  const r = normalizeRoutingFields(input);
  // Reject bogus custom hostnames (path / scheme / port / IP / single-label)
  // before they're stored — the single-app POST /domains flow has this shape
  // gate; service custom domains must match it so a bad value can't become an
  // unservable vhost / unverifiable row.
  const customHosts = [
    ...(r.domainType === "custom" && r.customDomain ? [r.customDomain] : []),
    ...r.publicEndpoints
      .filter((e) => e.domainType === "custom" && e.customDomain)
      .map((e) => e.customDomain as string),
  ];
  for (const host of customHosts) {
    if (!isValidCustomHostname(host)) {
      throw new ValidationError(`"${host}" is not a valid custom domain.`);
    }
  }
  return {
    ...r,
    domainType: r.domainType === "custom" ? "custom" : "free",
  };
}

// ─── Drift (compose reconciliation) ────────────────────────────────────────

/**
 * Attach a computed `drift` field: the base→upstream field diff when the repo
 * compose changed a value the user had edited (`driftSpec` set by
 * reconcileFromCompose). `null` when there's nothing pending review.
 */
function withDrift(svc: Service) {
  return {
    ...svc,
    drift: svc.driftSpec
      ? { changes: composeSpecDiff(svc.importedSpec ?? {}, svc.driftSpec) }
      : null,
  };
}

// ─── Read ────────────────────────────────────────────────────────────────────

export async function listServices(ctx: RequestContext, projectId: string) {
  const project = await repos.project.findById(projectId);
  assertResourceInOrg(project, "Project", ctx.organizationId, projectId);
  return (await repos.service.listByProject(projectId)).map(withDrift);
}

export async function getService(
  ctx: RequestContext,
  projectId: string,
  serviceId: string,
) {
  const { svc } = await assertServiceAccess(ctx, projectId, serviceId);
  return withDrift(svc);
}

/**
 * Accept the pending upstream compose change: apply `driftSpec` to the row's
 * compose fields, advance the baseline to it, and clear the drift. Routing and
 * `enabled` are untouched.
 */
export async function acceptServiceDrift(
  ctx: RequestContext,
  projectId: string,
  serviceId: string,
) {
  const { svc } = await assertServiceAccess(ctx, projectId, serviceId);
  const theirs = svc.driftSpec;
  if (!theirs) return withDrift(svc);
  await repos.service.update(serviceId, {
    image: theirs.image ?? null,
    build: theirs.build ?? null,
    dockerfile: theirs.dockerfile ?? null,
    ports: theirs.ports ?? [],
    dependsOn: theirs.dependsOn ?? [],
    environment: theirs.environment ?? {},
    volumes: theirs.volumes ?? [],
    command: theirs.command ?? null,
    restart: theirs.restart ?? "unless-stopped",
    advanced: theirs.advanced ?? {},
    importedSpec: theirs,
    driftSpec: null,
  });
  const updated = await repos.service.findById(serviceId);
  return withDrift(updated!);
}

/**
 * Keep the user's edits: advance the baseline to the upstream spec (so it stops
 * re-flagging on every deploy) WITHOUT changing the row's current values.
 */
export async function keepServiceDrift(
  ctx: RequestContext,
  projectId: string,
  serviceId: string,
) {
  const { svc } = await assertServiceAccess(ctx, projectId, serviceId);
  if (!svc.driftSpec) return withDrift(svc);
  await repos.service.update(serviceId, { importedSpec: svc.driftSpec, driftSpec: null });
  const updated = await repos.service.findById(serviceId);
  return withDrift(updated!);
}

// ─── Create / Update ─────────────────────────────────────────────────────────

export async function createService(
  ctx: RequestContext,
  projectId: string,
  data: TCreateServiceBody,
) {
  const project = await repos.project.findById(projectId);
  assertResourceInOrg(project, "Project", ctx.organizationId, projectId);

  const name = data.name.trim();
  if (!name) {
    throw new Error("service-name-required");
  }

  const existing = await repos.service.findByName(projectId, name);
  if (existing) {
    throw new Error("service-name-already-exists");
  }

  // Discriminator default: compose. Matches the DB column default.
  const kind: "compose" | "monorepo" = data.kind === "monorepo" ? "monorepo" : "compose";

  // Monorepo sub-apps MUST carry a rootDirectory - the validator keeps it
  // optional because the DB column is nullable (compose rows have null
  // monorepo fields), but a kind="monorepo" row with no rootDirectory
  // would silently fall back to repo root at build time. Catch it here
  // instead of letting the build engine pick an empty path.
  if (kind === "monorepo" && !data.rootDirectory?.trim()) {
    throw new Error("monorepo-service-requires-rootDirectory");
  }

  const services = await repos.service.listByProject(projectId);
  // Monorepo sub-apps auto-expose with a free subdomain by default - same
  // behaviour the project-import flow uses (project-crud.service.ts's
  // persistMonorepoApps defaults `exposed: true`, `domainType: "free"`).
  // Without this, sub-apps added later via the Services tab would default
  // to internal-only and the operator would have to flip both toggles
  // manually before the first deploy. Compose services keep the existing
  // `exposed: false` default because most compose rows (databases,
  // caches, queues) genuinely shouldn't be public.
  const monorepoDefaults = kind === "monorepo";
  const routing = normalizeRoutingPatch({
    exposed: data.exposed ?? monorepoDefaults,
    exposedPort: data.exposedPort,
    domain: data.domain,
    customDomain: data.customDomain,
    domainType: data.domainType ?? (monorepoDefaults ? "free" : undefined),
    publicEndpoints: data.publicEndpoints,
  });

  const created = await repos.service.create({
    projectId,
    name,
    kind,
    image: trimOrNull(data.image),
    build: trimOrNull(data.build),
    dockerfile: trimOrNull(data.dockerfile),
    ports: data.ports ?? [],
    dependsOn: data.dependsOn ?? [],
    environment: data.environment ?? {},
    volumes: data.volumes ?? [],
    command: trimOrNull(data.command),
    restart: data.restart ?? "unless-stopped",
    advanced: data.advanced ?? {},
    ...routing,
    enabled: data.enabled ?? true,
    sortOrder: data.sortOrder ?? services.length,
    // Monorepo sub-app fields - null for compose rows (the schema invariant).
    rootDirectory: kind === "monorepo" ? trimOrNull(data.rootDirectory) : null,
    installCommand: kind === "monorepo" ? trimOrNull(data.installCommand) : null,
    buildCommand: kind === "monorepo" ? trimOrNull(data.buildCommand) : null,
    startCommand: kind === "monorepo" ? trimOrNull(data.startCommand) : null,
    outputDirectory: kind === "monorepo" ? trimOrNull(data.outputDirectory) : null,
    framework: kind === "monorepo" ? trimOrNull(data.framework) : null,
    packageManager: kind === "monorepo" ? trimOrNull(data.packageManager) : null,
    buildImage: kind === "monorepo" ? trimOrNull(data.buildImage) : null,
  });

  // Mint verifiable PENDING rows for any custom domain configured at create
  // time, so the routing UI shows Verify/DNS/SSL immediately — parity with the
  // edit path. Live route registration still happens through the deploy/add
  // flow, not here.
  for (const hostname of serviceCustomHostnames(created)) {
    await ensurePendingServiceDomain({ projectId, serviceId: created.id, hostname });
  }

  return created;
}

export async function updateService(
  ctx: RequestContext,
  projectId: string,
  serviceId: string,
  data: TUpdateServiceBody,
) {
  const { project, svc } = await assertServiceAccess(ctx, projectId, serviceId);

  // Normalize routing: when exposed is turned off, clear routing fields.
  // When domainType changes, clear the irrelevant domain field.
  const patch: Record<string, any> = { ...data };

  if ("name" in patch && typeof patch.name === "string") {
    const name = patch.name.trim();
    if (!name) {
      throw new Error("service-name-required");
    }

    if (name !== svc.name) {
      const existing = await repos.service.findByName(projectId, name);
      if (existing && existing.id !== serviceId) {
        throw new Error("service-name-already-exists");
      }
    }

    patch.name = name;
  }

  for (const key of ["image", "build", "dockerfile", "command"] as const) {
    if (key in patch) {
      patch[key] = trimOrNull(patch[key]);
    }
  }
  // Monorepo sub-app build settings: same trim-or-null treatment so empty
  // strings become null in DB (matches the rest of the service columns).
  for (const key of [
    "rootDirectory",
    "installCommand",
    "buildCommand",
    "startCommand",
    "outputDirectory",
    "framework",
    "packageManager",
    "buildImage",
  ] as const) {
    if (key in patch) {
      patch[key] = trimOrNull(patch[key]);
    }
  }

  const touchesRouting = [
    "exposed",
    "exposedPort",
    "domain",
    "customDomain",
    "domainType",
    "publicEndpoints",
  ].some((key) => key in patch);
  const nameChanged = typeof patch.name === "string" && patch.name !== svc.name;

  if (touchesRouting) {
    const normalized = normalizeRoutingPatch({
      exposed: patch.exposed ?? svc.exposed,
      exposedPort: patch.exposedPort ?? svc.exposedPort,
      domain: patch.domain ?? svc.domain,
      customDomain: patch.customDomain ?? svc.customDomain,
      domainType: patch.domainType ?? svc.domainType,
      // Only fall back to the stored array when the caller didn't send one, so an
      // explicit [] (or a single-route edit) can clear the extra routes.
      publicEndpoints: "publicEndpoints" in patch ? patch.publicEndpoints : svc.publicEndpoints,
    });

    patch.exposed = normalized.exposed;
    patch.exposedPort = normalized.exposedPort ?? undefined;
    patch.domain = normalized.domain ?? undefined;
    patch.customDomain = normalized.customDomain ?? undefined;
    patch.domainType = normalized.domainType;
    patch.publicEndpoints = normalized.publicEndpoints;
  }

  await repos.service.update(serviceId, patch);
  const updated = await repos.service.findById(serviceId);

  // ── Route management ─────────────────────────────────────────
  // Keep live routes aligned when enable/expose/domain/port/name changes.
  const enabledChanged = typeof data.enabled === "boolean" && data.enabled !== svc.enabled;
  const exposedChanged = touchesRouting && patch.exposed !== svc.exposed;

  if (updated && (enabledChanged || exposedChanged || touchesRouting || nameChanged)) {
    try {
      const runtimeName = platform().runtime.name;
      // `enabled` / `exposed` are non-nullable DB columns - no need to
      // fall back to `svc.*` on the updated row.
      const isRoutable = updated.enabled && updated.exposed;
      // Diff the SET of routes (a service can publish several ports). A hostname
      // present before but gone now is removed; every current route is
      // (re-)registered (register is additive/idempotent upstream).
      const oldRoutes = buildServiceRouteDomains({ project, service: svc, runtimeName, usesManagedRouting: true });
      const nextRoutes = isRoutable
        ? buildServiceRouteDomains({ project, service: updated, runtimeName, usesManagedRouting: true })
        : [];
      const nextByHost = new Map(nextRoutes.map((route) => [route.hostname.toLowerCase(), route]));

      const removes: RouteRemove[] = oldRoutes
        .filter((route) => !nextByHost.has(route.hostname.toLowerCase()))
        .map((route) => ({ hostname: route.hostname, isCustomDomain: route.domainType === "custom" }));

      // Self-hosted upstream = loopback host port (published) or the active
      // deployment's service-row IP; cloud ignores targetUrl. Resolve once.
      let ip: string | undefined;
      let hostPort: number | undefined;
      if (isRoutable && nextRoutes.length > 0 && !project.cloudWorkspaceId && project.activeDeploymentId) {
        const rows = await repos.service.listByDeployment(project.activeDeploymentId);
        const row = rows.find((r) => r.serviceId === serviceId);
        ip = row?.ip ?? undefined;
        hostPort = row?.hostPort ?? undefined;
      }
      const strategy = resolveRouteStrategy(project.routeStrategy);
      const registers: RouteRegister[] = nextRoutes.map((route) => ({
        hostname: route.hostname,
        targetUrl: route.targetPort
          ? (buildUpstreamUrl({ strategy, ip, hostPort, containerPort: route.targetPort }) ?? undefined)
          : undefined,
        port: route.targetPort,
        isCustomDomain: route.domainType === "custom",
      }));

      // Mint a verifiable PENDING domain row for each custom service route, so
      // it flows through the same DNS-preflight/verify/SSL pipe as a single-app
      // custom domain (rather than only appearing — force-verified — at deploy).
      for (const route of nextRoutes) {
        if (route.domainType === "custom") {
          await ensurePendingServiceDomain({
            projectId: project.id,
            serviceId,
            hostname: route.hostname,
            targetPort: route.targetPort,
          });
        }
      }
      // Drop the derived row for any custom hostname the service no longer
      // CONFIGURES (cleared / renamed / switched to free) — keyed on config,
      // not routing state, so a mere unexpose keeps a verified domain's row.
      const stillConfigured = new Set(serviceCustomHostnames(updated));
      for (const hostname of serviceCustomHostnames(svc)) {
        if (!stillConfigured.has(hostname)) {
          await removeServiceDomain({ serviceId, hostname });
        }
      }

      // Single reused path: cloud → page/workspace primitives, self-hosted →
      // the deployment's own routing (local box or remote server/sandbox).
      const dep =
        !project.cloudWorkspaceId && project.activeDeploymentId
          ? await repos.deployment.findById(project.activeDeploymentId)
          : null;
      await reconcileProjectRoutes(project, { deployment: dep, registers, removes });
    } catch (err) {
      console.error(`[SERVICE] Failed to update route for ${svc.name}:`, err);
    }
  }

  return updated;
}

export async function deleteService(
  ctx: RequestContext,
  projectId: string,
  serviceId: string,
) {
  const { project, svc } = await assertServiceAccess(ctx, projectId, serviceId);

  if (project.activeDeploymentId) {
    const dep = await repos.deployment.findById(project.activeDeploymentId);
    const serviceDeployments = await repos.service.listByDeployment(project.activeDeploymentId);
    const serviceDeployment = serviceDeployments.find((row) => row.serviceId === serviceId);

    if (dep && serviceDeployment?.containerId) {
      const { platform } = await resolveServicePlatform(project, dep);
      await platform.runtime.destroy(serviceDeployment.containerId).catch((err: unknown) => {
        console.error(
          `[SERVICE] Failed to destroy service container ${serviceDeployment.containerId}:`,
          err,
        );
      });
      await platform.runtime.dispose?.();
    }
  }

  if (svc.exposed) {
    try {
      // Remove EVERY route the service published (a multi-port service has more
      // than one hostname).
      const routes = buildServiceRouteDomains({
        project,
        service: svc,
        runtimeName: platform().runtime.name,
        usesManagedRouting: true,
      });
      if (routes.length > 0) {
        // Same single path as edit: cloud → page/workspace teardown, self-hosted
        // → the deployment's OWN routing (never the local singleton, which would
        // leave a remote vhost proxying a now-dead upstream → 502).
        const dep =
          !project.cloudWorkspaceId && project.activeDeploymentId
            ? await repos.deployment.findById(project.activeDeploymentId)
            : null;
        await reconcileProjectRoutes(project, {
          deployment: dep,
          removes: routes.map((route) => ({
            hostname: route.hostname,
            isCustomDomain: route.domainType === "custom",
          })),
        });
      }
    } catch (err) {
      console.error(`[SERVICE] Failed to remove route for ${svc.name}:`, err);
    }
  }

  // Clear any derived routing rows (custom-domain pending/verified rows minted
  // for this service) so they don't outlive the service in the domains list.
  await repos.domain.deleteByServiceId(serviceId);

  await repos.service.remove(serviceId);
}

// ─── Service Environment Variables ───────────────────────────────────────────

export async function listServiceEnvVars(
  ctx: RequestContext,
  projectId: string,
  serviceId: string,
  environment?: string,
) {
  await assertServiceAccess(ctx, projectId, serviceId);

  const vars = await repos.project.listEnvVars(projectId, environment, serviceId);
  // Decrypt and mask secrets
  return vars.map((v) => ({
    ...v,
    value: v.isSecret ? "••••••••" : decrypt(v.value),
  }));
}

export async function setServiceEnvVars(
  ctx: RequestContext,
  projectId: string,
  serviceId: string,
  data: TSetServiceEnvVarsBody,
) {
  await assertServiceAccess(ctx, projectId, serviceId);

  // Encrypt values before storage
  const encrypted = data.vars.map((v) => ({
    key: v.key,
    value: encrypt(v.value),
    isSecret: v.isSecret,
  }));

  await repos.project.bulkSetEnvVars(projectId, data.environment, encrypted, serviceId);
  return { count: encrypted.length };
}

// ─── Compose Sync ────────────────────────────────────────────────────────────

export async function syncComposeServices(
  ctx: RequestContext,
  projectId: string,
  parsed: {
    name: string;
    image?: string;
    build?: string;
    dockerfile?: string;
    ports?: string[];
    dependsOn?: string[];
    environment?: Record<string, string>;
    volumes?: string[];
    command?: string;
    restart?: string;
    exposed?: boolean;
    exposedPort?: string;
    domain?: string;
    customDomain?: string;
    domainType?: "free" | "custom";
  }[],
) {
  const project = await repos.project.findById(projectId);
  assertResourceInOrg(project, "Project", ctx.organizationId, projectId);
  return repos.service.syncFromCompose(projectId, parsed);
}

// ─── Service Deployments (per-deployment state) ──────────────────────────────

export async function listServiceDeployments(deploymentId: string) {
  return repos.service.listByDeployment(deploymentId);
}

export async function getActiveServiceContainers(ctx: RequestContext, projectId: string) {
  const project = await repos.project.findById(projectId);
  assertResourceInOrg(project, "Project", ctx.organizationId, projectId);
  if (!project.activeDeploymentId) return [];
  const rows = await repos.service.listByDeployment(project.activeDeploymentId);
  if (rows.length === 0) return [];

  // Reflect the REAL runtime state, not the deploy-time status column (written
  // "success" once at deploy and never touched by stop/crash). The persisted
  // status is the fallback for every row.
  const persisted = () =>
    rows.map((row) => ({ ...row, status: serviceStatusToContainerState(row.status) }));

  const dep = await repos.deployment.findById(project.activeDeploymentId);
  const runtime = dep
    ? await resolveServicePlatform(project, dep)
        .then((r) => r.platform.runtime)
        .catch(() => null)
    : null;
  if (!runtime) return persisted();

  try {
    // FAST path: ONE label-filtered `docker ps` for the whole deployment
    // instead of N per-service `docker inspect` round-trips over SSH (the
    // latter made this endpoint take ~17s and time out the Services tab). The
    // dashboard polls this, so it MUST be one call.
    const live = await withLiveQueryTimeout(
      (async () => {
        if (runtime.supports("deploymentContainerQuery") && runtime.listDeploymentContainers) {
          const containers = await runtime.listDeploymentContainers(dep!.id);
          const byId = new Map(containers.map((c) => [c.containerId, c]));
          return rows.map((row) => {
            if (!row.containerId) return { ...row, status: serviceStatusToContainerState(row.status) };
            const c = byId.get(row.containerId);
            // A tracked container missing from `docker ps` is gone → stopped.
            return { ...row, status: c ? containerStatusToServiceState(c.status) : "stopped" };
          });
        }
        // Cloud (no batch query): per-workload lookup — bounded set, Oblien API
        // (not SSH), and it also refreshes the live private IP.
        if (runtime.supports("containerInfo")) {
          return Promise.all(
            rows.map(async (row) => {
              const fb = serviceStatusToContainerState(row.status);
              if (!row.containerId) return { ...row, status: fb };
              const info = await runtime.getContainerInfo(row.containerId).catch(() => null);
              return info
                ? { ...row, status: containerStatusToServiceState(info.status), ip: info.ip ?? row.ip }
                : { ...row, status: fb };
            }),
          );
        }
        return null; // runtime can't report → use persisted
      })(),
    );
    return live ?? persisted();
  } catch {
    return persisted();
  } finally {
    await runtime.dispose?.();
  }
}

/** Bound the live status query so a slow/hung runtime degrades to the persisted
 *  status instead of hanging the (polled) containers endpoint. */
function withLiveQueryTimeout<T>(p: Promise<T>): Promise<T | null> {
  return Promise.race([
    p,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 6000)),
  ]);
}

// ─── Per-service container actions ───────────────────────────────────────────

/** A service is a CONTAINER (Docker, on a server/local target) or an Oblien
 *  WORKSPACE (cloud) — never the app's bare host process. Resolve the platform
 *  with the runtime pinned to Docker so service start/stop/logs target the real
 *  service runtime even when the project's app deploys "bare". Cloud stays on
 *  CloudRuntime (runtimeMode is irrelevant there). */
async function resolveServicePlatform(
  project: { organizationId: string },
  dep: { meta: unknown },
) {
  const snapshot = { ...(dep.meta as DeploymentConfigSnapshot), runtimeMode: "docker" as const };
  return resolveDeploymentPlatform(snapshot, { organizationId: project.organizationId });
}

async function resolveServiceContainer(
  ctx: RequestContext,
  projectId: string,
  serviceId: string,
) {
  const project = await repos.project.findById(projectId);
  assertResourceInOrg(project, "Project", ctx.organizationId, projectId);
  if (!project.activeDeploymentId) throw new Error("No active deployment");

  const dep = await repos.deployment.findById(project.activeDeploymentId);
  if (!dep) throw new Error("Active deployment not found");

  const rows = await repos.service.listByDeployment(dep.id);
  const row = rows.find((r) => r.serviceId === serviceId);
  if (!row?.containerId) throw new Error("Service has no running container");

  const resolved = await resolveServicePlatform(project, dep);
  return {
    runtime: resolved.platform.runtime,
    containerId: row.containerId,
    serverId: resolved.serverId,
    row,
  };
}

/** Map a live runtime ContainerStatus onto the UI's service state vocabulary.
 *  Runtime truth (docker inspect / Oblien workload) — not the frozen deploy
 *  status column — so a stopped/crashed/removed service reads correctly. */
function containerStatusToServiceState(status: ContainerStatus): ServiceContainerState {
  switch (status) {
    case "running":
      return "running";
    case "failed":
    case "cancelled":
      return "failed";
    case "queued":
    case "building":
    case "deploying":
      return "starting";
    default:
      return "stopped"; // stopped | missing
  }
}

/**
 * Provision + launch ONE service on its OWN container/workspace, DECOUPLED from
 * the project deploy pipeline: no build phase, no one-deploy-at-a-time lock, no
 * single-app reap. Reuses the compose deploy scoped to this single service, so
 * it takes the exact runtime path (Docker on a server, Oblien workspace on
 * cloud) without touching the main app or the other services.
 */
async function provisionServiceContainer(
  ctx: RequestContext,
  projectId: string,
  serviceId: string,
) {
  const project = await repos.project.findById(projectId);
  assertResourceInOrg(project, "Project", ctx.organizationId, projectId);
  if (!project.activeDeploymentId) {
    throw new Error("Deploy the project first, then start its services.");
  }
  const dep = await repos.deployment.findById(project.activeDeploymentId);
  if (!dep) throw new Error("Active deployment not found");

  const service = (await repos.service.listByProject(projectId)).find((s) => s.id === serviceId);
  if (!service) throw new Error("Service not found");
  if (!service.image && !service.build) {
    throw new Error("Service has no image or build configured.");
  }
  if (!service.enabled) {
    await repos.service.update(serviceId, { enabled: true });
  }

  const resolved = await resolveServicePlatform(project, dep);
  const runtime = resolved.platform.runtime;
  if (!isMultiServiceRuntime(runtime)) {
    throw new Error(`The ${runtime.name} runtime cannot run services — enable Docker on this target.`);
  }

  // Surface the per-service provisioning trace (and any Oblien failure reason)
  // to the API log. A no-op logger here is why cloud add failures were opaque.
  const logger = new BuildLogger((entry) => {
    const line = entry.message.replace(/\n$/, "");
    if (!line) return;
    const tag = `[service-provision:${service.name}]`;
    if (entry.level === "error" || entry.level === "warn") console.error(tag, line);
    else console.log(tag, line);
  });
  try {
    const result = await deployComposeServices(project, dep, runtime, logger, {
      // Strictly scope to THIS service: carry live siblings forward as-is, but
      // never (re)deploy or reap a service we weren't asked to touch. Without
      // this, provisioning one service could re-deploy a freshly-added sibling
      // (UNIQUE(deploymentId,serviceId) violation → 400) or bounce/reap an
      // unrelated one. Full compose deploys (Mode 2) don't pass this flag.
      targetServiceIds: new Set([serviceId]),
      strictScope: true,
      routing: resolved.platform.routing,
      ssl: resolved.platform.ssl,
      system: resolved.platform.system,
      executor: resolved.platform.executor,
      usesManagedRouting: resolved.usesManagedRouting,
      serverId: resolved.serverId ?? undefined,
    });
    if (result.status === "failed") {
      // A source-built service has no image to launch on the decoupled path
      // (it only builds through the deploy pipeline) — steer to Redeploy.
      if (service.build && !service.image) {
        throw new Error(
          `"${service.name}" builds from source — use Redeploy to build and start it.`,
        );
      }
      throw new Error(result.error ?? "Failed to start service");
    }
    const svc = result.services.find((s) => s.serviceId === serviceId);
    return { containerId: svc?.containerId ?? "", ip: svc?.ip };
  } finally {
    await runtime.dispose?.();
  }
}

export async function startServiceContainer(
  ctx: RequestContext,
  projectId: string,
  serviceId: string,
) {
  // Existing container → just start it. No container yet → provision it on its
  // own (image → container/workspace), decoupled from the project deploy.
  const existing = await resolveServiceContainer(ctx, projectId, serviceId).catch(() => null);
  if (existing?.containerId) {
    try {
      await existing.runtime.start(existing.containerId);
      await repos.service
        .updateServiceDeployment(existing.row.id, { status: "success" })
        .catch(() => {});
      return { containerId: existing.containerId };
    } finally {
      await existing.runtime.dispose?.();
    }
  }
  return provisionServiceContainer(ctx, projectId, serviceId);
}

export async function stopServiceContainer(
  ctx: RequestContext,
  projectId: string,
  serviceId: string,
) {
  const { runtime, containerId, row } = await resolveServiceContainer(
    ctx,
    projectId,
    serviceId,
  );
  try {
    await runtime.stop(containerId);
    // Persist the state change (partial update — preserves ip/imageRef) so
    // every reader converges, not just the live-reconciled services panel.
    await repos.service.updateServiceDeployment(row.id, { status: "stopped" }).catch(() => {});
    return { containerId };
  } finally {
    await runtime.dispose?.();
  }
}

export async function restartServiceContainer(
  ctx: RequestContext,
  projectId: string,
  serviceId: string,
) {
  const { runtime, containerId, row } = await resolveServiceContainer(
    ctx,
    projectId,
    serviceId,
  );
  try {
    await runtime.restart(containerId);
    await repos.service.updateServiceDeployment(row.id, { status: "success" }).catch(() => {});
    return { containerId };
  } finally {
    await runtime.dispose?.();
  }
}

export async function getServiceRuntimeLogs(
  ctx: RequestContext,
  projectId: string,
  serviceId: string,
  tail?: number,
) {
  const { runtime, containerId } = await resolveServiceContainer(
    ctx,
    projectId,
    serviceId,
  );
  try {
    return await runtime.getRuntimeLogs(containerId, tail);
  } finally {
    await runtime.dispose?.();
  }
}

export async function streamServiceRuntimeLogs(
  ctx: RequestContext,
  projectId: string,
  serviceId: string,
  onLog: (entry: LogEntry) => void,
  opts?: { tail?: number },
) {
  const { runtime, containerId, serverId } = await resolveServiceContainer(
    ctx,
    projectId,
    serviceId,
  );
  const stop = await runtime.streamRuntimeLogs(containerId, onLog, opts);
  // Dispose the runtime transport (e.g. the SSH loopback bridge) when the
  // stream is torn down — NOT before, or it would kill the live stream.
  const cleanup = () => {
    try {
      stop();
    } finally {
      void runtime.dispose?.();
    }
  };
  return { cleanup, serverId };
}

