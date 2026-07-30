/**
 * Managed Docker Swarm stack deployment.
 *
 * This is intentionally separate from the container/Compose pipeline: a stack
 * has one durable workload identity and its services are scheduler-owned, so
 * none of the container lifecycle calls are valid here.
 */

import { createHash } from "node:crypto";
import {
  BuildLogger,
  DEFAULT_BUILD_RESOURCE_CONFIG,
  DockerRuntime,
  deriveSwarmStackHealth,
  SwarmEdgeManager,
  SWARM_EDGE_NETWORK_NAME,
  type BuildConfig,
  type Platform,
  type SwarmDiscoverySnapshot,
  type SwarmServiceState,
} from "@repo/adapters";
import {
  AppError,
  type RuntimeServiceRef,
  type RuntimeWorkloadRef,
  type SwarmServiceProjection,
} from "@repo/core";
import {
  repos,
  type Deployment,
  type Project,
  type Service,
  type ContainerRegistry,
  type SwarmStack,
  type SwarmStackRevision,
} from "@repo/db";
import { swarmSupportEnabled } from "../../../config";
import { decryptSecretField, encryptSecretField } from "../../../lib/credential-encryption";
import { resolveTargetPlatform } from "../../../lib/deployment-runtime";
import { resolveOrgOwner } from "../../../lib/org-actor";
import { isConnectionLoss } from "../../../lib/remote-state";
import { buildBackgroundContext } from "../../../lib/request-context";
import { resolveBuildGitToken } from "../../github/clone-auth";
import { evaluateSwarmCompatibility, externalSwarmResourceConsumers } from "../../swarm/swarm-compatibility";
import {
  bindManagedSwarmResources,
  ensureManagedSwarmResources,
  removeNewManagedSwarmResources,
  planManagedSwarmResources,
  planManagedInputResources,
  referencedSwarmResourceRefs,
} from "../../swarm/swarm-managed-resources";
import { resolveManagedInputPayloads } from "../../swarm/swarm-managed-input.service";
import { redactRenderedStackYaml, swarmLiveStateDigest } from "../../swarm/swarm-preview";
import { projectSwarmStackSource } from "../../swarm/swarm-stack-projection";
import { resolveStackSourceFiles, type ResolvedSwarmStackSource } from "../../swarm/swarm-source.service";
import { planSwarmEdgeAttachments } from "../../swarm/swarm-edge-routing";
import { changedSwarmVolumeIdentities, claimVolumeIdentityMismatches, swarmResourceIdentities, swarmVolumeReplacementAcknowledgementKey } from "../../swarm/swarm-resource-identities";
import { planSwarmEdgeRoutes, reconcileSwarmEdgeRoutes } from "../../swarm/swarm-edge-routes";
import { ensurePendingServiceDomain } from "../../domains/domain.service";
import { swarmConvergence } from "./convergence.service";

type SwarmPlatform = Pick<Platform, "runtime" | "stackRuntime" | "executor">;

export interface SwarmDeployLogger {
  log(message: string, level?: "info" | "warn" | "error"): void;
  step(phase: string, state: "started" | "completed" | "failed", message: string): void;
}

interface Dependencies {
  featureEnabled: () => boolean;
  getStack: (projectId: string, organizationId: string) => Promise<SwarmStack | undefined>;
  getRegistry: (registryId: string, organizationId: string) => Promise<ContainerRegistry | undefined>;
  getRevision: (revisionId: string, organizationId: string) => Promise<SwarmStackRevision | undefined>;
  resolvePlatform: (serverId: string, organizationId: string) => Promise<SwarmPlatform>;
  createRevision: (
    stackId: string,
    organizationId: string,
    data: Parameters<typeof repos.swarmStack.createRevisionInOrganization>[2],
  ) => Promise<SwarmStackRevision | undefined>;
  updateRevision: (
    revisionId: string,
    organizationId: string,
    patch: Record<string, unknown>,
  ) => Promise<SwarmStackRevision | undefined>;
  updateStack: (
    id: string,
    organizationId: string,
    patch: Record<string, unknown>,
  ) => Promise<SwarmStack | undefined>;
  loadSource: (stack: SwarmStack, project: Project, organizationId: string) => Promise<ResolvedSwarmStackSource>;
  loadManagedInputs: (projectId: string, organizationId: string) => ReturnType<typeof resolveManagedInputPayloads>;
  syncProjections: (projectId: string, projections: SwarmServiceProjection[]) => Promise<Service[]>;
  listServices: (projectId: string) => Promise<Service[]>;
  listDomains: (projectId: string) => ReturnType<typeof repos.domain.listByProject>;
  ensurePendingDomain: (input: {
    projectId: string;
    serviceId: string;
    hostname: string;
    targetPort?: number;
  }) => ReturnType<typeof ensurePendingServiceDomain>;
  markDomainTlsActive: (domainId: string, certificate: { expiresAt: string }) => Promise<unknown>;
  createServiceDeployments: (
    rows: Array<{
      deploymentId: string;
      serviceId: string;
      serviceName: string;
      runtimeRef: RuntimeServiceRef;
      status: "success" | "in_progress";
      imageRef: string | null;
      startedAt: Date;
      finishedAt?: Date;
      durationMs?: number;
    }>,
  ) => Promise<unknown>;
  upsertServiceDeployment: (row: Parameters<typeof repos.service.upsertServiceDeployment>[0]) => Promise<unknown>;
  waitForConvergence: typeof swarmConvergence.wait;
  now: () => Date;
}

function ownershipLabels(stack: SwarmStack): Record<string, string> {
  return {
    "com.openship.stack-id": stack.id,
    "com.openship.project-id": stack.projectId,
  };
}

function isOwnedService(service: SwarmServiceState, stack: SwarmStack): boolean {
  const expected = ownershipLabels(stack);
  return Object.entries(expected).every(([key, value]) => service.labels[key] === value);
}

function stackServices(snapshot: SwarmDiscoverySnapshot, stackName: string): SwarmServiceState[] {
  return snapshot.services.filter((service) => service.stackName === stackName);
}

function projection(service: SwarmServiceState): SwarmServiceProjection {
  return {
    sourceServiceName: service.sourceServiceName,
    observedServiceId: service.id,
    mode: service.mode,
    ...(service.desiredReplicas !== null ? { replicas: { desired: service.desiredReplicas } } : {}),
    ...(service.image ? { image: service.image } : {}),
    ...(service.environmentKeys?.length ? { environmentKeys: service.environmentKeys } : {}),
    ...(service.healthcheck ? { healthcheck: service.healthcheck } : {}),
    ...(service.endpointMode ? { endpointMode: service.endpointMode } : {}),
    ...(service.placement ? { placement: service.placement } : {}),
    ...(service.resources ? { resources: service.resources } : {}),
    ...(service.updateConfig ? { updateConfig: service.updateConfig } : {}),
    ...(service.rollbackConfig ? { rollbackConfig: service.rollbackConfig } : {}),
    ...(service.restartPolicy ? { restartPolicy: service.restartPolicy } : {}),
    labels: service.labels,
    publishedPorts: service.publishedPorts.map((port) => ({ ...port })),
    networks: service.networks,
    configs: service.configs,
    secrets: service.secrets,
    sourceState: "present",
  };
}

