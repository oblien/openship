import { normalizeSubdomain } from "@/utils/subdomain";
import {
  createPublicEndpoint,
  resolveBuildImageForDeploymentMode,
  type ComposeServiceInfo,
  type DeploymentConfig,
  type DeploymentModeSnapshot,
  type DeploymentSingleModeSnapshot,
  type PublicEndpoint,
} from "./types";

const PRIMARY_SINGLE_APP_SERVICE_NAMES = new Set(["web", "app", "frontend"]);

const getExposedPort = (svc: ComposeServiceInfo) =>
  svc.ports[0]?.split(":").pop()?.split("/")[0];

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

      const port = service.exposedPort || getExposedPort(service) || "";
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

export function buildSingleModeSnapshotFromCompose(
  config: DeploymentConfig,
  defaults?: Pick<DeploymentModeSnapshot, "buildStrategy" | "runtimeMode">,
): DeploymentSingleModeSnapshot | null {
  const sourceSignature = getComposeSingleAppSourceSignature(config);
  const existingSnapshot = config.modeSnapshots?.single;

  if (existingSnapshot?.sourceSignature === sourceSignature) {
    return captureModeSnapshot(existingSnapshot, {
      sourceSignature: existingSnapshot.sourceSignature,
    }) as DeploymentSingleModeSnapshot;
  }

  const candidate = config.singleAppCandidate;
  const singleAppEndpoints = deriveSingleAppEndpointsFromCompose(config);
  const buildStrategy = existingSnapshot?.buildStrategy ?? defaults?.buildStrategy ?? config.buildStrategy;
  const runtimeMode = existingSnapshot?.runtimeMode ?? defaults?.runtimeMode ?? "bare";

  if (candidate) {
    return {
      framework: candidate.stack as DeploymentConfig["framework"],
      detectedFramework: candidate.stack as DeploymentConfig["framework"],
      packageManager: candidate.packageManager,
      buildImage: candidate.buildImage,
      buildStrategy,
      runtimeMode,
      publicEndpoints: candidate.hasServer
        ? clonePublicEndpoints(singleAppEndpoints?.publicEndpoints ?? [])
        : deriveStaticSingleAppEndpointFromCompose(config),
      options: {
        ...config.options,
        buildCommand: candidate.buildCommand,
        installCommand: candidate.installCommand,
        outputDirectory: candidate.outputDirectory,
        productionPaths: candidate.productionPaths.join(", "),
        startCommand: candidate.startCommand,
        productionPort: candidate.hasServer
          ? (singleAppEndpoints?.productionPort || String(candidate.port || ""))
          : "",
        rootDirectory: candidate.rootDirectory,
        hasServer: candidate.hasServer,
        hasBuild: candidate.hasBuild,
      },
      sourceSignature,
    };
  }

  if (!singleAppEndpoints) {
    return null;
  }

  return {
    framework: config.framework,
    detectedFramework: config.detectedFramework,
    packageManager: config.packageManager,
    buildImage: resolveBuildImageForDeploymentMode(config, "single"),
    buildStrategy,
    runtimeMode,
    publicEndpoints: clonePublicEndpoints(singleAppEndpoints.publicEndpoints),
    options: {
      ...config.options,
      productionPort: singleAppEndpoints.productionPort,
    },
    sourceSignature,
  };
}

export function getModeSwitchUpdates(
  config: DeploymentConfig,
  mode: DeploymentConfig["serviceDeploymentMode"],
): Partial<DeploymentConfig> {
  if (config.projectType !== "services" || mode === config.serviceDeploymentMode) {
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

  const sourceSignature = getComposeSingleAppSourceSignature(config);
  const existingSingleSnapshot = config.modeSnapshots?.single;
  const singleSnapshot = existingSingleSnapshot?.sourceSignature === sourceSignature
    ? existingSingleSnapshot
    : buildSingleModeSnapshotFromCompose(config);

  if (!singleSnapshot) {
    return {
      serviceDeploymentMode: "single",
      runtimeMode: existingSingleSnapshot?.runtimeMode ?? "bare",
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