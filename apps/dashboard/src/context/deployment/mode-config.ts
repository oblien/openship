import type { FrameworkId } from "@/components/import-project/types";
import { normalizeSubdomain } from "@/utils/subdomain";
import { serviceExposedPort } from "@/utils/compose-ports";
import {
  createPublicEndpoint,
  resolveBuildImageForDeploymentMode,
  type ComposeServiceInfo,
  type DeploymentConfig,
  type DeploymentModeSnapshot,
  type DeploymentSingleModeSnapshot,
  type PublicEndpoint,
} from "./types";

/**
 * Normalized shape of "the one app that gets promoted to single mode".
 *
 * Both compose (via `config.singleAppCandidate`) and monorepo (via the
 * primary sub-app picked from `config.monorepoApps`) reduce to this
 * type before the shared snapshot construction runs. Lets us keep ONE
 * snapshot builder instead of mirroring it per source shape.
 */
interface SingleAppPrimary {
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
  hasServer: boolean;
  hasBuild: boolean;
}

/**
 * Shared snapshot construction. Takes a normalized primary app + the
 * endpoint list + the productionPort and assembles the snapshot. Same
 * output shape regardless of whether the source was compose services
 * or monorepo sub-apps.
 *
 * Single sink for the 25-line snapshot-object literal that used to be
 * mirrored across two source-specific wrappers.
 */
function buildSingleModeSnapshotFromPrimary(args: {
  config: DeploymentConfig;
  defaults?: Pick<DeploymentModeSnapshot, "buildStrategy" | "runtimeMode">;
  primary: SingleAppPrimary;
  endpoints: PublicEndpoint[];
  productionPort: string;
  sourceSignature: string;
}): DeploymentSingleModeSnapshot {
  const { config, defaults, primary, endpoints, productionPort, sourceSignature } = args;
  const existingSnapshot = config.modeSnapshots?.single;
  const buildStrategy = existingSnapshot?.buildStrategy ?? defaults?.buildStrategy ?? config.buildStrategy;
  const runtimeMode = existingSnapshot?.runtimeMode ?? defaults?.runtimeMode ?? "docker";

  return {
    framework: primary.framework,
    detectedFramework: primary.detectedFramework,
    packageManager: primary.packageManager,
    buildImage: primary.buildImage,
    buildStrategy,
    runtimeMode,
    publicEndpoints: clonePublicEndpoints(endpoints),
    options: {
      ...config.options,
      buildCommand: primary.buildCommand,
      installCommand: primary.installCommand,
      outputDirectory: primary.outputDirectory,
      productionPaths: primary.productionPaths.join(", "),
      startCommand: primary.startCommand,
      productionPort,
      rootDirectory: primary.rootDirectory,
      hasServer: primary.hasServer,
      hasBuild: primary.hasBuild,
    },
    sourceSignature,
  };
}

const PRIMARY_SINGLE_APP_SERVICE_NAMES = new Set(["web", "app", "frontend"]);

function clonePublicEndpoints(endpoints: PublicEndpoint[]): PublicEndpoint[] {
  return endpoints.map((endpoint) => createPublicEndpoint(endpoint));
}

function captureModeSnapshot(
  config: Pick<
    DeploymentConfig,
    | "framework"
    | "detectedFramework"
    | "packageManager"
    | "buildImage"
    | "buildStrategy"
    | "runtimeMode"
    | "publicEndpoints"
    | "options"
  >,
  extras?: { sourceSignature?: string | null },
): DeploymentModeSnapshot | DeploymentSingleModeSnapshot {
  const snapshot: DeploymentModeSnapshot = {
    framework: config.framework,
    detectedFramework: config.detectedFramework,
    packageManager: config.packageManager,
    buildImage: config.buildImage,
    buildStrategy: config.buildStrategy,
    runtimeMode: config.runtimeMode,
    publicEndpoints: clonePublicEndpoints(config.publicEndpoints),
    options: { ...config.options },
  };

  if (!extras || !("sourceSignature" in extras)) {
    return snapshot;
  }

  return {
    ...snapshot,
    sourceSignature: extras.sourceSignature ?? null,
  };
}

