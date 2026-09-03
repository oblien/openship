import type { Terminal } from "@xterm/xterm";
import type { FrameworkId, EnvironmentVariable } from "@/components/import-project/types";
import type { PrepareComposeService, PrepareSingleAppCandidate } from "@/lib/api/deploy";
import { getBuildImage, STACKS, resolveWorkload, type WorkloadType, type ProjectType, type BuildStrategy, type DeployTarget, type RuntimeMode, type StackId, type RoutingConfig, type OpenshipReadiness, type ResourceTier as CoreResourceTier } from "@repo/core";
import type { BuildLog } from "@/utils/deploymentPhaseDetector";
import type { BuildSessionLoadResult } from "./load-session";
import { randomUUID } from "@/lib/random-uuid";

// ─── Monorepo sub-app ────────────────────────────────────────────────────────

/**
 * One deployable sub-app inside a monorepo. Mirrors the single-app form fields
 * (rootDirectory, install/build/start commands, port) plus per-app routing/env
 * scoping. Multiple of these live under one openship project, all sharing the
 * monorepoWorkspace install at the repo root.
 */
export interface MonorepoAppConfig {
  /** Stable identifier (defaults to rootDirectory). */
  id: string;
  /** Display name (last segment of rootDirectory, or package.json name). */
  name: string;
  /** Whether this sub-app is included in the next deploy. */
  enabled: boolean;
  framework: FrameworkId;
  detectedFramework: FrameworkId | null;
  packageManager: string;
  buildImage: string;
  rootDirectory: string;
  installCommand: string;
  buildCommand: string;
  startCommand: string;
  outputDirectory: string;
  productionPaths: string[];
  port: string;
  hasServer: boolean;
  hasBuild: boolean;
  envVars: EnvironmentVariable[];
  publicEndpoints: PublicEndpoint[];
}

export interface MonorepoWorkspaceConfig {
  packageManager: string;
  /**
   * Shell command run ONCE at the repo root before per-app builds.
   * Any prep work — install, codegen, schema sync — chained with `&&`.
   */
  prepareCommand: string;
}

const GENERIC_MULTI_BUILD_IMAGE = "ubuntu:22.04";
const NON_APP_SINGLE_FLOW_STACKS = new Set<FrameworkId>(["docker", "docker-compose", "unknown"]);
const NODE_BUILD_PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn"]);

// ─── Screenshots ─────────────────────────────────────────────────────────────

export interface Screenshot {
  url: string;
  variants: Array<{ variant: string; url: string }>;
  size: number;
  mime: string;
}

// ─── Compose service (matches API response) ─────────────────────────────────

/**
 * Compose-service shape as it travels through the dashboard's deployment
 * context. Aliased to PrepareComposeService (the API client's matching
 * type) so the two stay synchronized - same wire shape, one place to
 * change it. The dashboard's deployment context uses this name for
 * legacy reasons; new code should reach for PrepareComposeService.
 */
export type ComposeServiceInfo = PrepareComposeService;

/**
 * Loosely-typed compose service as it arrives from any saved source — a DB
 * `Service` row, a deployment snapshot's `composeServices`, or a prepare
 * result. All carry the same camelCase fields but with nullable columns.
 */
export type RawComposeService = {
  /** The persisted service row's id, when this came from saved rows rather than a
   *  fresh compose scan. Carried so an edit flow can reveal that service's stored
   *  env — the reveal endpoint is keyed by service id, and re-deriving it from the
   *  name later would be a second source of truth for the same fact. */
  id?: string | null;
  name: string;
  image?: string | null;
  build?: string | null;
  dockerfile?: string | null;
  buildArgs?: Record<string, string | null> | null;
  ports?: string[] | null;
  dependsOn?: string[] | null;
  environment?: Record<string, string> | null;
  volumes?: string[] | null;
  command?: string | null;
  restart?: string | null;
  advanced?: ComposeServiceInfo["advanced"] | null;
  exposed?: boolean | null;
  exposedPort?: string | null;
  domain?: string | null;
  customDomain?: string | null;
  domainType?: "free" | "custom" | null;
  publicEndpoints?: Array<{
    port?: number | string | null;
    domain?: string | null;
    customDomain?: string | null;
    domainType?: "free" | "custom" | null;
  }> | null;
};

/**
 * Normalize a raw compose service (DB row / snapshot / prepare) into the
 * ComposeServiceInfo shape the wizard renders — one place so the config-edit
 * and build-session hydration paths can't drift. Nullable columns collapse to
 * undefined / empty collections.
 */