function observedState(services: SwarmServiceState[]): Record<string, unknown> {
  return {
    services: services.map((service) => ({
      id: service.id,
      sourceServiceName: service.sourceServiceName,
      specVersion: service.specVersion,
      mode: service.mode,
      desiredReplicas: service.desiredReplicas,
      image: service.image,
      labels: service.labels,
    })),
  };
}

function safeDeployOutput(value: string, environment: Record<string, string>): string {
  let safe = value;
  for (const secret of Object.values(environment)) {
    if (secret) safe = safe.replaceAll(secret, "[REDACTED]");
  }
  return safe
    .replace(/((?:password|token|secret|api[_-]?key|authorization)\s*[=:]\s*)\S+/gi, "$1[REDACTED]")
    .slice(0, 16_000);
}

function safeDeployError(error: unknown, environment: Record<string, string>): string {
  const message = error instanceof Error ? error.message : "Docker stack deploy failed.";
  return safeDeployOutput(message, environment).slice(0, 1_000);
}

function renderedYamlDigest(value: string): string {
  const canonical = `${value.replaceAll("\r\n", "\n").replace(/\n+$/, "")}\n`;
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

type SwarmRollbackIntent = {
  sourceDeploymentId: string;
  sourceRevisionId: string;
};

function rollbackIntent(deployment: Deployment): SwarmRollbackIntent | null {
  const meta = deployment.meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const value = (meta as Record<string, unknown>).swarmRollback;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return typeof record.sourceDeploymentId === "string" && record.sourceDeploymentId &&
    typeof record.sourceRevisionId === "string" && record.sourceRevisionId
    ? { sourceDeploymentId: record.sourceDeploymentId, sourceRevisionId: record.sourceRevisionId }
    : null;
}

function retainedRevisionYaml(revision: SwarmStackRevision): string {
  if (revision.applyStatus !== "ready") {
    throw new AppError("The selected Swarm revision did not finish successfully and cannot be rolled back.", 409, "SWARM_ROLLBACK_REVISION_UNAVAILABLE");
  }
  let renderedYaml: string | undefined;
  try {
    renderedYaml = decryptSecretField(revision.renderedYamlEnc);
  } catch {
    throw new AppError("The selected Swarm revision could not be decrypted and cannot be rolled back before mutation.", 409, "SWARM_ROLLBACK_ARTIFACT_MISSING");
  }
  if (!renderedYaml) {
    throw new AppError("The selected Swarm revision has no retained rendered stack document.", 409, "SWARM_ROLLBACK_ARTIFACT_MISSING");
  }
  const digest = `sha256:${createHash("sha256").update(renderedYaml).digest("hex")}`;
  if (digest !== revision.renderedDigest) {
    throw new AppError("The selected Swarm revision failed its immutable rendered-document integrity check.", 409, "SWARM_ROLLBACK_ARTIFACT_MISSING");
  }
  return renderedYaml;
}

function revisionRoutingMode(revision: SwarmStackRevision, fallback: SwarmStack["routingMode"]): SwarmStack["routingMode"] {
  const mode = revision.manifest && typeof revision.manifest === "object"
    ? (revision.manifest as Record<string, unknown>).routingMode
    : undefined;
  return mode === "external" || mode === "openship-edge" ? mode : fallback;
}

function safePrunePlan(
  stack: SwarmStack,
  current: SwarmServiceState[],
  desiredNames: Set<string>,
): { prune: boolean; removals: string[] } {
  if (!stack.prune) return { prune: false, removals: [] };
  const candidates = current.filter((service) => !desiredNames.has(service.sourceServiceName));
  const foreign = candidates.filter((service) => !isOwnedService(service, stack));
  if (foreign.length > 0) {
    throw new AppError(
      `Refusing to prune ${foreign.map((service) => service.sourceServiceName).join(", ")}: it is not labeled as managed by this OpenShip project.`,
      409,
      "SWARM_PRUNE_OWNERSHIP_CONFLICT",
    );
  }
  return {
    prune: candidates.length > 0,
    removals: candidates.map((service) => service.sourceServiceName).sort(),
  };
}

function serviceRefs(
  stack: SwarmStack,
  services: SwarmServiceState[],
): Record<string, RuntimeServiceRef> {
  return Object.fromEntries(
    services.map((service) => [
      service.sourceServiceName,
      {
        kind: "swarm-service" as const,
        clusterId: stack.clusterId,
        stackName: stack.stackName,
        serviceId: service.id,
        serviceName: service.sourceServiceName,
        specVersion: service.specVersion ?? 0,
      },
    ]),
  );
}

function pendingClaimDigest(stack: SwarmStack): string | null {
  const value = stack.driftDetails?.claimLiveDigest;
  return typeof value === "string" && value ? value : null;
}

function registryDeploymentAuth(registry: ContainerRegistry | null): {
  serverAddress: string;
  username: string;
  password: string;
} | undefined {
  if (!registry) return undefined;
  const username = registry.username?.trim() || undefined;
  const password = decryptSecretField(registry.credentialsEnc);
  if (!!username !== !!password) {
    throw new AppError(
      "The selected registry has incomplete login credentials. Set both username and credential, or clear both for a public registry.",
      409,
      "REGISTRY_CREDENTIALS_INCOMPLETE",
    );
  }
  return username && password
    ? { serverAddress: registry.registryUrl, username, password }
    : undefined;
}

function imageSegment(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function relativeBuildContext(stack: SwarmStack, value: string): string | undefined {
  const context = value.trim() || ".";
  if (context.startsWith("/") || context.includes("\\") || context.split("/").some((part) => part === ".." || part === "")) {
    throw new AppError("A source-built service has an unsafe build context.", 409, "SWARM_BUILD_CONTEXT_INVALID");
  }
  const root = stack.sourcePath?.replace(/\/$/, "") ?? "";
  if (root && root.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new AppError("The linked stack source path is unsafe for a source build.", 409, "SWARM_BUILD_CONTEXT_INVALID");
  }
  if (context === ".") return root || undefined;
  return root && context !== root && !context.startsWith(`${root}/`) ? `${root}/${context}` : context;
}

function sourceBuildDefinition(service: SwarmServiceProjection): { context: string; dockerfile?: string } | null {
  if (!service.build) return null;
  if (typeof service.build === "string") return { context: service.build };
  const context = typeof service.build.context === "string" ? service.build.context : ".";
  const dockerfile = typeof service.build.dockerfile === "string" ? service.build.dockerfile.trim() : undefined;
  if (dockerfile && (dockerfile.startsWith("/") || dockerfile.includes("\\") || dockerfile.split("/").some((part) => part === ".." || part === ""))) {
    throw new AppError("A source-built service has an unsafe Dockerfile path.", 409, "SWARM_BUILD_CONTEXT_INVALID");
  }
  return { context, ...(dockerfile ? { dockerfile } : {}) };
}

function canonicalChangedPath(value: string): string | null {
  const path = value.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  if (!path || path.startsWith("/") || path.split("/").some((part) => !part || part === "." || part === "..")) return null;
  return path;
}

function pathIsWithin(path: string, root: string | undefined): boolean {
  return !root || path === root || path.startsWith(`${root}/`);
}

/**
 * A precise webhook path set may carry a prior digest only when every changed
 * file belongs to a known independent build context. Any missing digest,
 * source-file edit, shared/outside file, malformed path, or truncated set
 * rebuilds conservatively instead.
 */
export function selectSourceBuilds(input: {
  stack: SwarmStack;
  deployment: Deployment;
  buildable: Array<{ service: SwarmServiceProjection; build: { context: string; dockerfile?: string } }>;
  previousImages: Record<string, string>;
}): { build: typeof input.buildable; preserved: Record<string, string> } {
  const all = () => ({ build: input.buildable, preserved: {} });
  if (input.buildable.length === 0 || input.deployment.forceAll || input.deployment.changedPathsTruncated) return all();
  const changed = input.deployment.changedPaths;
  if (!changed || changed.length === 0) return all();

  const buildRoots = input.buildable.map((entry) => ({
    ...entry,
    root: relativeBuildContext(input.stack, entry.build.context),
  }));
  const sourceRoot = input.stack.sourcePath?.replace(/\/$/, "") ?? "";
  const composePaths = new Set(input.stack.sourcePaths.map((path) =>
    sourceRoot && path !== sourceRoot && !path.startsWith(`${sourceRoot}/`) ? `${sourceRoot}/${path}` : path,
  ));
  const affected = new Set<string>();
  for (const rawPath of changed) {
    const path = canonicalChangedPath(rawPath);
    if (!path || composePaths.has(path)) return all();
    const matches = buildRoots.filter((entry) => pathIsWithin(path, entry.root));
    // A project-level/shared file lies outside every declared context; no
    // exact dependency graph is available, so rebuild all rather than reuse a
    // potentially stale artifact. Overlapping contexts rebuild each match.
    if (matches.length === 0) return all();
    for (const entry of matches) affected.add(entry.service.sourceServiceName);
  }
  const build: typeof input.buildable = [];
  const preserved: Record<string, string> = {};
  for (const entry of input.buildable) {
    const previous = input.previousImages[entry.service.sourceServiceName];
    if (affected.has(entry.service.sourceServiceName) || !previous?.includes("@sha256:")) {
      build.push(entry);
    } else {
      preserved[entry.service.sourceServiceName] = previous;
    }
  }
  return { build, preserved };
}

/** Build `build:` services on the manager daemon and turn each into `repo@digest`. */
async function publishSourceBuilds(input: {
  stack: SwarmStack;
  project: Project;
  deployment: Deployment;
  services: SwarmServiceProjection[];
  registry: ContainerRegistry | null;
  registryAuth: ReturnType<typeof registryDeploymentAuth>;
  previousImages: Record<string, string>;
  runtime: Platform["runtime"];
  logger: SwarmDeployLogger;
  onBuildStatus?: (
    serviceName: string,
    status: "building" | "deploying" | "failure" | "skipped",
    detail?: { imageRef?: string; errorMessage?: string },
  ) => Promise<void>;
}): Promise<Record<string, string>> {
  const buildable = input.services.flatMap((service) => {
    const build = sourceBuildDefinition(service);
    return build ? [{ service, build }] : [];
  });
  if (buildable.length === 0) return {};
  const selected = selectSourceBuilds({
    stack: input.stack,
    deployment: input.deployment,
    buildable,
    previousImages: input.previousImages,
  });
  const markBuildsFailed = async (errorMessage: string) => {
    await Promise.all(selected.build.map(({ service }) =>
      input.onBuildStatus?.(service.sourceServiceName, "failure", { errorMessage }),
    ));
  };
  if (!input.registry) {
    await markBuildsFailed("No OCI registry is configured for this source build.");
    throw new AppError(
      "This stack has source-built services. Select an OCI registry before applying it.",
      409,
      "SWARM_BUILD_REGISTRY_REQUIRED",
    );
  }
  if (!(input.runtime instanceof DockerRuntime)) {
    await markBuildsFailed("The selected manager cannot build source services through Docker.");
    throw new AppError(
      "The selected Swarm manager cannot build and publish source services through Docker.",
      503,
      "SWARM_BUILD_RUNTIME_UNAVAILABLE",
    );
  }
  if (input.stack.sourceKind !== "repository" || !input.project.gitOwner || !input.project.gitRepo) {
    await markBuildsFailed("Source builds require a linked repository source.");
    throw new AppError(
      "Source-built services require a linked repository stack source so OpenShip can use its bounded build context.",
      409,
      "SWARM_BUILD_REPOSITORY_REQUIRED",
    );
  }
  let git: Awaited<ReturnType<typeof resolveBuildGitToken>>;
  try {
    const owner = await resolveOrgOwner(input.deployment.organizationId);
    if (!owner) {
      throw new AppError("The organization owner is unavailable to prepare the source build.", 503, "SWARM_SOURCE_REPOSITORY_UNAVAILABLE");
    }
    git = await resolveBuildGitToken({
      ctx: buildBackgroundContext({ userId: owner.userId, organizationId: input.deployment.organizationId, label: "swarm:source-build" }),
      projectId: input.project.id,
      owner: input.project.gitOwner,
      repo: input.project.gitRepo,
      buildStrategy: "local",
    });
  } catch {
    await markBuildsFailed("Source repository credentials could not be prepared.");
    throw new AppError("OpenShip could not prepare source repository credentials for this build.", 502, "SWARM_BUILD_SOURCE_UNAVAILABLE");
  }
  const repository = [
    input.registry.registryUrl,
    ...(input.registry.repositoryPrefix ? [input.registry.repositoryPrefix] : []),
    imageSegment(input.project.slug, "project"),
  ].join("/");
  const overrides: Record<string, string> = { ...selected.preserved };
  for (const serviceName of Object.keys(selected.preserved)) {
    input.logger.log(`Reusing immutable registry digest for unchanged service ${serviceName}\n`);
    await input.onBuildStatus?.(serviceName, "skipped", { imageRef: selected.preserved[serviceName] });
  }
  const buildSpecs = selected.build.map(({ service, build }) => {
    const serviceName = imageSegment(service.sourceServiceName, "service");
    const target = `${repository}/${serviceName}:${imageSegment(input.deployment.id, "deployment")}`;
    const buildLogger = new BuildLogger((entry) => {
      input.logger.log(entry.message, entry.level === "error" ? "error" : entry.level === "warn" ? "warn" : "info");
    });
    return {
      service,
      target,
      buildLogger,
      config: {
        sessionId: `${input.deployment.id}-${serviceName}`,
        projectId: input.project.id,
        slug: `swarm-${imageSegment(input.project.slug, "project")}-${serviceName}`,
        repoUrl: input.project.gitUrl ?? `https://github.com/${input.project.gitOwner}/${input.project.gitRepo}.git`,
        branch: input.stack.sourceBranch ?? input.project.gitBranch ?? "main",
        commitSha: input.stack.sourceCommitSha ?? input.deployment.commitSha ?? undefined,
        stack: "docker",
        buildImage: "",
        runtimeImage: "",
        packageManager: "",
        installCommand: "",
        buildCommand: "",
        outputDirectory: "",
        port: 3000,
        rootDirectory: relativeBuildContext(input.stack, build.context),
        dockerfilePath: build.dockerfile,
        hasServer: true,
        envVars: {},
        resources: DEFAULT_BUILD_RESOURCE_CONFIG,
        gitToken: git.token,
      } satisfies BuildConfig,
    };
  });
  for (const spec of buildSpecs) {
    input.logger.step("swarm-build", "started", `Building and publishing ${spec.service.sourceServiceName}`);
    await input.onBuildStatus?.(spec.service.sourceServiceName, "building");
  }
  let buildResults: Array<{ serviceName: string; result: Awaited<ReturnType<DockerRuntime["build"]>> }>;
  try {
    buildResults = await input.runtime.buildImages(
      buildSpecs.map((spec) => ({
        config: spec.config,
        serviceName: spec.service.sourceServiceName,
        logger: spec.buildLogger,
        requireRepositoryDockerfile: true,
      })),
      new BuildLogger((entry) => input.logger.log(entry.message, entry.level === "error" ? "error" : entry.level === "warn" ? "warn" : "info")),
    );
  } catch {
    await markBuildsFailed("Source image build failed.");
    throw new AppError("Could not prepare the shared source build context.", 502, "SWARM_BUILD_FAILED");
  }
  const resultsByService = new Map(buildResults.map(({ serviceName, result }) => [serviceName, result]));
  for (const spec of buildSpecs) {
    const result = resultsByService.get(spec.service.sourceServiceName);
    if (result?.status === "deploying" && result.imageRef) continue;
    input.logger.step("swarm-build", "failed", `Could not build ${spec.service.sourceServiceName}`);
    await input.onBuildStatus?.(spec.service.sourceServiceName, "failure", { errorMessage: "Source image build failed." });
    throw new AppError(`Could not build source service ${spec.service.sourceServiceName}.`, 502, "SWARM_BUILD_FAILED");
  }
  for (const spec of buildSpecs) {
    const result = resultsByService.get(spec.service.sourceServiceName)!;
    try {
      const published = await input.runtime.publishImage({
        source: result.imageRef!,
        target: spec.target,
        ...(input.registryAuth ? { auth: input.registryAuth } : {}),
        onProgress: (message) => input.logger.log(message),
      });
      overrides[spec.service.sourceServiceName] = published.digestRef;
      await input.onBuildStatus?.(spec.service.sourceServiceName, "deploying", { imageRef: published.digestRef });
      input.logger.step("swarm-build", "completed", `Published ${spec.service.sourceServiceName} as an immutable registry digest`);
    } catch {
      input.logger.step("swarm-build", "failed", `Could not publish ${spec.service.sourceServiceName}`);
      await input.onBuildStatus?.(spec.service.sourceServiceName, "failure", { errorMessage: "Registry image publication failed." });
      throw new AppError(`Could not publish source service ${spec.service.sourceServiceName} to the configured registry.`, 502, "SWARM_IMAGE_PUBLISH_FAILED");
    }
  }
  return overrides;
}

export type SwarmDeployOutcome = {
  runtimeRef: RuntimeWorkloadRef;
  revisionId: string;
  state: "ready" | "reconciling";
  warningMessage?: string;
};

/** Factory form keeps the ownership/apply boundary executable in isolation. */
export function createSwarmDeployService(overrides: Partial<Dependencies> = {}) {
  const deps: Dependencies = {
    featureEnabled: swarmSupportEnabled,
    getStack: (projectId, organizationId) =>
      repos.swarmStack.getForProjectInOrganization(projectId, organizationId),
    getRegistry: (registryId, organizationId) =>
      repos.containerRegistry.getInOrganization(registryId, organizationId),
    getRevision: (revisionId, organizationId) =>
      repos.swarmStack.getRevisionInOrganization(revisionId, organizationId),
    resolvePlatform: async (serverId, organizationId) =>
      resolveTargetPlatform("server", "docker", serverId, organizationId, "swarm"),
    createRevision: (stackId, organizationId, data) =>
      repos.swarmStack.createRevisionInOrganization(stackId, organizationId, data),
    updateRevision: (revisionId, organizationId, patch) =>
      repos.swarmStack.updateRevisionInOrganization(revisionId, organizationId, patch),
    updateStack: (id, organizationId, patch) =>
      repos.swarmStack.updateInOrganization(id, organizationId, patch),
    loadSource: async (stack, project, organizationId) => {
      if (stack.sourceKind === "inline") {
        return resolveStackSourceFiles(
          stack,
          project,
          buildBackgroundContext({ userId: "swarm-source", organizationId, label: "swarm:inline-source" }),
        );
      }
      const owner = await resolveOrgOwner(organizationId);
      if (!owner) {
        throw new AppError("The organization owner is unavailable to read the linked stack repository.", 503, "SWARM_SOURCE_REPOSITORY_UNAVAILABLE");
      }
      return resolveStackSourceFiles(
        stack,
        project,
        buildBackgroundContext({ userId: owner.userId, organizationId, label: "swarm:source-read" }),
      );
    },
    loadManagedInputs: resolveManagedInputPayloads,
    syncProjections: (projectId, projections) =>
      repos.service.syncSwarmProjections(projectId, projections),
    listServices: (projectId) => repos.service.listByProject(projectId),
    listDomains: (projectId) => repos.domain.listByProject(projectId),
    ensurePendingDomain: (input) => ensurePendingServiceDomain(input),
    markDomainTlsActive: (domainId, certificate) =>
      repos.domain.markVerifiedActive(domainId, {
        sslStatus: "active",
        sslIssuer: "letsencrypt",
        sslExpiresAt: new Date(certificate.expiresAt),
      }),
    createServiceDeployments: (rows) => repos.serviceDeployment.bulkCreate(rows),
    upsertServiceDeployment: (row) => repos.service.upsertServiceDeployment(row),
    waitForConvergence: (input) => swarmConvergence.wait(input),
    now: () => new Date(),
    ...overrides,
  };

  return {
    async deploy(input: {
      project: Project;
      deployment: Deployment;
      environment: Record<string, string>;
      logger: SwarmDeployLogger;
    }): Promise<SwarmDeployOutcome> {
      if (!deps.featureEnabled()) {
        throw new AppError(
          "Docker Swarm support is not enabled on this OpenShip instance.",
          404,
          "SWARM_FEATURE_DISABLED",
        );
      }
      const { project, deployment, environment, logger } = input;
      const stack = await deps.getStack(project.id, deployment.organizationId);
      if (!stack)
        throw new AppError(
          "This project has no Docker Swarm stack binding.",
          409,
          "SWARM_STACK_REQUIRED",
        );
      if (!stack.managerServerId)
        throw new AppError(
          "This stack no longer has a Swarm manager target.",
          409,
          "SWARM_MANAGER_UNAVAILABLE",
        );
      const claimPending = stack.managementMode === "observe" && !!stack.claimedAt;
      if (stack.managementMode !== "managed" && !claimPending) {
        throw new AppError(
          "This observed stack must be explicitly claimed before OpenShip can apply it.",
          409,
          "SWARM_STACK_CLAIM_REQUIRED",
        );
      }
      const rollback = rollbackIntent(deployment);
      const rollbackRevision = rollback
        ? await deps.getRevision(rollback.sourceRevisionId, deployment.organizationId)
        : undefined;
      if (rollback && (!rollbackRevision || rollbackRevision.stackId !== stack.id)) {
        throw new AppError("The selected Swarm rollback revision is unavailable for this stack.", 409, "SWARM_ROLLBACK_REVISION_UNAVAILABLE");
      }
      const rollbackYaml = rollbackRevision ? retainedRevisionYaml(rollbackRevision) : undefined;
      // A rollback starts from the encrypted immutable rendered document, never
      // the current editable source or a mutable image tag. It is still parsed
      // locally to retain the normal ownership/convergence checks below.
      const sourceMaterial: ResolvedSwarmStackSource = rollbackYaml
        ? { files: [{ path: "retained-rendered-stack.yaml", content: rollbackYaml }], composePaths: ["retained-rendered-stack.yaml"] }
        : await deps.loadSource(stack, project, deployment.organizationId);
      const source = projectSwarmStackSource(
        sourceMaterial.composePaths.map((path) => sourceMaterial.files.find((file) => file.path === path)!).filter(Boolean),
      );
      const routingMode = rollbackRevision
        ? revisionRoutingMode(rollbackRevision, stack.routingMode)
        : stack.routingMode;
      const routeStack = routingMode === stack.routingMode ? stack : { ...stack, routingMode };
      const ownership = Object.fromEntries(
        source.services.map((service) => [
          service.sourceServiceName,
          {
            ...ownershipLabels(stack),
            "com.openship.source-service": service.sourceServiceName,
          },
        ]),
      );
      const platform = await deps.resolvePlatform(stack.managerServerId, deployment.organizationId);
      if (!platform.stackRuntime)
        throw new AppError(
          "Docker Swarm is unavailable for this target.",
          503,
          "SWARM_MANAGER_UNAVAILABLE",
        );
      const registryResult = stack.registryId
        ? await deps.getRegistry(stack.registryId, deployment.organizationId)
        : null;
      if (stack.registryId && !registryResult) {
        throw new AppError(
          "The selected container registry is no longer available. Choose a registry before deploying this stack.",
          409,
          "REGISTRY_REQUIRED",
        );
      }
      const registry = registryResult ?? null;
      const registryAuth = registryDeploymentAuth(registry);
      const previousRevision = stack.lastAppliedRevisionId
        ? await deps.getRevision(stack.lastAppliedRevisionId, deployment.organizationId)
        : undefined;

      logger.step(
        "swarm-render",
        "started",
        "Validating the stack configuration on the Swarm manager",
      );
      const before = await platform.stackRuntime.discover();
      if (before.manager.clusterId !== stack.clusterId) {
        throw new AppError(
          "The configured manager now belongs to a different Swarm cluster.",
          409,
          "SWARM_CLUSTER_MISMATCH",
        );
      }
      const current = stackServices(before, stack.stackName);
      if (rollbackRevision) {
        const missingConfigs = rollbackRevision.configRefs.filter(
          (name) => !before.configs.some((config) => config.name === name),
        );
        const missingSecrets = rollbackRevision.secretRefs.filter(
          (name) => !before.secrets.some((secret) => secret.name === name),
        );
        if (missingConfigs.length > 0 || missingSecrets.length > 0) {
          const missing = [
            ...missingConfigs.map((name) => `config ${name}`),
            ...missingSecrets.map((name) => `secret ${name}`),
          ];
          throw new AppError(
            `The selected Swarm rollback revision references unavailable retained resources: ${missing.join(", ")}.`,
            409,
            "SWARM_ROLLBACK_DEPENDENCY_MISSING",
          );
        }
      }
      if (claimPending) {
        const claimedDigest = pendingClaimDigest(stack);
        if (!claimedDigest || claimedDigest !== swarmLiveStateDigest(current)) {
          throw new AppError(
            "The stack changed after the management claim was reviewed. Refresh the live diff and confirm it again.",
            409,
            "SWARM_STACK_CLAIM_STALE",
          );
        }
      } else if (current.some((service) => !isOwnedService(service, stack))) {
        throw new AppError(
          "The target stack contains services that are not labeled as managed by this OpenShip project. Claim it again from a current review before applying.",
          409,
          "SWARM_STACK_OWNERSHIP_CONFLICT",
        );
      }
      const sourceBuiltServiceNames = rollbackRevision
        ? new Set<string>()
        : new Set(source.services.filter((service) => !!service.build).map((service) => service.sourceServiceName));
      const needsServiceRows = sourceBuiltServiceNames.size > 0 || routingMode === "openship-edge";
      const sourceRows = needsServiceRows
        ? new Map((await deps.syncProjections(project.id, source.services)).map((service) => [service.sourceServiceName, service]))
        : new Map<string, Service>();
      const sourceRowsByName = sourceRows;
      const sourceBuildStartedAt = new Map<string, Date>();
      const persistSourceBuildStatus = async (
        serviceName: string,
        status: "building" | "deploying" | "failure" | "skipped",
        detail: { imageRef?: string; errorMessage?: string } = {},
      ) => {
        const service = sourceRowsByName.get(serviceName);
        if (!service) return;
        const now = deps.now();
        const startedAt = sourceBuildStartedAt.get(serviceName) ?? now;
        if (status === "building") sourceBuildStartedAt.set(serviceName, startedAt);
        const terminal = status === "failure" || status === "skipped";
        await deps.upsertServiceDeployment({
          deploymentId: deployment.id,
          serviceId: service.id,
          serviceName: service.name,
          runtimeRef: null,
          status,
          ...(detail.imageRef ? { imageRef: detail.imageRef, imageDigest: detail.imageRef.includes("@sha256:") ? detail.imageRef : null } : {}),
          startedAt,
          ...(terminal ? { finishedAt: now, durationMs: Math.max(0, now.getTime() - startedAt.getTime()) } : {}),
          ...(detail.errorMessage ? { errorMessage: detail.errorMessage, error: detail.errorMessage } : {}),
        });
      };
      const imageOverrides = rollbackRevision
        ? {}
        : await publishSourceBuilds({
            stack,
            project,
            deployment,
            services: source.services,
            registry,
            registryAuth,
            previousImages: previousRevision?.serviceImages ?? {},
            runtime: platform.runtime,
            logger,
            onBuildStatus: persistSourceBuildStatus,
          });
      const edgePlan = planSwarmEdgeAttachments(routeStack, source.services.map((service) => service.sourceServiceName), [...sourceRows.values()]);
      if (edgePlan && edgePlan.upstreams.length > 0) {
        if (!platform.executor) {
          throw new AppError("OpenShip Edge requires a manager command transport.", 503, "SWARM_EDGE_UNAVAILABLE");
        }
        const edge = await new SwarmEdgeManager(platform.stackRuntime, platform.executor).status();
        if (!edge) {
          throw new AppError("OpenShip Edge is not enabled on this manager. Enable it explicitly before deploying routed services.", 409, "SWARM_EDGE_REQUIRED");
        }
        const edgeNetwork = before.networks.find((network) => network.name === SWARM_EDGE_NETWORK_NAME);
        if (!edgeNetwork || edgeNetwork.driver !== "overlay" || edgeNetwork.scope !== "swarm") {
          throw new AppError("OpenShip Edge overlay is unavailable on this manager. Check the Edge network before deploying routed services.", 503, "SWARM_EDGE_NETWORK_UNAVAILABLE");
        }
        logger.log(`→ Attaching ${edgePlan.upstreams.map((upstream) => upstream.sourceServiceName).join(", ")} to the OpenShip Edge overlay\n`);
      }
      const initiallyRendered = rollbackRevision && rollbackYaml
        ? {
            renderedYaml: rollbackYaml,
            renderedDigest: rollbackRevision.renderedDigest,
            overrideYaml: rollbackRevision.overrideYamlRedacted ?? "",
            warnings: [],
          }
        : await platform.stackRuntime.renderStack({
            files: sourceMaterial.files,
            composePaths: sourceMaterial.composePaths,
            environment,
            ownershipLabels: ownership,
            imageOverrides,
            networkAttachments: edgePlan?.networkAttachments,
            externalNetworks: edgePlan?.externalNetworks,
          });
      const sourceManagedResources = rollbackRevision
        ? []
        : planManagedSwarmResources({
            projectId: project.id,
            files: sourceMaterial.files,
            composePaths: sourceMaterial.composePaths,
          });
      const inputManagedResources = rollbackRevision
        ? []
        : planManagedInputResources({
            projectId: project.id,
            inputs: await deps.loadManagedInputs(project.id, deployment.organizationId),
          });
      // Operator-entered values deliberately win their matching logical
      // declaration; the source-backed variant is not created unnecessarily.
      const inputKeys = new Set(inputManagedResources.map((resource) => `${resource.kind}:${resource.logicalName}`));
      const managedResources = [
        ...sourceManagedResources.filter((resource) => !inputKeys.has(`${resource.kind}:${resource.logicalName}`)),
        ...inputManagedResources,
      ];
      if (claimPending) {
        const replacements = claimVolumeIdentityMismatches(initiallyRendered.renderedYaml, stack.stackName, current);
        const acknowledged = new Set(stack.volumeReplacementAcknowledgements);
        const unacknowledged = replacements.filter((change) => !acknowledged.has(swarmVolumeReplacementAcknowledgementKey(change)));
        if (unacknowledged.length > 0) {
          throw new AppError(
            `Refusing first claim because it would redirect attached stateful volumes: ${unacknowledged.map((change) => `${change.serviceName}.${change.logicalName} (${change.previousName} → ${change.nextName})`).join(", ")}. Review and explicitly acknowledge this replacement before applying.`,
            409,
            "SWARM_CLAIM_VOLUME_IDENTITY_MISMATCH",
          );
        }
      }
      if (!rollbackRevision && previousRevision?.applyStatus === "ready") {
        const replacements = changedSwarmVolumeIdentities(
          retainedRevisionYaml(previousRevision),
          initiallyRendered.renderedYaml,
          stack.stackName,
        );
        const acknowledged = new Set(stack.volumeReplacementAcknowledgements);
        const unacknowledged = replacements.filter((change) => !acknowledged.has(swarmVolumeReplacementAcknowledgementKey(change)));
        if (unacknowledged.length > 0) {
          throw new AppError(
            `Refusing to replace stateful Swarm volume identities: ${unacknowledged.map((change) => `${change.logicalName} (${change.previousName} → ${change.nextName})`).join(", ")}. Review and explicitly acknowledge this replacement before applying.`,
            409,
            "SWARM_VOLUME_REPLACEMENT_ACK_REQUIRED",
          );
        }
      }
      // Check source-declared external dependencies before creating anything.
      // The later check runs against the rewritten immutable references.
      const sourceCompatibility = evaluateSwarmCompatibility({
        renderedYaml: initiallyRendered.renderedYaml,
        discovery: before,
        registryConfigured: !!registry,
        acknowledgedStorage: stack.storageAcknowledgements,
      });
      if (sourceCompatibility.blockers.length > 0) {
        throw new AppError(
          `Stack compatibility checks failed: ${sourceCompatibility.blockers.map((issue) => issue.message).join(" ")}`,
          409,
          "SWARM_COMPATIBILITY_BLOCKED",
        );
      }
      let resourceDiscovery = before;
      let rendered = initiallyRendered;
      let newlyCreatedManagedResources: ReturnType<typeof planManagedSwarmResources> = [];
      if (managedResources.length > 0) {
        if (!platform.executor) {
          throw new AppError("This manager transport cannot safely create immutable Swarm configs and secrets.", 503, "SWARM_MANAGED_RESOURCE_UNAVAILABLE");
        }
        const boundYaml = bindManagedSwarmResources(initiallyRendered.renderedYaml, managedResources);
        const managedRefs = await ensureManagedSwarmResources({
          executor: platform.executor,
          discovery: before,
          projectId: project.id,
          resources: managedResources,
        });
        newlyCreatedManagedResources = managedRefs.createdResources;
        try {
          resourceDiscovery = await platform.stackRuntime.discover();
          if (resourceDiscovery.manager.clusterId !== stack.clusterId) {
            throw new AppError("The configured manager now belongs to a different Swarm cluster.", 409, "SWARM_CLUSTER_MISMATCH");
          }
        } catch (error) {
          await removeNewManagedSwarmResources(platform.executor, newlyCreatedManagedResources);
          throw error;
        }
        rendered = {
          ...initiallyRendered,
          renderedYaml: boundYaml,
          renderedDigest: renderedYamlDigest(boundYaml),
        };
        logger.log(`→ Prepared ${managedRefs.configs.length} immutable config(s) and ${managedRefs.secrets.length} immutable secret(s)\n`);
      }
      let revision: SwarmStackRevision;
      let prune: boolean;
      let prunePlan: { prune: boolean; removals: string[] };
      let resolvedSource!: ReturnType<typeof projectSwarmStackSource>;
      let startedAt: Date;
      try {
        resolvedSource = projectSwarmStackSource([
          { path: "rendered-stack.yaml", content: rendered.renderedYaml },
        ]);
        const compatibility = evaluateSwarmCompatibility({
          renderedYaml: rendered.renderedYaml,
          discovery: resourceDiscovery,
          registryConfigured: !!registry,
          acknowledgedStorage: stack.storageAcknowledgements,
        });
        if (compatibility.blockers.length > 0) {
          throw new AppError(
            `Stack compatibility checks failed: ${compatibility.blockers.map((issue) => issue.message).join(" ")}`,
            409,
            "SWARM_COMPATIBILITY_BLOCKED",
          );
        }
        // A first claim never prunes: deletion consent belongs to a later,
        // separately reviewed managed deployment after labels are verified.
        prunePlan = rollbackRevision
          ? {
              prune: (rollbackRevision.manifest as Record<string, unknown>)?.prune === true,
              removals: [] as string[],
            }
          : claimPending
          ? { prune: false, removals: [] }
          : safePrunePlan(
              stack,
              current,
              new Set(resolvedSource.services.map((service) => service.sourceServiceName)),
            );
        prune = prunePlan.prune;
        if (prunePlan.removals.length > 0) {
          logger.log(`→ Confirmed managed-service prune: ${prunePlan.removals.join(", ")}\n`, "warn");
        }
        logger.step(
          "swarm-render",
          "completed",
          "Rendered and validated the authoritative Swarm stack configuration",
        );

        startedAt = deps.now();
        const createdRevision = await deps.createRevision(stack.id, deployment.organizationId, {
          sourceDigest: rollbackRevision?.sourceDigest ?? stack.sourceDigest,
          sourceCommitSha: rollbackRevision?.sourceCommitSha ?? stack.sourceCommitSha,
          renderedYamlEnc: encryptSecretField(rendered.renderedYaml)!,
          renderedDigest: rendered.renderedDigest,
          renderedYamlRedacted: redactRenderedStackYaml(rendered.renderedYaml),
          overrideYamlRedacted: rollbackRevision?.overrideYamlRedacted ?? redactRenderedStackYaml(rendered.overrideYaml),
          manifest: rollbackRevision
            ? {
                ...rollbackRevision.manifest,
                routingMode,
                rollback: {
                  sourceRevisionId: rollbackRevision.id,
                  sourceDeploymentId: rollback!.sourceDeploymentId,
                },
              }
            : {
                services: resolvedSource.services,
                networks: resolvedSource.networks,
                volumes: resolvedSource.volumes,
                configs: resolvedSource.configs,
                secrets: resolvedSource.secrets,
                resourceIdentities: swarmResourceIdentities(rendered.renderedYaml, stack.stackName).map((resource) => ({
                  kind: resource.kind,
                  logicalName: resource.logicalName,
                  effectiveName: resource.effectiveName,
                  external: resource.external,
                  driver: resource.driver,
                })),
                managedResources: managedResources.map(({ kind, logicalName, resourceName, contentDigest }) => ({
                  kind,
                  logicalName,
                  resourceName,
                  contentDigest,
                })),
                externalResources: externalSwarmResourceConsumers(rendered.renderedYaml).filter((resource) =>
                  !managedResources.some((managed) => managed.kind === resource.kind && managed.resourceName === resource.name),
                ),
                routingMode,
                compatibility,
                prune,
                pruneRemovals: prunePlan.removals,
              },
          serviceImages: rollbackRevision
            ? rollbackRevision.serviceImages
            : Object.fromEntries(
                resolvedSource.services.flatMap((service) =>
                  service.image ? [[service.sourceServiceName, service.image]] : [],
                ),
              ),
          configRefs: rollbackRevision?.configRefs ?? referencedSwarmResourceRefs(rendered.renderedYaml).configs,
          secretRefs: rollbackRevision?.secretRefs ?? referencedSwarmResourceRefs(rendered.renderedYaml).secrets,
          applyStatus: "applying",
        });
        if (!createdRevision) {
          throw new AppError(
            "The Swarm stack binding is no longer available.",
            409,
            "SWARM_STACK_REQUIRED",
          );
        }
        revision = createdRevision;
      } catch (error) {
        if (platform.executor) await removeNewManagedSwarmResources(platform.executor, newlyCreatedManagedResources);
        throw error;
      }

      const runtimeRef: RuntimeWorkloadRef = {
        kind: "swarm-stack",
        clusterId: stack.clusterId,
        managerServerId: stack.managerServerId,
        stackName: stack.stackName,
        revisionId: revision.id,
      };
      logger.step(
        "swarm-deploy",
        "started",
        `Applying stack ${stack.stackName} on its Swarm manager`,
      );
      let dockerStackDeployOutput = "";
      try {
        const result = await platform.stackRuntime.deployStack({
          stackName: stack.stackName,
          renderedYaml: rendered.renderedYaml,
          prune,
          resolveImage: "always",
          withRegistryAuth: !!registryAuth,
          ...(registryAuth ? { registryAuth } : {}),
        });
        dockerStackDeployOutput = safeDeployOutput(result.output, environment);
        if (dockerStackDeployOutput)
          logger.log(
            dockerStackDeployOutput.endsWith("\n")
              ? dockerStackDeployOutput
              : `${dockerStackDeployOutput}\n`,
          );
        await deps.updateRevision(revision.id, deployment.organizationId, {
          applyStatus: "converging",
          applyOutput: {
            dockerStackDeploy: dockerStackDeployOutput,
            prune,
            pruneRemovals: prunePlan.removals,
          },
          appliedAt: deps.now(),
        });
      } catch (error) {
        if (isConnectionLoss(error)) {
          await deps
            .updateRevision(revision.id, deployment.organizationId, {
              applyStatus: "converging",
              applyOutput: {
                warning:
                  "Manager connection dropped while Docker was applying the stack; reconciliation is required.",
              },
            })
            .catch(() => {});
          return {
            runtimeRef,
            revisionId: revision.id,
            state: "reconciling",
            warningMessage:
              "Manager connection dropped during stack deploy — verifying the live stack without rollback.",
          };
        }
        await deps
          .updateRevision(revision.id, deployment.organizationId, {
            applyStatus: "failed",
            applyOutput: { error: safeDeployError(error, environment) },
          })
          .catch(() => {});
        throw error;
      }

      let convergence: Awaited<ReturnType<typeof deps.waitForConvergence>>;
      try {
        convergence = await deps.waitForConvergence({
          runtime: platform.stackRuntime,
          stackName: stack.stackName,
          logger,
        });
      } catch (error) {
        if (!isConnectionLoss(error)) throw error;
        await deps
          .updateRevision(revision.id, deployment.organizationId, {
            applyStatus: "converging",
            applyOutput: {
              warning: "Manager connection dropped after stack deploy; reconciliation is required.",
            },
          })
          .catch(() => {});
        return {
          runtimeRef,
          revisionId: revision.id,
          state: "reconciling",
          warningMessage:
            "Manager connection dropped after stack deploy — verifying the live stack without rollback.",
        };
      }
      if (convergence.status === "unreachable" || !convergence.snapshot) {
        await deps
          .updateRevision(revision.id, deployment.organizationId, {
            applyStatus: "converging",
            applyOutput: {
              warning: "Manager became unreachable while stack convergence was being verified.",
            },
          })
          .catch(() => {});
        return {
          runtimeRef,
          revisionId: revision.id,
          state: "reconciling",
          warningMessage: "Manager became unreachable while stack convergence was being verified.",
        };
      }
      const after = convergence.snapshot;
      if (after.manager.clusterId !== stack.clusterId) {
        throw new AppError(
          "The configured manager changed Swarm clusters during deployment.",
          409,
          "SWARM_CLUSTER_MISMATCH",
        );
      }
      const live = stackServices(after, stack.stackName);
      const missing = resolvedSource.services
        .map((service) => service.sourceServiceName)
        .filter((name) => !live.some((service) => service.sourceServiceName === name));
      const unlabeled = live.filter((service) => !isOwnedService(service, stack));
      if (missing.length > 0 || unlabeled.length > 0) {
        await deps.updateRevision(revision.id, deployment.organizationId, {
          applyStatus: "converging",
          applyOutput: {
            warning: "Manager did not yet report the expected managed services.",
            missingServices: missing,
          },
        });
        return {
          runtimeRef,
          revisionId: revision.id,
          state: "reconciling",
          warningMessage:
            "Stack apply completed, but the manager has not yet reported the expected managed services.",
        };
      }
      const health =
        convergence.health ??
        deriveSwarmStackHealth({ stackName: stack.stackName, services: live, tasks: after.tasks });
      if (convergence.status === "failed") {
        const reason =
          health.diagnostics.join("; ") || "one or more Swarm services failed to converge";
        await deps.updateRevision(revision.id, deployment.organizationId, {
          applyStatus: "failed",
          applyOutput: {
            dockerStackDeploy: dockerStackDeployOutput,
            prune,
            pruneRemovals: prunePlan.removals,
            health,
          },
        });
        throw new AppError(
          `Swarm stack failed to converge: ${reason}`,
          502,
          "SWARM_CONVERGENCE_FAILED",
        );
      }
      const refs = serviceRefs(stack, live);
      const serviceRows = await deps.syncProjections(
        project.id,
        live.map((service) => ({
          ...projection(service),
          sourceDigest: rendered.renderedDigest,
        })),
      );
      const routingWarnings: string[] = [];
      if (routingMode === "openship-edge") {
        // Service rows retain operator-controlled exposed/domain fields while
        // projections update manager facts. Re-read all rows so a source service
        // removed by this apply can have its old vhost removed too.
        const allServiceRows = await deps.listServices(project.id);
        let domainRows = await deps.listDomains(project.id);
        let routePlan = planSwarmEdgeRoutes({
          project,
          stack: routeStack,
          services: allServiceRows,
          domains: domainRows,
        });
        const blockedDomains = new Set<string>();
        for (const route of routePlan.desired) {
          if (route.domainType !== "custom" || route.domainId) continue;
          try {
            await deps.ensurePendingDomain({
              projectId: project.id,
              serviceId: route.serviceId,
              hostname: route.input.domain,
              targetPort: route.input.port,
            });
          } catch (error) {
            blockedDomains.add(route.input.domain.toLowerCase());
            routingWarnings.push(
              `${route.input.domain}: ${safeDeployError(error, environment)}`,
            );
          }
        }
        if (routePlan.desired.some((route) => route.domainType === "custom" && !route.domainId)) {
          domainRows = await deps.listDomains(project.id);
          routePlan = planSwarmEdgeRoutes({
            project,
        stack: routeStack,
            services: allServiceRows,
            domains: domainRows,
          });
        }
        if (!platform.executor) {
          if (routePlan.desired.length > 0 || routePlan.retiredDomains.length > 0) {
            routingWarnings.push("OpenShip Edge route reconciliation requires a manager command transport.");
          }
        } else {
          const reconciliation = await reconcileSwarmEdgeRoutes({
            executor: platform.executor,
            plan: {
              ...routePlan,
              desired: routePlan.desired.filter((route) => !blockedDomains.has(route.input.domain.toLowerCase())),
            },
          });
          routingWarnings.push(...reconciliation.warnings);
          for (const issued of reconciliation.issued) {
            try {
              await deps.markDomainTlsActive(issued.domainId, issued.certificate);
            } catch (error) {
              routingWarnings.push(
                `${issued.certificate.domain}: certificate was issued but OpenShip could not persist its domain status: ${safeDeployError(error, environment)}`,
              );
            }
          }
        }
        if (routingWarnings.length > 0) {
          logger.log(
            `→ Swarm Edge routes need attention: ${routingWarnings.join("; ")}\n`,
            "warn",
          );
        }
      }
      const finishedAt = deps.now();
      const ready = convergence.status === "ready" && health.state === "ready";
      const serviceDeploymentRows = serviceRows.flatMap((service) => {
          const ref = refs[service.sourceServiceName ?? ""];
          return ref
            ? [
                {
                  deploymentId: deployment.id,
                  serviceId: service.id,
                  serviceName: service.name,
                  runtimeRef: ref,
                  status: ready ? ("success" as const) : ("in_progress" as const),
                  imageRef:
                    live.find(
                      (candidate) => candidate.sourceServiceName === service.sourceServiceName,
                    )?.image ?? null,
                  startedAt,
                  ...(ready
                    ? {
                        finishedAt,
                        durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
                      }
                    : {}),
                },
              ]
            : [];
        });
      await deps.createServiceDeployments(
        serviceDeploymentRows.filter((row) => !sourceBuiltServiceNames.has(row.serviceName)),
      );
      await Promise.all(
        serviceDeploymentRows
          .filter((row) => sourceBuiltServiceNames.has(row.serviceName))
          .map((row) => deps.upsertServiceDeployment(row)),
      );
      await deps.updateRevision(revision.id, deployment.organizationId, {
        applyStatus: ready ? "ready" : "converging",
        applyOutput: {
          dockerStackDeploy: dockerStackDeployOutput,
          prune,
          pruneRemovals: prunePlan.removals,
          health,
          ...(routingWarnings.length ? { routingWarnings } : {}),
        },
        serviceRefs: refs,
        ...(ready ? { convergedAt: finishedAt } : {}),
      });
      await deps.updateStack(stack.id, deployment.organizationId, {
        managementMode: "managed",
        sourceStatus: "valid",
        routingMode,
        lastAppliedRevisionId: revision.id,
        lastObservedDigest: swarmLiveStateDigest(live),
        lastObservedAt: finishedAt,
        observedState: observedState(live),
        driftStatus: ready ? "clean" : "unknown",
        driftDetails: ready
          ? {}
          : { summary: "Stack apply accepted; services are still converging." },
      });
      if (!ready) {
        return {
          runtimeRef,
          revisionId: revision.id,
          state: "reconciling",
          warningMessage: "Stack apply was accepted; waiting for Swarm services to converge.",
        };
      }
      logger.step("swarm-deploy", "completed", `Stack ${stack.stackName} converged on the manager`);
      return {
        runtimeRef,
        revisionId: revision.id,
        state: "ready",
        ...(routingWarnings.length
          ? {
              warningMessage:
                `Some domains aren't routed yet — the stack is running; fix DNS/routing and retry: ${routingWarnings.join("; ")}`,
            }
          : {}),
      };
    },
  };
}

export const swarmDeploy = createSwarmDeployService();