function restoreModeSnapshot(
  snapshot: DeploymentModeSnapshot | DeploymentSingleModeSnapshot,
): Partial<DeploymentConfig> {
  return {
    framework: snapshot.framework,
    detectedFramework: snapshot.detectedFramework,
    packageManager: snapshot.packageManager,
    buildImage: snapshot.buildImage,
    buildStrategy: snapshot.buildStrategy,
    runtimeMode: snapshot.runtimeMode,
    publicEndpoints: clonePublicEndpoints(snapshot.publicEndpoints),
    options: { ...snapshot.options },
  };
}

function resolveComposeServiceSingleAppDomain(
  service: ComposeServiceInfo,
  projectName: string,
): string {
  if (service.domain) {
    return service.domain;
  }

  return PRIMARY_SINGLE_APP_SERVICE_NAMES.has(service.name)
    ? normalizeSubdomain(projectName)
    : normalizeSubdomain(`${projectName}-${service.name}`);
}

function listSingleAppComposeEndpointCandidates(config: DeploymentConfig) {
  const projectName = config.projectName || config.repo || "project";

  return config.services
    .map((service, index) => {
      if (!service.exposed) return null;

      const port = service.exposedPort || serviceExposedPort(service) || "";
      if (!port) return null;

      return {
        sourceIndex: index,
        service,
        endpoint: createPublicEndpoint({
          port,
          domainType: service.domainType || "free",
          domain:
            service.domainType === "custom"
              ? ""
              : resolveComposeServiceSingleAppDomain(service, projectName),
          customDomain: service.domainType === "custom" ? service.customDomain || "" : "",
        }),
      };
    })
    .filter((entry): entry is {
      sourceIndex: number;
      service: ComposeServiceInfo;
      endpoint: PublicEndpoint;
    } => entry !== null)
    .sort((left, right) => {
      const leftPriority = PRIMARY_SINGLE_APP_SERVICE_NAMES.has(left.service.name) ? 0 : left.service.exposed ? 1 : 2;
      const rightPriority = PRIMARY_SINGLE_APP_SERVICE_NAMES.has(right.service.name) ? 0 : right.service.exposed ? 1 : 2;
      return leftPriority - rightPriority || left.sourceIndex - right.sourceIndex;
    });
}

export function getComposeSingleAppSourceSignature(
  config: Pick<DeploymentConfig, "projectName" | "repo" | "services">,
): string {
  return JSON.stringify({
    projectName: config.projectName || config.repo || "project",
    services: config.services.map((service) => ({
      name: service.name,
      ports: service.ports,
      exposed: Boolean(service.exposed),
      exposedPort: service.exposedPort || "",
      domain: service.domain || "",
      customDomain: service.customDomain || "",
      domainType: service.domainType || "free",
    })),
  });
}

export function deriveSingleAppEndpointsFromCompose(
  config: DeploymentConfig,
): { publicEndpoints: PublicEndpoint[]; productionPort: string } | null {
  const composeEndpoints = listSingleAppComposeEndpointCandidates(config);

  if (composeEndpoints.length === 0) {
    return null;
  }

  const currentPort = config.options.productionPort.trim();
  const primaryCandidate = composeEndpoints.find(({ endpoint }) => endpoint.port === currentPort) ?? composeEndpoints[0];
  const primaryPort = primaryCandidate.endpoint.port;
  const [currentPrimary, ...currentAdditional] = config.publicEndpoints;

  const primaryEndpoint = createPublicEndpoint({
    ...primaryCandidate.endpoint,
    id: currentPrimary?.id,
    port: primaryPort,
  });

  const matchedCurrent = new Set<number>();
  const additionalEndpoints = composeEndpoints
    .filter(({ sourceIndex }) => sourceIndex !== primaryCandidate.sourceIndex)
    .map(({ endpoint }) => {
      const existingIndex = currentAdditional.findIndex((candidate, index) => {
        if (matchedCurrent.has(index)) return false;

        return candidate.port === endpoint.port || (
          candidate.domainType === endpoint.domainType &&
          candidate.domain === endpoint.domain &&
          candidate.customDomain === endpoint.customDomain
        );
      });

      if (existingIndex === -1) {
        return endpoint;
      }

      matchedCurrent.add(existingIndex);
      const existing = currentAdditional[existingIndex];
      return createPublicEndpoint({
        ...endpoint,
        id: existing.id,
        port: endpoint.port,
      });
    });

  return {
    publicEndpoints: [primaryEndpoint, ...additionalEndpoints],
    productionPort: primaryPort,
  };
}