/**
 * Re-attach persisted service ids to a freshly-hydrated compose list.
 *
 * A deployment SNAPSHOT carries the full compose config but no service-row ids (it is
 * also the path used when a deploy failed before its rows existed, where there are none
 * to carry). It overwrites `config.services` wholesale, so hydrating from a snapshot
 * after the rows had already loaded silently dropped the ids — and with them the env
 * editor's ability to reveal stored values.
 *
 * Matched on name because that is the only join the two sides share, and within ONE
 * project's compose file names are unique by construction — compose itself keys services
 * by name. An id already on the incoming row always wins; this only fills blanks.
 */
export function carryServiceIds(
  next: ComposeServiceInfo[],
  prev: ComposeServiceInfo[] | undefined,
): ComposeServiceInfo[] {
  if (!prev?.length) return next;
  const idByName = new Map<string, string>();
  for (const s of prev) if (s.serviceId) idByName.set(s.name, s.serviceId);
  if (idByName.size === 0) return next;
  return next.map((s) =>
    s.serviceId ? s : { ...s, serviceId: idByName.get(s.name) ?? undefined },
  );
}

export function normalizeComposeService(raw: RawComposeService): ComposeServiceInfo {
  return {
    serviceId: raw.id ?? undefined,
    name: raw.name,
    image: raw.image ?? undefined,
    build: raw.build ?? undefined,
    dockerfile: raw.dockerfile ?? undefined,
    buildArgs: raw.buildArgs ?? undefined,
    ports: raw.ports ?? [],
    dependsOn: raw.dependsOn ?? [],
    environment: raw.environment ?? {},
    volumes: raw.volumes ?? [],
    command: raw.command ?? undefined,
    restart: raw.restart ?? undefined,
    advanced: raw.advanced ?? undefined,
    exposed: raw.exposed ?? false,
    exposedPort: raw.exposedPort ?? undefined,
    domain: raw.domain ?? undefined,
    customDomain: raw.customDomain ?? undefined,
    domainType: raw.domainType ?? undefined,
    publicEndpoints:
      raw.publicEndpoints && raw.publicEndpoints.length > 0
        ? raw.publicEndpoints.map((endpoint) =>
            createPublicEndpoint({
              port: endpoint.port != null ? String(endpoint.port) : "",
              domain: endpoint.domain ?? "",
              customDomain: endpoint.customDomain ?? "",
              domainType: endpoint.domainType === "custom" ? "custom" : "free",
            }),
          )
        : undefined,
  };
}

export interface PublicEndpoint {
  id: string;
  port: string;
  targetPath: string;
  /** Preserve an imported nginx `location = <path>` route during migration. */
  exact?: boolean;
  domain: string;
  customDomain: string;
  domainType: "free" | "custom";
  /** Canonical redirect: answer a 30x to this hostname (another of the project's
   *  own) instead of serving the app here. Undefined = serves the app. */
  redirectTo?: string;
  /** 301 (default) | 302. Only meaningful alongside `redirectTo`. */
  redirectStatus?: number;
}

// ─── Per-service deployment status (live from SSE or loaded from DB) ─────────

export interface ServiceDeployStatus {
  serviceId: string;
  serviceName: string;
  status: "pending" | "building" | "built" | "deploying" | "running" | "failed";
  error?: string;
  containerId?: string;
  hostPort?: number;
  image?: string;
  build?: string;
}

/**
 * How many services are in each state, for the "0/5 running · 2 built · 1 building"
 * readout.
 *
 * Shared because that sentence is rendered TWICE on the compose deploy screen — the
 * logs-panel chip and the Deployment Details row, side by side in the same grid —
 * and each used to filter the same array itself against its own copy of the
 * strings. A status-set change (counting `deploying` as in-flight) or a wording
 * change applied to one made the two contradict each other about one stack, at the
 * same instant, with nothing able to catch it: both i18n keys existed in every
 * locale, so only their VALUES drifted.
 *
 * `status` is a single scalar and the SSE reducer upserts by `serviceId`, so these
 * counts are mutually exclusive and sum to at most the service count.
 *
 * `total` is deliberately NOT here: the two callers legitimately disagree — the
 * logs panel counts services that have produced log lines but aren't in the roster
 * yet (`Math.max(services.length, logServiceNames.length)`), the sidebar counts
 * only known services.
 */
