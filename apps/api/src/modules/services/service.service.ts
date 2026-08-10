/**
 * Service business logic - CRUD and compose sync.
 */

import { normalizeRoutingFields, repos, composeSpecDiff, type Project, type Service, type ServicePublicEndpoint } from "@repo/db";
import { aliasConflictsWithSiblings, ForbiddenError, getProjectType, mergeAdvanced, normalizeServiceLabel, normalizeAliasStrict, withTimeout, type ComposeAdvanced, type ServiceContainerState, type StackId } from "@repo/core";
import {
  BuildLogger,
  DockerRuntime,
  isMultiServiceRuntime,
  type LogEntry,
  type ContainerStatus,
} from "@repo/adapters";
import { scopedVolumeName, type CommandExecutor } from "@repo/adapters";
import { encrypt, decrypt } from "../../lib/encryption";
import { ENV_MASK, hasMaskedValue, maskDriftChanges, maskServiceEnv, unmaskEnv } from "../../lib/secret-env";
import { assertResourceInOrg, platform } from "../../lib/controller-helpers";
import { assertValidCustomDomains, customHostnamesOf } from "../../lib/custom-domain-guard";
import type { RequestContext } from "../../lib/request-context";
import {
  resolveServerExecutor,
  resolveDeploymentRuntimeForRead,
} from "../../lib/deployment-runtime";
import {
  containerIdForService,
  liveContainerIdWithRuntime,
  resolveServicePlatform,
  resolveServiceRuntimeForRead,
} from "./service-container";
import { resolveLiveServiceState, type LiveMatchKind } from "./live-state";
import { parseVolumeSpec, type VolumeKind } from "./volume-spec";
import { sq } from "../migration/direct-transfer";
import { bounded, duBytes, volumeBytes } from "../migration/migration-size";
import { deployComposeServices } from "../deployments/compose/deploy.service";
import { deriveProjectRouteState } from "../domains/project-route.service";
import { registerStartupHook } from "../../lib/startup";
import { buildServiceRouteDomains, serviceCustomHostnames } from "../../lib/routing-domains";
import {
  mergeServiceRoutingPatch,
  publicEndpointHostname,
  resolveServicePublicEndpoints,
} from "../../lib/public-endpoints";
import { resolveRuntimeResources } from "../../lib/resources";
import { assertFreeEndpointsAllowed } from "../../lib/free-domain-guard";
import { ensurePendingServiceDomain, removeServiceDomain, reuseServerCertForDomain } from "../domains/domain.service";
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

/** Cap how long a route update AWAITS the (SSH) edge re-register before
 *  returning. Past this, the DB change is already saved and the edge apply
 *  finishes in the background — so a slow REMOTE edge never hangs the modal on a
 *  change that already took effect. Routing is best-effort; routingUnsynced
 *  surfaces if the background apply lags. */
const ROUTE_EDGE_APPLY_TIMEOUT_MS = 6000;

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
  // before they're stored — the shared gate every custom-domain write path calls,
  // so a bad value can't become an unservable vhost / unverifiable row.
  assertValidCustomDomains([r]);
  return {
    ...r,
    domainType: r.domainType === "custom" ? "custom" : "free",
  };
}

// ─── Drift (compose reconciliation) ────────────────────────────────────────

/**
 * Present a service row to the client: attach a computed `drift` field and mask
 * the compose `environment` map (#336). `drift` is the base→upstream field diff
 * when the repo compose changed a value the user had edited (`driftSpec` set by
 * reconcileFromCompose), `null` when there's nothing pending review.
 *
 * Masking is OUTPUT-ONLY — the stored row keeps the real values (the deploy
 * pipeline injects them). The env map here becomes all-`••••••••`; operators
 * reveal real values on demand via the write-gated reveal endpoint, and writes
 * treat the sentinel as "keep stored" (see secret-env.ts). The drift diff's
 * `environment` from/to are masked too so the reconcile UI can't leak them.
 */
// Lives in @repo/core now that the compose sync in @repo/db merges with it too
// (packages/db cannot import from apps/api). Re-exported so this module's
// existing importers and tests are unchanged.
export { mergeAdvanced };

/**
 * Validate + canonicalize a compose service's custom east-west alias in place.
 * An empty entry is dropped; a non-empty one is normalized to a DNS label and
 * rejected when it carries no usable characters or collides with another
 * service's name/alias on the SAME project network (embedded DNS is first-match,
 * so a duplicate would resolve ambiguously). No-op when the blob has no `alias`.
 */
export async function validateServiceAlias(
  projectId: string,
  serviceId: string,
  advanced: ComposeAdvanced,
  projectInternalAlias?: string | null,
): Promise<void> {
  if (!("alias" in advanced)) return;
  const raw = advanced.alias;
  if (raw == null || (typeof raw === "string" && !raw.trim())) {
    delete advanced.alias;
    return;
  }
  const alias = normalizeAliasStrict(String(raw));
  if (!alias) throw new Error("service-alias-invalid");

  const siblings = (await repos.service.listByProject(projectId)).filter((s) => s.id !== serviceId);
  if (aliasConflictsWithSiblings(alias, siblings, projectInternalAlias)) {
    throw new Error("service-alias-conflict");
  }
  advanced.alias = alias;
}

/**
 * Reject a new/renamed service NAME that would shadow a hostname already taken on
 * the project network. Mirrors validateServiceAlias but for the name direction:
 * the normalized name is checked against sibling names AND their custom aliases
 * AND the project's single-app internalAlias — because a container answers to all
 * of those. Normalized (not the old exact `findByName`), so "My DB"/"my-db" are
 * caught too. Self is excluded via `serviceId`; create passes "" so every existing
 * row counts.
 */