export function deriveStaticSingleAppEndpointFromCompose(
  config: DeploymentConfig,
): PublicEndpoint[] {
  const composeEndpoints = listSingleAppComposeEndpointCandidates(config);
  const currentPrimary = config.publicEndpoints[0];
  const primaryCandidate = composeEndpoints[0];
  const candidateEndpoint = primaryCandidate?.endpoint;
  const domainType = candidateEndpoint?.domainType ?? currentPrimary?.domainType ?? "free";

  return [createPublicEndpoint({
    id: currentPrimary?.id,
    port: "",
    targetPath: "/",
    domainType,
    domain: domainType === "custom"
      ? ""
      : candidateEndpoint?.domain || currentPrimary?.domain || normalizeSubdomain(config.projectName || config.repo || "project"),
    customDomain: domainType === "custom"
      ? candidateEndpoint?.customDomain || currentPrimary?.customDomain || ""
      : "",
  })];
}

/**
 * Pick "the app that becomes the single-mode primary" from a compose
 * project. Returns the primary's profile + the endpoint list + the
 * primary production port, or null when no candidate can be derived.
 *
 * Compose has two paths:
 *   - Prepare-time hint (`singleAppCandidate`) - used as-is when present.
 *   - Fallback: take the project-level options (the operator already
 *     filled in install/build/start) and treat exposed services as
 *     endpoints.
 */
function pickComposePrimary(
  config: DeploymentConfig,
): {
  primary: SingleAppPrimary;
  endpoints: PublicEndpoint[];
  productionPort: string;
} | null {
  const candidate = config.singleAppCandidate;
  const singleAppEndpoints = deriveSingleAppEndpointsFromCompose(config);

  if (candidate) {
    const primary: SingleAppPrimary = {
      framework: candidate.stack as FrameworkId,
      detectedFramework: candidate.stack as FrameworkId,
      packageManager: candidate.packageManager,
      buildImage: candidate.buildImage,
      rootDirectory: candidate.rootDirectory,
      installCommand: candidate.installCommand,
      buildCommand: candidate.buildCommand,
      startCommand: candidate.startCommand,
      outputDirectory: candidate.outputDirectory,
      productionPaths: candidate.productionPaths,
      hasServer: candidate.hasServer,
      hasBuild: candidate.hasBuild,
    };
    return {
      primary,
      endpoints: candidate.hasServer
        ? singleAppEndpoints?.publicEndpoints ?? []
        : deriveStaticSingleAppEndpointFromCompose(config),
      productionPort: candidate.hasServer
        ? (singleAppEndpoints?.productionPort || String(candidate.port || ""))
        : "",
    };
  }

  if (!singleAppEndpoints) return null;

  return {
    primary: {
      framework: config.framework,
      detectedFramework: config.detectedFramework,
      packageManager: config.packageManager,
      buildImage: resolveBuildImageForDeploymentMode(config, "single"),
      rootDirectory: config.options.rootDirectory,
      installCommand: config.options.installCommand,
      buildCommand: config.options.buildCommand,
      startCommand: config.options.startCommand,
      outputDirectory: config.options.outputDirectory,
      productionPaths: config.options.productionPaths
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean),
      hasServer: config.options.hasServer,
      hasBuild: config.options.hasBuild,
    },
    endpoints: singleAppEndpoints.publicEndpoints,
    productionPort: singleAppEndpoints.productionPort,
  };
}

// ─── Monorepo → single-app helpers ───────────────────────────────────────────
//
// Mirrors the compose-side helpers above but reads from `config.monorepoApps`
// instead of `config.services`. When the operator toggles a monorepo project
// to "single app" mode, we promote ONE sub-app's commands (install / build /
// start / port) to the project level and collect every sub-app's public
// endpoint into the single-app's exposed-ports list. The OTHER sub-apps are
// effectively ignored at deploy time - same semantics compose has for
// `serviceDeploymentMode === "single"`.

/** Stable identity of the monorepoApps shape - used to invalidate cached
 *  single-app snapshots when the operator edits sub-app commands/ports. */
export function getMonorepoSingleAppSourceSignature(
  config: Pick<DeploymentConfig, "projectName" | "repo" | "monorepoApps">,
): string {
  return JSON.stringify({
    projectName: config.projectName || config.repo || "project",
    apps: (config.monorepoApps ?? []).map((app) => ({
      id: app.id,
      name: app.name,
      enabled: app.enabled,
      framework: app.framework,
      packageManager: app.packageManager,
      rootDirectory: app.rootDirectory,
      installCommand: app.installCommand,
      buildCommand: app.buildCommand,
      startCommand: app.startCommand,
      outputDirectory: app.outputDirectory,
      port: app.port,
      hasServer: app.hasServer,
      hasBuild: app.hasBuild,
    })),
  });
}