export function composeServiceTally(services: readonly ServiceDeployStatus[]): {
  running: number;
  built: number;
  building: number;
  failed: number;
} {
  let running = 0;
  let built = 0;
  let building = 0;
  let failed = 0;
  for (const service of services) {
    if (service.status === "running") running += 1;
    else if (service.status === "built") built += 1;
    else if (service.status === "building") building += 1;
    else if (service.status === "failed") failed += 1;
  }
  return { running, built, building, failed };
}

// ─── Build Strategy ──────────────────────────────────────────────────────────

export type { BuildStrategy, RuntimeMode, DeployTarget } from "@repo/core";

/**
 * Where a server deploy clones the repo:
 *   - "api-host" (default) → clone on the orchestrator, transfer the context.
 *   - "server"             → clone directly on the build host (relay on desktop,
 *                            short-lived token otherwise). Build always runs on
 *                            the server regardless.
 */
export type CloneStrategy = "api-host" | "server";

// ─── Config ──────────────────────────────────────────────────────────────────

export interface DeploymentOptions {
  buildCommand: string;
  outputDirectory: string;
  productionPaths: string;
  installCommand: string;
  startCommand: string;
  productionPort: string;
  rootDirectory: string;
  hasServer: boolean;
  hasBuild: boolean;
  /**
   * The runtime workload axis (#538): `web` listens on a port and is routed,
   * `worker` runs a long-lived container with no port/route, `static` serves
   * files from the edge. Absent → derive from `hasServer` (never a worker), so
   * every legacy config classifies exactly as before. A worker shares
   * `hasServer=false` with a static site — only this field distinguishes them,
   * so readers that must tell them apart go through `workloadOf`.
   */
  workloadType?: WorkloadType;
}

/** Resolve an options block's runtime workload, sharing the canonical core
 *  resolver so a dashboard gate can never disagree with the backend. */
export function workloadOf(options: {
  workloadType?: WorkloadType | null;
  hasServer?: boolean | null;
}): WorkloadType {
  return resolveWorkload(options.workloadType, options.hasServer);
}

export interface DeploymentModeSnapshot {
  framework: FrameworkId;
  detectedFramework: FrameworkId | null;
  packageManager: string;
  buildImage: string;
  buildStrategy: BuildStrategy;
  runtimeMode: RuntimeMode;
  publicEndpoints: PublicEndpoint[];
  options: DeploymentOptions;
}

export interface DeploymentSingleModeSnapshot extends DeploymentModeSnapshot {
  sourceSignature: string | null;
}

export interface DeploymentModeSnapshots {
  services?: DeploymentModeSnapshot;
  single?: DeploymentSingleModeSnapshot;
}

/**
 * Resource tier IDs for Openship Cloud deploys — DERIVED from the one tier union
 * in @repo/core, which the backend provisioner reads too. `unlimited` is excluded
 * because a metered cloud workspace must be provisioned at a concrete size.
 * The picker's display specs come from the same core table (see
 * `CLOUD_RESOURCE_TIERS` in `DeployTargetStep.tsx`).
 */
export type CloudResourceTier = Exclude<CoreResourceTier, "unlimited">;

/**
 * User-supplied resource values when `cloudResourceTier === "custom"`.
 * Stored in the same shape the backend's ResourceConfig uses (cores +
 * megabytes) so the handoff is a direct copy with no unit conversion.
 */
export interface CloudResourceCustom {
  /** Fractional vCPU cores (e.g. 0.25, 0.5, 1, 2). */
  cpuCores: number;
  /** RAM in megabytes. */
  memoryMb: number;
  /** Disk in megabytes. */
  diskMb: number;
}