export async function validateServiceName(
  projectId: string,
  serviceId: string,
  name: string,
  projectInternalAlias?: string | null,
): Promise<void> {
  const label = normalizeServiceLabel(name);
  const siblings = (await repos.service.listByProject(projectId)).filter((s) => s.id !== serviceId);
  if (aliasConflictsWithSiblings(label, siblings, projectInternalAlias)) {
    throw new Error("service-name-already-exists");
  }
}

// Re-exported for service-alias.test.ts, which imports the pure collision
// predicate from this module. The implementation now lives in @repo/core (beside
// the normalize helpers it depends on) so project-crud can reuse it without
// pulling this module's adapters graph.
export { aliasConflictsWithSiblings };

function withDrift(svc: Service) {
  return {
    ...maskServiceEnv(svc),
    drift: svc.driftSpec
      ? { changes: maskDriftChanges(composeSpecDiff(svc.importedSpec ?? {}, svc.driftSpec)) }
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
 * #336: return a service's REAL (unmasked) compose `environment`. This is the
 * write-gated reveal that backs the "show values" toggle — the route tag is
 * `project:service:write`, so a read-only caller can never reach the plaintext
 * (the whole point: read = masked). `getService` above always masks.
 */
export async function revealServiceEnv(
  ctx: RequestContext,
  projectId: string,
  serviceId: string,
): Promise<Record<string, string>> {
  const { svc } = await assertServiceAccess(ctx, projectId, serviceId);
  return (svc.environment as Record<string, string> | null) ?? {};
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

/**
 * #231: An app-framework project's own app is NOT a `service` row. The compose
 * deploy fans out over service rows, so the moment a sidecar (Postgres/Redis/…)
 * is added the deploy runs ONLY the sidecars and the app disappears — while still
 * reporting "ready". Materialize the app as a `monorepo` service row so the single
 * compose pipeline deploys app + sidecars together.
 *
 * The row carries NULL build fields → they fall back to the project snapshot in
 * compose/build.service.ts, so it builds identically to the single-app path — and
 * it mirrors the project's unified port→domain route (exposedPort + the project's
 * public endpoints). Idempotent, and guarded to a real app-framework SERVER
 * project's first compose sidecar; genuine docker-compose / services / monorepo
 * projects and static/no-server apps are left alone.
 */
async function materializeAppServiceRow(project: Project): Promise<void> {
  if (!project.hasServer) return; // no long-running app container to keep
  // A catalog / self-managed app (appTemplateId set — e.g. the control plane's
  // own "openship" project) is NOT a source-built single app: its real units are
  // the compose rows linked by the app/self-app installer, never a slug-named
  // `monorepo` row. Materializing one here seeds a PHANTOM public service that no
  // container ever matches (shows perpetually "Stopped") with an unwanted
  // {slug}-{slug} free-subdomain route. Leave these projects to their linker.
  if (project.appTemplateId) return;
  let projectType: string;
  try {
    projectType = getProjectType((project.framework ?? "") as StackId);
  } catch {
    return; // unknown framework → leave shape resolution to the existing paths
  }
  if (projectType !== "app") return; // services / docker-compose / monorepo already multi-unit

  const rows = await repos.service.listByProject(project.id);
  const hasSidecar = rows.some((s) => s.kind === "compose");
  const hasAppRow = rows.some((s) => s.kind === "monorepo");
  // Nothing to pair the app with, or the app row already exists. Idempotent, so
  // it is safe to call on every sidecar add AND from the boot backfill.
  if (!hasSidecar || hasAppRow) return;

  const projectDomains = await repos.domain.listByProject(project.id).catch(() => []);
  const routeState = deriveProjectRouteState(project, { projectDomains });
  // Reuse the SAME normalizer createService uses so the mirrored project route
  // lands as ServicePublicEndpoint[] (exposed/exposedPort/domain scalars + the
  // per-port endpoints), keeping the unified port→domain mapping.
  //
  // `exposed` MIRRORS the project's persisted routes rather than asserting true: a
  // project with no domain row (the port-only install — the default, since project
  // create never invents one) has nothing to mirror, and the compose fan-out reads
  // routes from THIS row, so `exposed: true` with an empty set bought no routing at
  // all. It only produced a row that claims to be public with no hostname, which is
  // what let surfaces downstream manufacture a `{slug}-{slug}.<base>` URL nobody
  // chose. The port is still recorded, so flipping the route on later needs no
  // re-entry.
  const routing = normalizeRoutingPatch({
    exposed: routeState.publicEndpoints.length > 0,
    exposedPort: project.port != null ? String(project.port) : null,
    publicEndpoints: routeState.publicEndpoints,
  });

  await repos.service.create({
    projectId: project.id,
    name: project.slug,
    kind: "monorepo",
    rootDirectory: project.rootDirectory ?? ".",
    enabled: true,
    sortOrder: -1, // app first in the fan-out
    ...routing,
    // build fields left undefined → project-snapshot fallback (identical single-app
    // build). Persistent storage inherits the same way (see appRowVolumes in
    // compose/deploy.service.ts), so editing it on the project keeps reaching the
    // app after a sidecar is added — copying it here would freeze it instead.
  });
}

/**
 * #231 backfill: app-framework projects that gained sidecars BEFORE the
 * materialization above shipped have a compose row but no app row, so their
 * deploy drops the app. Run the same (idempotent) materialization once per boot
 * for every project — the helper no-ops unless the project has a sidecar and no
 * app row. Self-hosted + desktop only (the whole startup module is a no-op under
 * CLOUD_MODE).
 */
export function registerAppServiceMaterializeBackfill(): void {
  registerStartupHook({
    id: "services:materialize-app-backfill",
    modes: ["selfhosted", "desktop"],
    run: async () => {
      const projects = await repos.project.listAllForScan().catch(() => []);
      for (const project of projects) {
        await materializeAppServiceRow(project).catch((err) =>
          console.warn(
            `[services] app-materialize backfill skipped for ${project.id}: ${(err as Error).message}`,
          ),
        );
      }
    },
  });
}

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

  // Reject a name colliding with a sibling's name OR custom alias OR the
  // project's single-app internalAlias — every hostname the network already
  // resolves. Normalized, so "My DB"/"my-db" collide too (the old exact
  // findByName missed both aliases and normalization).
  await validateServiceName(projectId, "", name, project.internalAlias);

  // #336: a brand-new service has no stored env to restore from, so any masked
  // sentinel the client sent is dropped (never persist "••••••••"). Warn so a
  // real value accidentally lost this way is traceable.
  if (data.environment && hasMaskedValue(data.environment)) {
    console.warn(
      `[services] create "${name}": dropping masked env value(s) with no stored source`,
    );
    data = { ...data, environment: unmaskEnv(data.environment, null) };
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
  // Same merge rule as updateService — a brand-new row is just the `stored: null`
  // case, so create and update can't drift apart on what a routing payload means.
  const routing = normalizeRoutingPatch(
    mergeServiceRoutingPatch({
      patch: {
        exposed: data.exposed ?? monorepoDefaults,
        exposedPort: data.exposedPort,
        domain: data.domain,
        customDomain: data.customDomain,
        domainType: data.domainType ?? (monorepoDefaults ? "free" : undefined),
        publicEndpoints: data.publicEndpoints,
      },
      stored: null,
    }),
  );

  // Atomic gate, same rule and placement as updateService: a free (*.opsh.io)
  // route only resolves behind the Openship Cloud edge, so refuse BEFORE the
  // insert. Without this a create could PERSIST a route that is dead by
  // construction — reachable through the app installer, which seeds every
  // template service's routes here.
  await assertFreeEndpointsAllowed(
    ctx.organizationId,
    resolveServicePublicEndpoints({ ...routing, ports: data.ports ?? [] }),
    "managed-compose-domains",
  );

  // Through mergeAdvanced even on CREATE: there is nothing to preserve, but it
  // strips the `null`-means-remove sentinels the update path accepts, so a
  // caller can send one payload shape to both.
  const advanced = mergeAdvanced(null, data.advanced);
  // Same alias gate as updateService — normalize + reject invalid/colliding
  // custom aliases BEFORE the insert, so a create can't persist an alias the
  // update path would refuse. No serviceId yet, so pass "" — every existing
  // service counts as a sibling, which is exactly right for a new row.
  await validateServiceAlias(projectId, "", advanced, project.internalAlias);

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
    commandArgv: data.commandArgv ?? null, // #332
    restart: data.restart ?? "unless-stopped",
    advanced,
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

  // #231: keep the app deployable once it gains a compose sidecar (see helper).
  // Best-effort — a failure here must never block adding the service.
  if (kind === "compose") {
    await materializeAppServiceRow(project).catch((err) =>
      console.warn(`[services] app materialization skipped: ${(err as Error).message}`),
    );
  }

  return maskServiceEnv(created);
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

  // #336: env values are masked on read. Restore any sentinel the client echoed
  // back to the stored value so editing an unrelated field never overwrites a
  // secret with "••••••••". A real (revealed-and-changed) value passes through.
  if ("environment" in patch) {
    patch.environment = unmaskEnv(
      patch.environment,
      svc.environment as Record<string, string> | null,
    );
  }

  // `advanced` is ONE blob holding independent, separately-owned keys —
  // `healthcheck` (edited in the service form), `readiness` (the deploy gate),
  // `files` (written by an app template at install), `resources` (per-service
  // caps). Writing `data.advanced` straight through replaced the whole thing, so
  // any partial caller silently dropped every key it didn't mention. That is not
  // hypothetical: this route is MCP-exposed, so an agent setting a healthcheck
  // would erase the readiness gate — quietly changing whether deploys can fail —
  // along with an app template's generated config files.
  //
  // Same shape of fix as `environment` above: merge against what's stored, and
  // make removal explicit. Shallow by design — the keys are independent, and a
  // deep merge would make a partially-specified healthcheck inherit stale fields.
  if ("advanced" in patch) {
    patch.advanced = mergeAdvanced(svc.advanced as ComposeAdvanced | null, patch.advanced);
    await validateServiceAlias(projectId, serviceId, patch.advanced as ComposeAdvanced, project.internalAlias);
  }

  if ("name" in patch && typeof patch.name === "string") {
    const name = patch.name.trim();
    if (!name) {
      throw new Error("service-name-required");
    }

    if (name !== svc.name) {
      // Same normalized, alias-aware gate as create, excluding this row.
      await validateServiceName(projectId, serviceId, name, project.internalAlias);
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
    // A scalar patch is an UPSERT of ONE route into the stored set (keyed by
    // port), never a write-back of the stored primary and never a collapse — see
    // mergeServiceRoutingPatch. Before this, an array on the row shadowed the
    // scalars outright: the user's chosen custom domain was dropped and the gate
    // below then judged the stored "free" primary instead.
    const normalized = normalizeRoutingPatch(
      mergeServiceRoutingPatch({ patch, stored: svc }),
    );

    // Write the merged routing through VERBATIM, nulls included. `normalized` is
    // the row's whole intended routing state (unexposing only closes the gate — it
    // no longer clears the set), so every null here is a real clear: switching to a
    // custom domain must null `domain`, and switching back must null `customDomain`
    // or the row keeps a stale hostname under the other type. Collapsing null →
    // undefined to make drizzle skip the column left exactly that inconsistency.
    patch.exposed = normalized.exposed;
    patch.exposedPort = normalized.exposedPort;
    patch.domain = normalized.domain;
    patch.customDomain = normalized.customDomain;
    patch.domainType = normalized.domainType;
    patch.publicEndpoints = normalized.publicEndpoints;

    const nextEndpoints = resolveServicePublicEndpoints({
      exposed: patch.exposed,
      exposedPort: patch.exposedPort,
      ports: svc.ports,
      domain: patch.domain,
      customDomain: patch.customDomain,
      domainType: patch.domainType,
      publicEndpoints: patch.publicEndpoints,
    });
    // Already-configured hostnames are exempt: read the stored routes with
    // `exposed: true` so the CONFIG (not the paused/exposed state) is the
    // baseline — an expose toggle must not read as introducing a route.
    const priorHosts = new Set(
      resolveServicePublicEndpoints({ ...svc, exposed: true })
        .map((endpoint) => publicEndpointHostname(endpoint)?.toLowerCase())
        .filter((hostname): hostname is string => !!hostname),
    );
    // Atomic gate: a free (*.opsh.io) route only resolves behind the Openship
    // Cloud edge. Refuse before the DB write so a disconnected instance can't
    // persist a dead "Pending" route. Only NET-NEW free routes gate — same rule
    // as the project path: re-validating the whole set made a service that
    // already carries a free sibling (an app template's second port) impossible
    // to edit at all, including switching it to a custom domain.
    await assertFreeEndpointsAllowed(
      ctx.organizationId,
      nextEndpoints.filter((endpoint) => {
        const hostname = publicEndpointHostname(endpoint)?.toLowerCase();
        return hostname ? !priorHosts.has(hostname) : false;
      }),
      "managed-compose-domains",
    );
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

      // Authoritative port: the upstream above is rebuilt from the LIVE
      // deployment's published port on every publish, so reconcileProjectRoutes
      // OVERWRITES whatever the edge vhost currently forwards to — a manual (or
      // migrated foreign-proxy) port edit can't survive. If a routable route
      // still resolves NO upstream, the live port wasn't found — warn so the
      // 502 cause is visible instead of a silently portless vhost.
      for (const reg of registers) {
        if (reg.port && !reg.targetUrl) {
          console.warn(
            `[SERVICE] ${svc.name}: no live upstream for ${reg.hostname} (port ${reg.port}) — ` +
              `route may 502 until the deployment publishes that port.`,
          );
        }
      }

      // Mint a verifiable PENDING domain row for each custom service route, so
      // it flows through the same DNS-preflight/verify/SSL pipe as a single-app
      // custom domain (rather than only appearing — force-verified — at deploy).
      // Track the freshly-created ones so we can reuse an existing on-server cert
      // for them below (migration / first publish) instead of forcing an ACME
      // re-issue.
      const freshlyPublishedDomainIds: string[] = [];
      for (const route of nextRoutes) {
        if (route.domainType === "custom") {
          const ensured = await ensurePendingServiceDomain({
            projectId: project.id,
            serviceId,
            hostname: route.hostname,
            targetPort: route.targetPort,
          });
          if (ensured.created && ensured.domainId) freshlyPublishedDomainIds.push(ensured.domainId);
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

      // The edge re-register (+ cert reuse) runs over SSH to the serving box.
      // When that box is REMOTE (desktop mode) the write+reload can be slow — and
      // the service row is ALREADY saved above, with routing being best-effort
      // ([[domains-never-fail-deploy]]). So DON'T let the SSH edge apply hang the
      // request: bound the await and, past the cap, RETURN while it finishes in
      // the background. Otherwise the modal spins and times out on a change that
      // already applied (the reported "keeps loading, but it took effect").
      const applyEdge = (async () => {
        await reconcileProjectRoutes(project, { deployment: dep, registers, removes });
        // AFTER reconcile so installDomainCert re-registers the vhost with TLS on
        // top of the live HTTP route — adopt an existing cert for a freshly
        // published custom domain (migration / takeover) instead of ACME.
        for (const domainId of freshlyPublishedDomainIds) {
          await reuseServerCertForDomain(ctx, domainId).catch(() => {});
        }
      })();
      applyEdge.catch((err) => console.error(`[SERVICE] edge apply for ${svc.name}:`, err));
      await Promise.race([
        applyEdge,
        new Promise<void>((resolve) => setTimeout(resolve, ROUTE_EDGE_APPLY_TIMEOUT_MS)),
      ]);
    } catch (err) {
      console.error(`[SERVICE] Failed to update route for ${svc.name}:`, err);
    }
  }

  return maskServiceEnv(updated);
}

/** Best-effort runtime/route teardown is bounded so a slow or unreachable box
 *  can't hang the delete request past the DB-row removal (the authoritative op). */
const SERVICE_TEARDOWN_TIMEOUT_MS = 20_000;

/**
 * Refuse lifecycle/teardown actions on the CONTROL PLANE's own services.
 *
 * The self-app project's services are the Openship stack itself (api, dashboard,
 * edge, postgres, redis), linked so the dashboard can SHOW their state, logs and
 * shell. Acting on them from here is a foot-gun with no upside: stopping `api` is
 * the request killing the process serving it, and deleting `postgres` would tear
 * down the control plane's own database. Same policy — and same wording — as the
 * existing deploy/redeploy/delete guards (build.service, deployment.service,
 * project.controller): the CLI owns this runtime.
 *
 * Read paths (status/logs/terminal) are deliberately NOT gated — they're the
 * reason the services are linked at all.
 */
function assertNotControlPlaneService(project: { appTemplateId?: string | null } | undefined): void {
  if (project?.appTemplateId === "openship") {
    throw new ForbiddenError(
      "These are the Openship control plane's own services — manage them with the CLI " +
        "(`openship restart`, `openship up`), not from the dashboard.",
    );
  }
}

export async function deleteService(
  ctx: RequestContext,
  projectId: string,
  serviceId: string,
) {
  const { project, svc } = await assertServiceAccess(ctx, projectId, serviceId);
  assertNotControlPlaneService(project);

  if (project.activeDeploymentId) {
    const dep = await repos.deployment.findById(project.activeDeploymentId);
    const serviceDeployments = await repos.service.listByDeployment(project.activeDeploymentId);
    const serviceDeployment = serviceDeployments.find((row) => row.serviceId === serviceId);

    if (dep && serviceDeployment?.containerId) {
      // Runtime teardown is best-effort AND time-bounded: reaching the box is an
      // SSH round-trip, so a slow/unreachable server or a stale container (e.g. a
      // legacy row whose container is already gone) must never HANG the request.
      // The `.catch()`es only cover rejection — a hang would block until the HTTP
      // request aborts and the DB removal below (the authoritative, atomic op)
      // would never run, so the row could never be deleted. withTimeout converts a
      // hang into a caught failure; a lingering container is reaped by images:gc /
      // manual cleanup. Keyed on serviceId throughout — never by name.
      const containerId = serviceDeployment.containerId;
      await withTimeout(
        (async () => {
          const { platform } = await resolveServicePlatform(project, dep);
          await platform.runtime.destroy(containerId).catch((err: unknown) => {
            console.error(`[SERVICE] Failed to destroy service container ${containerId}:`, err);
          });
          // Reclaim this service's built image NOW — the FK cascade in
          // repos.service.remove() below erases the imageRef record, so a later
          // teardown could never enumerate it. Guarded to `openship/…` build tags:
          // a base/third-party image (postgres:16-alpine, redis:7-alpine) is PULLED,
          // shared, and must never be removed. Best-effort; images:gc is the backstop.
          if (
            serviceDeployment.imageRef?.startsWith("openship/") &&
            platform.runtime instanceof DockerRuntime
          ) {
            await platform.runtime.removeImage(serviceDeployment.imageRef).catch((err: unknown) => {
              console.error(`[SERVICE] Failed to remove image for ${svc.name}:`, err);
            });
          }
          await platform.runtime.dispose?.();
        })(),
        SERVICE_TEARDOWN_TIMEOUT_MS,
        `runtime teardown timed out for ${svc.name}`,
      ).catch((err: unknown) => {
        console.error(`[SERVICE] Runtime teardown skipped for ${svc.name} (best-effort):`, err);
      });
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
        await withTimeout(
          reconcileProjectRoutes(project, {
            deployment: dep,
            removes: routes.map((route) => ({
              hostname: route.hostname,
              isCustomDomain: route.domainType === "custom",
            })),
          }),
          SERVICE_TEARDOWN_TIMEOUT_MS,
          `route teardown timed out for ${svc.name}`,
        );
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
    value: v.isSecret ? ENV_MASK : decrypt(v.value),
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
    /** Multi-route services. `syncFromCompose` persists these (service.repo
     *  normalizeRoutingFields), so they're declared here to be gated below. */
    publicEndpoints?: Array<{ customDomain?: string; domainType?: string }>;
  }[],
) {
  const project = await repos.project.findById(projectId);
  assertResourceInOrg(project, "Project", ctx.organizationId, projectId);

  // #336: env is masked on read, so the client may echo the mask sentinel back.
  // Restore each service's masked values from its stored row (matched by name)
  // before persisting, so a sync never overwrites a secret with "••••••••".
  const stored = await repos.service.listByProject(projectId);
  const storedEnvByName = new Map(
    stored.map((s) => [s.name, (s.environment as Record<string, string> | null) ?? {}]),
  );

  // Import path, but the hostnames are still client-authored — same gate as the
  // create/update editors (normalizeRoutingPatch); `syncFromCompose` writes the
  // routing columns directly, so this is the only place that can refuse them.
  // Hostnames the stored rows already carry are exempt: a re-sync of a project
  // holding a bad one (persisted before #342) must not be refused wholesale.
  assertValidCustomDomains(parsed, { known: customHostnamesOf(stored) });

  const reconciled = parsed.map((svc) =>
    svc.environment
      ? { ...svc, environment: unmaskEnv(svc.environment, storedEnvByName.get(svc.name) ?? null) }
      : svc,
  );

  const synced = await repos.service.syncFromCompose(projectId, reconciled);
  return synced.map(maskServiceEnv);
}

// ─── Service Deployments (per-deployment state) ──────────────────────────────

export async function listServiceDeployments(deploymentId: string) {
  return repos.service.listByDeployment(deploymentId);
}

/** One row of the Services panel's live view. Config (id/name) is DB-owned;
 *  everything else is read off the host on every request. */
export interface LiveServiceContainer {
  serviceId: string;
  serviceName: string;
  /** The container the service ACTUALLY runs as — resolved live, so logs /
   *  terminal / start act on the real thing even after an adopt or an
   *  out-of-band recreate. */
  containerId: string | null;
  status: ServiceContainerState;
  ip: string | null;
  hostPort: number | null;
  imageRef: string | null;
  /** Which identity key resolved the container (label / name / trackedId /
   *  compose), or null when nothing matched. Diagnostic. */
  matchedBy: LiveMatchKind | null;
  /** Other containers on the host that also answer to this service — a leftover
   *  duplicate the operator should know about. */
  duplicates: string[];
}

/**
 * The Services panel's state, read LIVE from the host every time.
 *
 * The service ROWS are the config (DB); their state never is. Earlier this asked
 * docker for `label=openship.deployment=<active dep>` and intersected with each
 * row's stored container id, which made every ADOPTED container invisible — a
 * migration attaches running containers in place and docker labels can't be
 * changed in place, so an attached container keeps the OLD deployment label and
 * reported "stopped" while serving traffic. Identity is now resolved by
 * label → canonical name → tracked id → compose label (see live-state.ts) and
 * the status comes off whatever that resolves to.
 */
export async function getActiveServiceContainers(
  ctx: RequestContext,
  projectId: string,
): Promise<LiveServiceContainer[]> {
  const project = await repos.project.findById(projectId);
  assertResourceInOrg(project, "Project", ctx.organizationId, projectId);

  // Every CONFIGURED service, not just those with a row in the active deployment
  // — a service the deployment never recorded (attached by a migration, added
  // afterwards) must still report its real state instead of vanishing.
  const services = await repos.service.listByProject(projectId);
  if (services.length === 0) return [];

  const dep = project.activeDeploymentId
    ? await repos.deployment.findById(project.activeDeploymentId)
    : null;
  // service_deployment rows are IDENTITY HINTS ONLY (container id, image). Their
  // `status` column is a deploy-time artifact and is never read for liveness.
  const hints = new Map(
    (dep ? await repos.service.listByDeployment(dep.id) : []).map((r) => [r.serviceId, r]),
  );
  const trackedIds = Object.fromEntries(
    [...hints.entries()].map(([serviceId, r]) => [serviceId, r.containerId]),
  );

  /** Shape one row without a live match — used when there is nothing to query
   *  (never deployed) or when the host could not be reached ("unknown"). */
  const flat = (status: ServiceContainerState): LiveServiceContainer[] =>
    services
      .filter((svc) => svc.enabled !== false)
      .map((svc) => {
        const hint = hints.get(svc.id);
        return {
          serviceId: svc.id,
          serviceName: svc.name,
          containerId: hint?.containerId ?? null,
          status,
          ip: hint?.ip ?? null,
          hostPort: hint?.hostPort ?? null,
          imageRef: hint?.imageRef ?? null,
          matchedBy: null,
          duplicates: [],
        };
      });

  if (!dep) return flat("stopped"); // nothing deployed yet → nothing can be live

  // ONE budget for the WHOLE live path — platform resolution included. That
  // resolution opens the pooled SSH connection (resolveServerExecutor →
  // sshManager.acquire), and it used to sit OUTSIDE the timeout: an unreachable
  // or saturated box (e.g. one busy receiving a build-context transfer) stalled
  // this *polled* endpoint past the dashboard's 15s request timeout, so the tab
  // aborted instead of reporting a state.
  const live = await withLiveQueryTimeout(
    (async (): Promise<LiveServiceContainer[] | null> => {
      // RUNTIME ONLY — see resolveServiceRuntimeForRead. Resolving the full
      // platform here dragged the OpenResty detect + Lua self-heal (and the
      // provision lock they run under) into every poll of this read endpoint,
      // which is what made status hang and then report "unknown".
      const runtime = await resolveServiceRuntimeForRead(project, dep);
      if (!runtime) return null;

      try {
        // Docker: ONE label-agnostic `docker ps -a` for the whole host, matched
        // by identity. One call — the dashboard polls this endpoint, and N
        // per-service `docker inspect` round-trips over SSH took ~17s.
        if (runtime.supports("hostContainerQuery") && runtime.listAllContainers) {
          const containers = await runtime.listAllContainers();
          const matches = resolveLiveServiceState({
            services: services.map((s) => ({ id: s.id, name: s.name })),
            live: containers,
            projectId,
            slug: project.slug,
            trackedIds,
          });
          return (
            services
              // A DISABLED service with no container is left OUT so the panel can
              // render "Disabled"; one that is somehow still running is reported
              // truthfully (a disabled-but-running service is worth seeing).
              .filter((svc) => svc.enabled !== false || matches.get(svc.id)?.containerId)
              .map((svc) => {
                const m = matches.get(svc.id);
                const hint = hints.get(svc.id);
                return {
                  serviceId: svc.id,
                  serviceName: svc.name,
                  containerId: m?.containerId ?? null,
                  status: m?.status ?? "stopped",
                  ip: m?.ip ?? null,
                  hostPort: m?.hostPort ?? hint?.hostPort ?? null,
                  imageRef: m?.image ?? hint?.imageRef ?? null,
                  matchedBy: m?.matchedBy ?? null,
                  duplicates: m?.duplicates ?? [],
                } satisfies LiveServiceContainer;
              })
          );
        }
        // Cloud (no host container list): per-workload lookup — bounded set,
        // Oblien API (not SSH), and it also refreshes the live private IP.
        if (runtime.supports("containerInfo")) {
          return Promise.all(
            services
              .filter((svc) => svc.enabled !== false)
              .map(async (svc) => {
                const hint = hints.get(svc.id);
                const base = {
                  serviceId: svc.id,
                  serviceName: svc.name,
                  containerId: hint?.containerId ?? null,
                  ip: hint?.ip ?? null,
                  hostPort: hint?.hostPort ?? null,
                  imageRef: hint?.imageRef ?? null,
                  matchedBy: null,
                  duplicates: [],
                };
                if (!hint?.containerId) return { ...base, status: "stopped" as ServiceContainerState };
                const info = await runtime.getContainerInfo(hint.containerId).catch(() => null);
                return {
                  ...base,
                  status: info ? containerStatusToServiceState(info.status) : "unknown",
                  ip: info?.ip ?? base.ip,
                  matchedBy: info ? ("trackedId" as LiveMatchKind) : null,
                } satisfies LiveServiceContainer;
              }),
          );
        }
        return null; // runtime can't report → unknown, never a stale DB status
      } finally {
        // Teardown must never extend the response: releasing the pooled SSH hold
        // is fire-and-forget (it still runs, we just don't wait on it).
        void Promise.resolve(runtime.dispose?.()).catch(() => {});
      }
    })().catch(() => null),
  );
  // Unreachable host / timeout / runtime without a query: say UNKNOWN. The old
  // fallback echoed the deploy-time status column, which is how a long-dead
  // service kept rendering "Running".
  return live ?? flat("unknown");
}

/**
 * Bound the live-status path so a slow/hung/unreachable runtime degrades to the
 * persisted status instead of hanging the (polled) containers endpoint.
 *
 * The budget covers SSH connect + the query together, so it has to be roomier
 * than the old query-only 6s while staying well under the dashboard's 15s
 * request timeout — a request that exceeds THAT is what turns a degradable read
 * into an aborted one.
 */
const LIVE_QUERY_BUDGET_MS = 10_000;

function withLiveQueryTimeout<T>(p: Promise<T>): Promise<T | null> {
  return Promise.race([
    p,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), LIVE_QUERY_BUDGET_MS)),
  ]);
}

// ─── Volume disk usage ───────────────────────────────────────────────────────

export interface ServiceVolumeSize {
  /** The compose volume string, verbatim — aligned by index to service.volumes. */
  raw: string;
  source: string;
  target: string | null;
  kind: VolumeKind;
  readOnly: boolean;
  /** On-disk size in bytes (apparent, `du -sb`). null = couldn't be measured
   *  (not mounted / permission / timeout / no running container for a stopped
   *  named volume). */
  bytes: number | null;
}

export interface ServiceVolumeSizes {
  /** False when there is no host to run `du` on (cloud/Oblien workload, or the
   *  service isn't deployed) — the UI then just shows the mounts without sizes. */
  measurable: boolean;
  volumes: ServiceVolumeSize[];
  /** Sum of the measured volumes, or null if none could be measured. */
  totalBytes: number | null;
  /** True when at least one volume couldn't be measured → totalBytes is a lower
   *  bound (render it with a "≥"). */
  partial: boolean;
}

const VOL_SIZE_CONCURRENCY = 4;
const VOL_SIZE_TTL_MS = 60_000;
// `du` on a large data volume is genuinely slow, and this endpoint is opened
// (not polled) from the Overview tab — cache the measurement briefly, keyed by
// the exact container, so re-opening the tab doesn't re-`du` every time.
const volSizeCache = new Map<string, { at: number; value: ServiceVolumeSizes }>();

/** Resolve a named volume's real on-host name (it may be namespaced at deploy
 *  time as `openship-<slug>-<name>`) and `du` its mountpoint. Only used as a
 *  fallback when the container isn't running to report authoritative mounts. */
async function namedVolumeBytesByName(
  exec: CommandExecutor,
  slug: string,
  name: string,
  namespaced: boolean,
): Promise<number | null> {
  const scoped = scopedVolumeName(slug, name);
  const candidates = namespaced ? [scoped, name] : [name, scoped];
  const seen = new Set<string>();
  for (const c of candidates) {
    if (!c || seen.has(c)) continue;
    seen.add(c);
    const b = await volumeBytes(exec, c);
    if (b != null) return b;
  }
  return null;
}

/**
 * Measure the on-disk size of each of a service's volumes.
 *
 * There is no cheap size in Docker's API, so we measure on the host that owns
 * the container: `docker inspect .Mounts` gives the authoritative host Source
 * for every mount (handling volume namespacing + anonymous volumes), then
 * `du -sb` sizes each path. When the container isn't running we fall back to
 * resolving a named volume by name. Every probe is bounded (see du/volumeBytes)
 * so a giant volume yields `bytes: null` (→ partial total) rather than hanging.
 *
 * Cloud workloads and not-yet-deployed services return `measurable: false`.
 */
export async function getServiceVolumeSizes(
  ctx: RequestContext,
  projectId: string,
  serviceId: string,
): Promise<ServiceVolumeSizes> {
  const { project, svc } = await assertServiceAccess(ctx, projectId, serviceId);
  const parsed = (svc.volumes ?? []).map((v) => parseVolumeSpec(v));

  const unmeasured = (measurable: boolean): ServiceVolumeSizes => ({
    measurable,
    volumes: parsed.map((p) => ({
      raw: p.raw,
      source: p.source,
      target: p.target,
      kind: p.kind,
      readOnly: p.readOnly,
      bytes: null,
    })),
    totalBytes: null,
    partial: parsed.length > 0,
  });

  if (parsed.length === 0) return { measurable: true, volumes: [], totalBytes: null, partial: false };
  if (!project.activeDeploymentId) return unmeasured(false);

  const dep = await repos.deployment.findById(project.activeDeploymentId);
  if (!dep) return unmeasured(false);

  // Resolve the host that runs this service's container → its shell executor.
  // The container id is resolved LIVE on the way past: a stale recorded id made
  // `docker inspect .Mounts` 404, which dropped every volume onto the slow
  // per-volume `du` fallback and timed this endpoint out.
  let serverId: string | null = null;
  let liveContainerId: string | null = null;
  try {
    const resolved = await resolveDeploymentRuntimeForRead({
      meta: dep.meta,
      organizationId: ctx.organizationId,
    });
    serverId = resolved.serverId;
    liveContainerId = await liveContainerIdWithRuntime(resolved.runtime, {
      service: { id: svc.id, name: svc.name },
      projectId,
      slug: project.slug,
      tracked: await containerIdForService(dep, { id: svc.id, name: svc.name }),
    });
    await resolved.runtime?.dispose?.();
  } catch {
    // fall through — try the instance's local host below
  }
  let executor: CommandExecutor;
  try {
    if (!serverId) {
      const local = await repos.server.findLocal(project.organizationId).catch(() => null);
      if (!local) return unmeasured(false); // cloud / no host to du on
      serverId = local.id;
    }
    ({ executor } = await resolveServerExecutor(serverId, project.organizationId));
  } catch {
    return unmeasured(false);
  }

  const containerId =
    liveContainerId ?? (await containerIdForService(dep, { id: svc.id, name: svc.name }));
  const cacheKey = `${projectId}:${serviceId}:${containerId ?? "none"}`;
  const hit = volSizeCache.get(cacheKey);
  if (hit && Date.now() - hit.at < VOL_SIZE_TTL_MS) return hit.value;

  // Authoritative host paths from the LIVE container mounts (Destination → Source).
  const mountsByDest = new Map<string, string>();
  if (containerId) {
    const out = await executor
      .exec(`docker inspect ${sq(containerId)} --format '{{json .Mounts}}' 2>/dev/null || echo`, {
        timeout: 10_000,
      })
      .catch(() => "");
    try {
      const arr = JSON.parse(out.trim() || "[]");
      if (Array.isArray(arr)) {
        for (const m of arr) {
          if (m && typeof m.Destination === "string" && typeof m.Source === "string") {
            mountsByDest.set(m.Destination, m.Source);
          }
        }
      }
    } catch {
      // non-JSON (container gone / docker error) → fall back per-volume below
    }
  }

  const volumes = await bounded(parsed, VOL_SIZE_CONCURRENCY, async (p): Promise<ServiceVolumeSize> => {
    const hostPath = p.target ? mountsByDest.get(p.target) : undefined;
    let bytes: number | null;
    if (hostPath) {
      bytes = await duBytes(executor, hostPath);
    } else if (p.kind === "bind" && p.source) {
      bytes = await duBytes(executor, p.source);
    } else if (p.kind === "named" && p.source) {
      bytes = await namedVolumeBytesByName(executor, project.slug, p.source, !!svc.namespaceVolumes);
    } else {
      bytes = null; // anonymous volume with no running container → unknown
    }
    return { raw: p.raw, source: p.source, target: p.target, kind: p.kind, readOnly: p.readOnly, bytes };
  });

  let totalBytes: number | null = null;
  let partial = false;
  for (const v of volumes) {
    if (v.bytes == null) partial = true;
    else totalBytes = (totalBytes ?? 0) + v.bytes;
  }

  const value: ServiceVolumeSizes = { measurable: true, volumes, totalBytes, partial };
  if (volSizeCache.size > 500) volSizeCache.clear();
  volSizeCache.set(cacheKey, { at: Date.now(), value });
  return value;
}

// ─── Per-service container actions ───────────────────────────────────────────

/**
 * The runtime + the container id for one service's actions (start/stop/restart/
 * logs/exec).
 *
 * The container id is resolved LIVE against the host, not read off the
 * `service_deployment` row: that row's id goes stale the moment a redeploy
 * replaces the container, and every action then failed with docker's
 * "(HTTP code 404) no such container". The row is still used as an identity hint
 * (it's the only key an adopted container with a foreign name has) — see
 * live-state.ts for the resolution order.
 */
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

  const svc = (await repos.service.listByProject(projectId)).find((s) => s.id === serviceId);
  if (!svc) throw new Error("Service not found");

  const rows = await repos.service.listByDeployment(dep.id);
  const row = rows.find((r) => r.serviceId === serviceId);

  // Runtime only: start/stop/restart/logs/terminal need `runtime` + the pooled
  // connection, never routing or the system manager — resolving a full platform
  // here charged every one of them the OpenResty detect + Lua self-heal (under the
  // provision lock), which is the other half of "the action takes forever".
  const { runtime, serverId } = await resolveDeploymentRuntimeForRead({
    meta: dep.meta,
    organizationId: ctx.organizationId,
  });

  // Live query answered → trust it. No match = the container is genuinely gone,
  // and saying so beats handing docker a dead id.
  const containerId = await liveContainerIdWithRuntime(runtime, {
    service: { id: svc.id, name: svc.name },
    projectId,
    slug: project.slug,
    tracked: row?.containerId ?? null,
  });
  // Heal the record so the DB-hint consumers (backups, restore) converge on the
  // same container instead of each rediscovering the drift.
  if (row && containerId && row.containerId !== containerId) {
    await repos.service.updateServiceDeployment(row.id, { containerId }).catch(() => {});
  }
  if (!containerId) {
    await runtime.dispose?.().catch(() => {});
    throw new Error("Service has no running container");
  }

  return { runtime, containerId, serverId, row, service: svc };
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
      // The project's own caps. Omitting this fell back to the cloud free tier
      // inside createServiceDeployConfig, so adding/starting a single service
      // always produced a 512 MB container no matter what the project was set to.
      resources: resolveRuntimeResources(project.resources as Record<string, unknown> | null, {
        isCloud: resolved.effectiveTarget === "cloud",
      }),
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
    const svc = result.services.find((s) => s.serviceId === serviceId);
    // THIS service's own outcome decides, not the batch's: strict scope carries
    // live siblings forward as successes, so an overall "ready" says nothing
    // about the one service we were asked to start (its container may have
    // crash-looped through the stabilization watch).
    if (result.status === "failed" || svc?.status === "failed") {
      // A source-built service has no image to launch on the decoupled path
      // (it only builds through the deploy pipeline) — steer to Redeploy.
      if (service.build && !service.image) {
        throw new Error(
          `"${service.name}" builds from source — use Redeploy to build and start it.`,
        );
      }
      throw new Error(svc?.error ?? result.error ?? "Failed to start service");
    }
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
  assertNotControlPlaneService(await repos.project.findById(projectId));
  // Existing container → just start it. No container yet → provision it on its
  // own (image → container/workspace), decoupled from the project deploy.
  const existing = await resolveServiceContainer(ctx, projectId, serviceId).catch(() => null);
  if (existing?.containerId) {
    try {
      await existing.runtime.start(existing.containerId);
      if (existing.row) {
        await repos.service
          .updateServiceDeployment(existing.row.id, { status: "success" })
          .catch(() => {});
      }
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
  assertNotControlPlaneService(await repos.project.findById(projectId));
  const { runtime, containerId, row } = await resolveServiceContainer(
    ctx,
    projectId,
    serviceId,
  );
  try {
    await runtime.stop(containerId);
    // Deploy-history bookkeeping only — the panel reads state from the host.
    if (row) {
      await repos.service.updateServiceDeployment(row.id, { status: "stopped" }).catch(() => {});
    }
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
  assertNotControlPlaneService(await repos.project.findById(projectId));
  const { runtime, containerId, row } = await resolveServiceContainer(
    ctx,
    projectId,
    serviceId,
  );
  try {
    await runtime.restart(containerId);
    if (row) {
      await repos.service.updateServiceDeployment(row.id, { status: "success" }).catch(() => {});
    }
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