/**
 * Collect one endpoint per enabled sub-app, sorted with the "most primary"
 * candidate first (frontend apps before backend, then by sourceIndex).
 * Mirrors `listSingleAppComposeEndpointCandidates`.
 */
function listSingleAppMonorepoEndpointCandidates(config: DeploymentConfig) {
  const projectName = config.projectName || config.repo || "project";
  const apps = config.monorepoApps ?? [];

  return apps
    .map((app, index) => {
      if (!app.enabled) return null;
      // Reuse the sub-app's existing endpoint if it has one; otherwise
      // synthesize a default free subdomain from its name.
      const ep = app.publicEndpoints?.[0];
      const port = app.port || ep?.port || "";
      if (!port && app.hasServer) return null;
      return {
        sourceIndex: index,
        app,
        endpoint: createPublicEndpoint({
          port,
          targetPath: app.hasServer ? "" : "/",
          domainType: ep?.domainType ?? "free",
          domain:
            ep?.domainType === "custom"
              ? ""
              : ep?.domain || normalizeSubdomain(`${projectName}-${app.name}`),
          customDomain: ep?.domainType === "custom" ? ep.customDomain ?? "" : "",
        }),
      };
    })
    .filter(
      (entry): entry is {
        sourceIndex: number;
        app: NonNullable<DeploymentConfig["monorepoApps"]>[number];
        endpoint: PublicEndpoint;
      } => entry !== null,
    )
    .sort((left, right) => {
      const leftPriority = PRIMARY_SINGLE_APP_SERVICE_NAMES.has(left.app.name) ? 0 : 1;
      const rightPriority = PRIMARY_SINGLE_APP_SERVICE_NAMES.has(right.app.name) ? 0 : 1;
      return leftPriority - rightPriority || left.sourceIndex - right.sourceIndex;
    });
}

/**
 * Pick the primary sub-app for monorepo single-mode. Mirrors
 * `pickComposePrimary` but reads from `config.monorepoApps`. The list
 * helper already priority-sorts (frontend-y names first); we take [0].
 */
/**
 * Pick the primary sub-app for monorepo single-mode. Mirrors
 * `pickComposePrimary` but reads from `config.monorepoApps`. The list
 * helper already priority-sorts (frontend-y names first); we take [0].
 */
function pickMonorepoPrimary(
  config: DeploymentConfig,
): {
  primary: SingleAppPrimary;
  endpoints: PublicEndpoint[];
  productionPort: string;
} | null {
  const candidates = listSingleAppMonorepoEndpointCandidates(config);
  if (candidates.length === 0) return null;
  const primaryCandidate = candidates[0];
  const primaryApp = primaryCandidate.app;

  return {
    primary: {
      framework: primaryApp.framework,
      detectedFramework: primaryApp.detectedFramework ?? primaryApp.framework,
      packageManager: primaryApp.packageManager,
      buildImage: primaryApp.buildImage || resolveBuildImageForDeploymentMode(config, "single"),
      rootDirectory: primaryApp.rootDirectory,
      installCommand: primaryApp.installCommand,
      buildCommand: primaryApp.buildCommand,
      startCommand: primaryApp.startCommand,
      outputDirectory: primaryApp.outputDirectory,
      productionPaths: primaryApp.productionPaths,
      hasServer: primaryApp.hasServer,
      hasBuild: primaryApp.hasBuild,
    },
    endpoints: candidates.map((c) => c.endpoint),
    productionPort: primaryApp.port || primaryCandidate.endpoint.port,
  };
}

/**
 * Unified single-mode snapshot builder. ONE entry point that
 * branches on `projectType` to pick the right primary-extractor,
 * then runs the shared signature/cache/construction pipeline.
 *
 * Source-specific concerns (HOW to pick the primary) live in
 * `pickComposePrimary` / `pickMonorepoPrimary`. Everything else -
 * signature, cache check, snapshot construction - is shared.
 */