export interface DeploymentConfig {
  /** Existing deployable environment to update/deploy, when launched from a project page. */
  projectId?: string;
  /** One-click catalog app (repo-less services project). Deploys from its saved
   *  rows with no git source — treated like local/upload in the deploy guards. */
  isApp?: boolean;
  /** Catalog template id (e.g. "n8n", "convex") — drives the schema-based app
   *  settings step in the wizard for apps with `management:"schema"`. */
  appTemplateId?: string;
  projectName: string;
  repo: string;
  owner: string;
  /** Absolute path for local projects (mutually exclusive with owner/repo git source) */
  localPath?: string;
  /**
   * Explicit compose file location, for repos that keep it outside the detected
   * root (e.g. `deploy/docker-compose/docker-compose.yml`). Set via
   * `rescanWithComposePath` — it can't be edited locally like other fields
   * because the whole service list is derived from that file — and persisted so
   * redeploys re-read the same path.
   */
  composePath?: string;
  /** Folder-upload deploy: the upload session whose workspace/staging dir holds
   *  the source. Sent to buildAccess so the build adopts that uploaded source. */
  uploadSessionId?: string;
  /** Where the build runs: "server" (default, build in cloud/workspace) or "local" (build on host machine) */
  buildStrategy: BuildStrategy;
  /** Where the app deploys to: "local" (this machine), "server" (remote SSH), or "cloud" (Oblien) */
  deployTarget: DeployTarget;
  /**
   * Rollback retention, chosen in the wizard's target panel. Only used for a
   * project that doesn't exist yet — once it does, the panel edits the project
   * row directly (there's no reason to stage a change we can persist now).
   * `rollbackWindow: null` = size it from the target's free disk.
   */
  rollbackWindow?: number | null;
  rollbackStrategy?: "git" | "snapshot";
  /** Which server to deploy to when deployTarget === "server" */
  serverId?: string;
  /**
   * "None" routing: deploy with NO public URL (internal / port-only). When true
   * the deploy sends `publicEndpoints: []` regardless of what's staged, and the
   * domain picker collapses. Backend treats [] as no route (preflight warns, no
   * Cloud gate). Free/Custom are expressed via each endpoint's domainType.
   */
  noPublicRoute?: boolean;
  /** Display name of the target server (resolved by the API for the detail UI). */
  serverName?: string;
  /** Runtime mode: "bare" (direct process) or "docker" (container-based) */
  runtimeMode: RuntimeMode;
  projectType: ProjectType;
  framework: FrameworkId;
  detectedFramework: FrameworkId | null;
  packageManager: string;
  buildImage: string;
  publicEndpoints: PublicEndpoint[];
  envVars: EnvironmentVariable[];
  /** Snapshot used to diff project env edits without ever re-sending masked secrets. */
  persistedEnvVars: Array<{
    id: string;
    key: string;
    value: string;
    isSecret: boolean;
  }>;
  /** Root .env values detected during prepare; user must import before they apply. */
  rootEnvVars: EnvironmentVariable[];
  branch: string;
  branches: string[];
  services: ComposeServiceInfo[];
  /**
   * Compose/import projects can either deploy each parsed service, or ignore the
   * service fan-out for this deployment and use the normal single-app pipeline.
   */
  serviceDeploymentMode: "services" | "single";
  singleAppCandidate?: PrepareSingleAppCandidate;
  composeDefaults?: {
    framework: FrameworkId;
    packageManager: string;
    buildImage: string;
    options: DeploymentOptions;
  };
  modeSnapshots?: DeploymentModeSnapshots;
  /** Sub-apps discovered inside a monorepo. Only populated when projectType === "monorepo". */
  monorepoApps?: MonorepoAppConfig[];
  /** Shared workspace metadata (package manager + root install) for monorepo deploys. */
  monorepoWorkspace?: MonorepoWorkspaceConfig;
  /** Routing config parsed from the repo's vercel.json; carried from prepare to
   *  project create so the backend persists + compiles it. Opaque passthrough. */
  routingConfig?: RoutingConfig | null;
  /**
   * Deploy-time readiness gate, set in the wizard's collapsed Health section and
   * seeded by the repo's `openship.json`. Undefined/null = OFF, which is the
   * default: the deploy reports ready as soon as the workload is up and routed,
   * and nothing post-start can delay or veto it.
   */
  readiness?: OpenshipReadiness | null;
  /**
   * What the scan's openship.json parse refused (#641). NOT a user setting — it's
   * a fresh observation of the repo, so it is never hydrated from the saved
   * project and never sent back on save.
   */
  configDiagnostics?: { errors: string[]; warnings: string[]; wholeFile?: true };
  /**
   * Resource tier picked for Openship Cloud deploys. Self-hosted servers
   * inherit the host's capacity, so this field is meaningless for them
   * — kept on the config (not nested under cloud) because operators
   * sometimes preview the cost before picking the target. The backend
   * is responsible for translating the tier into a real ResourceConfig
   * (cpuCores/memoryMb/diskMb) and the corresponding billing line. See
   * `CLOUD_RESOURCE_TIERS` in the deploy-target step for placeholder
   * values; real numbers come from the pricing service later.
   */
  cloudResourceTier?: CloudResourceTier;
  /** Custom CPU/RAM/disk values, used only when cloudResourceTier === "custom". */
  cloudResourceCustom?: CloudResourceCustom;
  /**
   * Where a server deploy clones the repo (default "api-host"). "server" makes
   * the build host clone directly — desktop via the credential relay, a
   * server-hosted instance via a short-lived token. The build always runs on
   * the server; only the clone location differs. See {@link CloneStrategy}.
   */
  cloneStrategy?: CloneStrategy;
  /** Local-only flag so env imports don't overwrite a user-edited runtime port. */
  productionPortTouched: boolean;
  /** Last runtime port auto-applied from env detection in this deploy flow. */
  lastAutoDetectedEnvPort: string | null;
  options: DeploymentOptions;
}

export const DEFAULT_CONFIG: DeploymentConfig = {
  projectId: undefined,
  projectName: "",
  repo: "",
  owner: "",
  localPath: undefined,
  composePath: undefined,
  uploadSessionId: undefined,
  buildStrategy: "server",
  deployTarget: "cloud",
  runtimeMode: "docker",
  projectType: "app",
  framework: "nextjs",
  detectedFramework: null,
  packageManager: "npm",
  buildImage: "node:22",
  publicEndpoints: [],
  noPublicRoute: false,
  branch: "main",
  branches: [],
  services: [],
  serviceDeploymentMode: "single",
  cloudResourceTier: "low",
  productionPortTouched: false,
  lastAutoDetectedEnvPort: null,
  options: {
    buildCommand: "",
    outputDirectory: "",
    productionPaths: "",
    installCommand: "",
    startCommand: "",
    productionPort: "",
    rootDirectory: "./",
    hasServer: true,
    hasBuild: true,
    workloadType: "web",
  },
  envVars: [],
  persistedEnvVars: [],
  rootEnvVars: [],
};

function isSingleFlowAppStack(framework: string | undefined): framework is StackId {
  return Boolean(
    framework &&
    framework in STACKS &&
    !NON_APP_SINGLE_FLOW_STACKS.has(framework as FrameworkId),
  );
}

export function getRecommendedSingleAppBuildImage(
  config: Pick<DeploymentConfig, "framework" | "packageManager" | "buildImage">,
): string {
  if (isSingleFlowAppStack(config.framework)) {
    return getBuildImage(config.framework, config.packageManager);
  }

  if (config.packageManager === "bun") {
    return "oven/bun:latest";
  }

  if (NODE_BUILD_PACKAGE_MANAGERS.has(config.packageManager)) {
    return "node:22";
  }

  if (config.buildImage && config.buildImage !== GENERIC_MULTI_BUILD_IMAGE) {
    return config.buildImage;
  }

  return "node:22";
}