export function buildSingleModeSnapshot(
  config: DeploymentConfig,
  defaults?: Pick<DeploymentModeSnapshot, "buildStrategy" | "runtimeMode">,
): DeploymentSingleModeSnapshot | null {
  const isMonorepo = config.projectType === "monorepo";
  const sourceSignature = isMonorepo
    ? getMonorepoSingleAppSourceSignature(config)
    : getComposeSingleAppSourceSignature(config);

  // Cache: if the source shape hasn't changed since the last snapshot
  // was built, reuse it (preserves user-edited fields like custom
  // domains across re-renders).
  const existingSnapshot = config.modeSnapshots?.single;
  if (existingSnapshot?.sourceSignature === sourceSignature) {
    return captureModeSnapshot(existingSnapshot, {
      sourceSignature: existingSnapshot.sourceSignature,
    }) as DeploymentSingleModeSnapshot;
  }

  const picked = isMonorepo ? pickMonorepoPrimary(config) : pickComposePrimary(config);
  if (!picked) return null;

  return buildSingleModeSnapshotFromPrimary({
    config,
    defaults,
    primary: picked.primary,
    endpoints: picked.endpoints,
    productionPort: picked.productionPort,
    sourceSignature,
  });
}

export function getModeSwitchUpdates(
  config: DeploymentConfig,
  mode: DeploymentConfig["serviceDeploymentMode"],
): Partial<DeploymentConfig> {
  // The mode switch supports two source shapes: compose services and
  // monorepo sub-apps. Both produce a `service` table row per item on
  // the backend, so the toggle's job is purely UI-side: rebuild the
  // "single app" snapshot from whichever source shape the project has,
  // and stash the multi-app snapshot for later restoration.
  const isMultiAppSource =
    config.projectType === "services" || config.projectType === "monorepo";

  if (!isMultiAppSource || mode === config.serviceDeploymentMode) {
    return { serviceDeploymentMode: mode };
  }

  if (mode === "services") {
    const serviceSnapshot = config.modeSnapshots?.services;

    if (serviceSnapshot) {
      return {
        serviceDeploymentMode: "services",
        ...restoreModeSnapshot(serviceSnapshot),
      };
    }

    const updates: Partial<DeploymentConfig> = {
      serviceDeploymentMode: "services",
      runtimeMode: "docker",
      buildStrategy: "server",
      buildImage: resolveBuildImageForDeploymentMode(config, "services"),
    };

    if (config.composeDefaults) {
      updates.framework = config.composeDefaults.framework;
      updates.detectedFramework = config.composeDefaults.framework;
      updates.packageManager = config.composeDefaults.packageManager;
      updates.buildImage = config.composeDefaults.buildImage;
      updates.options = {
        ...config.options,
        ...config.composeDefaults.options,
      };
    }

    return updates;
  }

  // mode === "single" - one unified builder for both compose AND
  // monorepo sources. Internal branching on projectType happens inside.
  const existingSingleSnapshot = config.modeSnapshots?.single;
  const singleSnapshot = buildSingleModeSnapshot(config);
  const sourceSignature = singleSnapshot?.sourceSignature ?? null;

  if (!singleSnapshot) {
    return {
      serviceDeploymentMode: "single",
      // Sandboxed default — see DEFAULT_CONFIG.runtimeMode.
      runtimeMode: existingSingleSnapshot?.runtimeMode ?? "docker",
      buildStrategy: existingSingleSnapshot?.buildStrategy ?? config.buildStrategy,
      buildImage: resolveBuildImageForDeploymentMode(config, "single"),
    };
  }

  return {
    serviceDeploymentMode: "single",
    modeSnapshots: existingSingleSnapshot?.sourceSignature === sourceSignature
      ? config.modeSnapshots
      : {
          ...config.modeSnapshots,
          single: singleSnapshot,
        },
    ...restoreModeSnapshot(singleSnapshot),
  };
}

export function syncActiveModeSnapshot(config: DeploymentConfig): DeploymentConfig {
  if (config.projectType !== "services") {
    if (!config.modeSnapshots) {
      return config;
    }

    return {
      ...config,
      modeSnapshots: undefined,
    };
  }

  const currentMode = config.serviceDeploymentMode;
  const snapshot = currentMode === "single"
    ? captureModeSnapshot(config, {
        sourceSignature: config.modeSnapshots?.single?.sourceSignature ?? null,
      })
    : captureModeSnapshot(config);

  return {
    ...config,
    modeSnapshots: {
      ...config.modeSnapshots,
      [currentMode]: snapshot,
    },
  };
}