export function resolveBuildImageForDeploymentMode(
  config: Pick<DeploymentConfig, "projectType" | "serviceDeploymentMode" | "framework" | "packageManager" | "buildImage">,
  nextMode: DeploymentConfig["serviceDeploymentMode"] = config.serviceDeploymentMode,
): string {
  if (config.projectType !== "services") {
    return config.buildImage || getRecommendedSingleAppBuildImage(config);
  }

  const serviceStackImage = isSingleFlowAppStack(config.framework)
    ? getBuildImage(config.framework, config.packageManager)
    : GENERIC_MULTI_BUILD_IMAGE;
  const singleAppImage = getRecommendedSingleAppBuildImage(config);

  if (nextMode === "services") {
    if (!config.buildImage || config.buildImage === singleAppImage) {
      return serviceStackImage;
    }

    return config.buildImage;
  }

  if (
    !config.buildImage ||
    config.buildImage === GENERIC_MULTI_BUILD_IMAGE ||
    config.buildImage === serviceStackImage
  ) {
    return singleAppImage;
  }

  return config.buildImage;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// The needs-cloud predicate (managed/free domain ⇒ needs cloud) is defined ONCE
// in @repo/core and re-exported here under the historical names, so existing
// importers are unchanged and client + server share one definition.
export { servicesNeedCloud, endpointsNeedCloud as publicEndpointsNeedCloud } from "@repo/core";

export function createPublicEndpoint(
  overrides: Partial<PublicEndpoint> = {},
): PublicEndpoint {
  return {
    id: overrides.id ?? randomUUID(),
    port: overrides.port ?? "",
    targetPath: overrides.targetPath ?? "",
    ...(overrides.exact ? { exact: true } : {}),
    domain: overrides.domain ?? "",
    customDomain: overrides.customDomain ?? "",
    domainType: overrides.domainType ?? "free",
    ...(overrides.redirectTo ? { redirectTo: overrides.redirectTo } : {}),
    ...(overrides.redirectStatus ? { redirectStatus: overrides.redirectStatus } : {}),
  };
}

export function ensurePublicEndpoints(
  endpoints: PublicEndpoint[] | undefined,
  fallback?: {
    port?: string;
    targetPath?: string;
    domain?: string;
    customDomain?: string;
    domainType?: "free" | "custom";
  },
): PublicEndpoint[] {
  if (endpoints && endpoints.length > 0) {
    return endpoints;
  }

  return [
    createPublicEndpoint({
      port: fallback?.port ?? "",
      targetPath: fallback?.targetPath ?? "",
      domain: fallback?.domain ?? "",
      customDomain: fallback?.customDomain ?? "",
      domainType: fallback?.domainType ?? "free",
    }),
  ];
}

function normalizePublicEndpointForMode(
  endpoint: PublicEndpoint,
  opts: { hasServer: boolean; runtimePort: string; isPrimary: boolean },
): PublicEndpoint {
  if (opts.hasServer) {
    return createPublicEndpoint({
      ...endpoint,
      port: opts.isPrimary
        ? (opts.runtimePort || endpoint.port || "")
        : (endpoint.port || opts.runtimePort || ""),
      targetPath: "",
    });
  }

  return createPublicEndpoint({
    ...endpoint,
    port: "",
    targetPath: endpoint.targetPath || "/",
  });
}

export function syncPublicEndpointState(
  config: DeploymentConfig,
): DeploymentConfig {
  const workload = workloadOf(config.options);

  // A worker (#538) binds no port and is never routed — it has no public
  // endpoints at all. Clear them so the wizard neither shows nor submits a
  // bogus static "/" route (a worker shares hasServer=false with a static site).
  if (workload === "worker") {
    return {
      ...config,
      publicEndpoints: [],
      options: { ...config.options, productionPort: "" },
    };
  }

  const isWeb = workload === "web";
  const linkedRuntimePort = isWeb
    ? (
        config.options.productionPort ||
        config.publicEndpoints[0]?.port ||
        ""
      )
    : config.options.productionPort;
  const endpoints = ensurePublicEndpoints(
    config.publicEndpoints,
    isWeb
      ? {
          port: linkedRuntimePort,
        }
      : {
          targetPath: "/",
        },
  ).map((endpoint, index) => normalizePublicEndpointForMode(endpoint, {
    hasServer: isWeb,
    runtimePort: linkedRuntimePort,
    isPrimary: index === 0,
  }));
  const primary = endpoints[0];

  return {
    ...config,
    publicEndpoints: endpoints,
    options: {
      ...config.options,
      productionPort: isWeb
        ? (linkedRuntimePort || primary?.port || "")
        : config.options.productionPort,
    },
  };
}

export function usesServiceDeployment(
  config: Pick<DeploymentConfig, "projectType" | "serviceDeploymentMode">,
): boolean {
  return config.projectType === "services" && config.serviceDeploymentMode === "services";
}

/**
 * The hostnames a deploy screen may PRINT for a config, in endpoint order.
 *
 * Only hosts the config actually names: a custom domain the operator typed, or
 * `<chosen label>.<baseDomain>`. Empty when the config names none — the caller
 * then hides the row / disables the link rather than showing a guess.
 *
 * It used to synthesize a missing endpoint from a `fallbackDomain` seeded with
 * `config.projectName` — the RAW project name, not a slug — so "My App" became
 * a `My App.opsh.io` Domain row AND the target of the primary "Visit Site"
 * button on the deploy-success screen. That host never existed: the deploy mints
 * its free route from the project's SLUG, so even the slug-shaped cases pointed
 * somewhere else. Nothing may name a host this function can't derive from the
 * config's own endpoints.
 */
export function getPublicEndpointHosts(
  endpoints: PublicEndpoint[] | undefined,
  baseDomain: string,
): string[] {
  return (endpoints ?? [])
    .map((endpoint) => {
      if (endpoint.domainType === "custom") return endpoint.customDomain?.trim() ?? "";
      const label = endpoint.domain?.trim();
      return label && baseDomain ? `${label}.${baseDomain}` : "";
    })
    .filter((hostname, index, hostnames) => Boolean(hostname) && hostnames.indexOf(hostname) === index);
}



// ─── State ───────────────────────────────────────────────────────────────────

/** One exposed port's advisory probe result (mirrors the API `PortCheckResult`). */
export interface PortCheckUI {
  port: number;
  listening: boolean;
  checked: boolean;
  serviceId?: string;
  serviceName?: string;
  skippedReason?: string;
}

/** One routed path's advisory static-output result (mirrors `OutputCheckResult`). */
export interface OutputCheckUI {
  path: string;
  servedPath?: string;
  found: boolean;
  hasIndex: boolean;
  checked: boolean;
  /** Status the edge answered for a real request to this route. Absent = no HTTP
   *  signal — pre-fix records have none. */
  status?: number;
  /** The edge answered and it was not a failure. ABSENT = no signal: test
   *  `served === false`, never `!served`, or every older record reads as broken. */
  served?: boolean;
  skippedReason?: string;
}

export interface DeploymentState {
  deploymentId: string | null;
  isDeploying: boolean;
  isStopping: boolean;
  deploymentSuccess: boolean;
  deploymentFailed: boolean;
  deploymentCanceled: boolean;
  /** A cancelled row whose worker lease has not acknowledged completion yet. */
  cancellationPending: boolean;
  failureMessage: string;
  warningMessage: string;
  /**
   * A partial-failure deploy is held for an explicit keep/reject decision.
   * Server-backed (from getBuildStatus.decisionPending) so the "Action
   * Required" banner + modal reappear after a refresh, until the user acts.
   */
  decisionPending: boolean;
  /**
   * Service IDs that failed in a held partial-failure deploy — the AUTHORITATIVE
   * list from the server decision (getBuildStatus.partial.failed), so "Retry
   * failed" works after a refresh even once the live build session (and its
   * transient `serviceStatuses`) is gone.
   */
  decisionFailedServiceIds: string[];
  /**
   * Advisory post-deploy port-probe results. Server-backed (getBuildStatus
   * .portCheck + the SSE `complete` event); the dashboard raises a skippable
   * "wrong port?" modal for any entry that is `checked && !listening`.
   */
  portCheck: PortCheckUI[];
  /** Ports (single-app) / service ids (compose) the user dismissed. */
  portCheckSkipped: (number | string)[];
  errorCode: string;
  errorDetails: Record<string, unknown> | null;
  buildLogs: BuildLog[];
  currentProgress: number;
  currentStepIndex: number;
  screenshots: Screenshot[];
  projectId: string | null;
  /** Final build duration in ms (set when build finishes). */
  buildDurationMs: number | null;
  /** ISO timestamp when the build started (for elapsed timer). */
  buildStartedAt: string | null;
  /** Accumulated elapsed ms carried from previous failed/cancelled retries. */
  buildRetryCarryMs: number;
  /** Active pipeline prompt waiting for user response. */
  pendingPrompt: {
    promptId: string;
    title: string;
    message: string;
    actions: Array<{ id: string; label: string; variant?: string }>;
    details?: Record<string, unknown>;
  } | null;
  /** Per-service deployment statuses for compose projects. */
  serviceStatuses: ServiceDeployStatus[];
  /**
   * Per-phase build durations in ms, keyed by phase id (prepare/clone/install/
   * build/deploy). Seeded from the API on load; filled live as phases complete.
   * "prepare" is the one-time server provisioning, excluded from build time.
   */
  phaseDurations: Record<string, number>;
}

/** Ordered build phases for the Build-phases panel. `prepare` is one-time. */
export const BUILD_PHASES: ReadonlyArray<{ id: string; label: string; oneTime?: boolean }> = [
  { id: "prepare", label: "Prepare server", oneTime: true },
  { id: "clone", label: "Clone" },
  { id: "install", label: "Install" },
  { id: "build", label: "Build" },
  { id: "deploy", label: "Deploy" },
];

export const INITIAL_STATE: DeploymentState = {
  deploymentId: null,
  isDeploying: false,
  isStopping: false,
  deploymentSuccess: false,
  deploymentFailed: false,
  deploymentCanceled: false,
  cancellationPending: false,
  failureMessage: "",
  warningMessage: "",
  decisionPending: false,
  decisionFailedServiceIds: [],
  portCheck: [],
  portCheckSkipped: [],
  errorCode: "",
  errorDetails: null,
  buildLogs: [],
  currentProgress: 0,
  currentStepIndex: 0,
  screenshots: [],
  projectId: null,
  buildDurationMs: null,
  buildStartedAt: null,
  buildRetryCarryMs: 0,
  pendingPrompt: null,
  serviceStatuses: [],
  phaseDurations: {},
};

export function resolveBuildElapsedMs(
  state: Pick<DeploymentState, "buildDurationMs" | "buildStartedAt" | "buildRetryCarryMs">,
  now = Date.now(),
): number {
  const carry = state.buildRetryCarryMs || 0;

  if (typeof state.buildDurationMs === "number") {
    return Math.max(0, carry + state.buildDurationMs);
  }

  if (state.buildStartedAt) {
    const startedAtMs = new Date(state.buildStartedAt).getTime();
    if (Number.isFinite(startedAtMs)) {
      return Math.max(0, carry + (now - startedAtMs));
    }
  }

  return Math.max(0, carry);
}

// ─── Status ──────────────────────────────────────────────────────────────────

export type DeploymentStatus = "building" | "deploying" | "ready" | "failed" | "cancelled";

// ─── Context type ────────────────────────────────────────────────────────────

export interface DeploymentContextType {
  // Single source of truth
  config: DeploymentConfig;
  state: DeploymentState;
  terminalRef: React.MutableRefObject<Terminal | null>;
  canStreamContainer: React.MutableRefObject<boolean>;

  // Config updates
  updateConfig: (updates: Partial<DeploymentConfig>) => void;
  updateOptions: (updates: Partial<DeploymentConfig["options"]>) => void;

  // Prepare (resolve project info)
  initializeFromRepo: (
    owner: string,
    repo: string,
    force?: string,
    context?: { branch?: string; projectId?: string; composePath?: string },
  ) => Promise<{ success: boolean; error?: string; errorType?: string; buildInProgress?: boolean }>;
  initializeFromLocal: (
    path: string,
    context?: { projectId?: string; composePath?: string },
  ) => Promise<{ success: boolean; error?: string; errorType?: string }>;
  /**
   * Re-run detection pinned to an explicit compose file path (or clear it with
   * ""), then reload the config from that scan. This is what turns a repo the
   * detector read as a single app into the compose project the user knows it is —
   * the compose file sits in a subfolder the heuristics don't promote.
   *
   * Unlike the other config fields this one CANNOT be applied locally: the
   * service list, env, and project type all come from the compose file, so the
   * repo has to be re-read. Hence an explicit action rather than a plain input.
   */
  rescanWithComposePath: (
    composePath: string,
  ) => Promise<{ success: boolean; error?: string; errorType?: string }>;
  /** Folder-upload hydration — seed from the user-picked stack's defaults
   *  (no auto-detection); falls back to the session scan when no stack given. */
  initializeFromUpload: (
    sessionId: string,
    context?: { projectId?: string; stack?: string; packageManager?: string; name?: string },
  ) => Promise<{ success: boolean; error?: string; errorType?: string }>;
  /** Config-edit hydration from SAVED project data — no repo re-detection. */
  initializeFromProject: (
    projectId: string,
    context?: { branch?: string },
  ) => Promise<{ success: boolean; error?: string; errorType?: string }>;

  // Build lifecycle
  startDeployment: (overrides?: { runtimeMode?: RuntimeMode; buildStrategy?: BuildStrategy; saveConfigOnly?: boolean }) => Promise<string | null>;
  connectToBuild: (deploymentId?: string, startBuild?: boolean) => Promise<void>;
  loadBuildSession: (deploymentId: string) => Promise<BuildSessionLoadResult>;
  stopDeployment: () => Promise<void>;
  redeploy: (deploymentId: string) => Promise<string | null>;
  respondToPrompt: (action: string) => Promise<void>;
  /** Open the shared clone-credential modal for a github-credential error code
   *  (single handler for the deploy wizard, redeploy, and the build page).
   *  Returns true when it opened; false when the code isn't credential-related. */
  maybeOpenCredentialModal: (
    errorCode: string | null | undefined,
    opts?: { trigger?: "preflight-fail" | "build-fail"; onResolved?: () => void },
  ) => boolean;
  reset: () => void;

  // Terminal
  onTerminalReady: () => void;

  // Internal
  _setContainerFailed: (message: string) => void;
  steps: { label: string; icon: string }[];
  deploymentStatus: DeploymentStatus;
}
