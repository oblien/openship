/**
 * Managed Docker Swarm stack deployment.
 *
 * This is intentionally separate from the container/Compose pipeline: a stack
 * has one durable workload identity and its services are scheduler-owned, so
 * none of the container lifecycle calls are valid here.
 */

import {
  BuildLogger,
  DEFAULT_BUILD_RESOURCE_CONFIG,
  DockerRuntime,
  deriveSwarmStackHealth,
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
import { evaluateSwarmCompatibility } from "../../swarm/swarm-compatibility";
import { redactRenderedStackYaml, swarmLiveStateDigest } from "../../swarm/swarm-preview";
import { projectSwarmStackSource } from "../../swarm/swarm-stack-projection";
import { resolveStackSourceFiles, type ResolvedSwarmStackSource } from "../../swarm/swarm-source.service";
import { swarmConvergence } from "./convergence.service";

type SwarmPlatform = Pick<Platform, "runtime" | "stackRuntime">;

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
  syncProjections: (projectId: string, projections: SwarmServiceProjection[]) => Promise<Service[]>;
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
}): Promise<Record<string, string>> {
  const buildable = input.services.flatMap((service) => {
    const build = sourceBuildDefinition(service);
    return build ? [{ service, build }] : [];
  });
  if (buildable.length === 0) return {};
  if (!input.registry) {
    throw new AppError(
      "This stack has source-built services. Select an OCI registry before applying it.",
      409,
      "SWARM_BUILD_REGISTRY_REQUIRED",
    );
  }
  if (!(input.runtime instanceof DockerRuntime)) {
    throw new AppError(
      "The selected Swarm manager cannot build and publish source services through Docker.",
      503,
      "SWARM_BUILD_RUNTIME_UNAVAILABLE",
    );
  }
  if (input.stack.sourceKind !== "repository" || !input.project.gitOwner || !input.project.gitRepo) {
    throw new AppError(
      "Source-built services require a linked repository stack source so OpenShip can use its bounded build context.",
      409,
      "SWARM_BUILD_REPOSITORY_REQUIRED",
    );
  }
  const owner = await resolveOrgOwner(input.deployment.organizationId);
  if (!owner) {
    throw new AppError("The organization owner is unavailable to prepare the source build.", 503, "SWARM_SOURCE_REPOSITORY_UNAVAILABLE");
  }
  const git = await resolveBuildGitToken({
    ctx: buildBackgroundContext({ userId: owner.userId, organizationId: input.deployment.organizationId, label: "swarm:source-build" }),
    projectId: input.project.id,
    owner: input.project.gitOwner,
    repo: input.project.gitRepo,
    buildStrategy: "local",
  });
  const repository = [
    input.registry.registryUrl,
    ...(input.registry.repositoryPrefix ? [input.registry.repositoryPrefix] : []),
    imageSegment(input.project.slug, "project"),
  ].join("/");
  const selected = selectSourceBuilds({
    stack: input.stack,
    deployment: input.deployment,
    buildable,
    previousImages: input.previousImages,
  });
  const overrides: Record<string, string> = { ...selected.preserved };
  for (const serviceName of Object.keys(selected.preserved)) {
    input.logger.log(`Reusing immutable registry digest for unchanged service ${serviceName}\n`);
  }
  for (const { service, build } of selected.build) {
    const serviceName = imageSegment(service.sourceServiceName, "service");
    const target = `${repository}/${serviceName}:${imageSegment(input.deployment.id, "deployment")}`;
    input.logger.step("swarm-build", "started", `Building and publishing ${service.sourceServiceName}`);
    const buildLogger = new BuildLogger((entry) => {
      input.logger.log(entry.message, entry.level === "error" ? "error" : entry.level === "warn" ? "warn" : "info");
    });
    let result: Awaited<ReturnType<DockerRuntime["build"]>>;
    try {
      result = await input.runtime.build({
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
      }, buildLogger);
    } catch {
      input.logger.step("swarm-build", "failed", `Could not build ${service.sourceServiceName}`);
      throw new AppError(`Could not build source service ${service.sourceServiceName}.`, 502, "SWARM_BUILD_FAILED");
    }
    if (result.status !== "deploying" || !result.imageRef) {
      input.logger.step("swarm-build", "failed", `Could not build ${service.sourceServiceName}`);
      throw new AppError(`Could not build source service ${service.sourceServiceName}.`, 502, "SWARM_BUILD_FAILED");
    }
    try {
      const published = await input.runtime.publishImage({
        source: result.imageRef,
        target,
        ...(input.registryAuth ? { auth: input.registryAuth } : {}),
        onProgress: (message) => input.logger.log(message),
      });
      overrides[service.sourceServiceName] = published.digestRef;
      input.logger.step("swarm-build", "completed", `Published ${service.sourceServiceName} as an immutable registry digest`);
    } catch {
      input.logger.step("swarm-build", "failed", `Could not publish ${service.sourceServiceName}`);
      throw new AppError(`Could not publish source service ${service.sourceServiceName} to the configured registry.`, 502, "SWARM_IMAGE_PUBLISH_FAILED");
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
    syncProjections: (projectId, projections) =>
      repos.service.syncSwarmProjections(projectId, projections),
    createServiceDeployments: (rows) => repos.serviceDeployment.bulkCreate(rows),
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
      const sourceMaterial = await deps.loadSource(stack, project, deployment.organizationId);
      const source = projectSwarmStackSource(sourceMaterial.files);
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
      const imageOverrides = await publishSourceBuilds({
        stack,
        project,
        deployment,
        services: source.services,
        registry,
        registryAuth,
        previousImages: previousRevision?.serviceImages ?? {},
        runtime: platform.runtime,
        logger,
      });
      const rendered = await platform.stackRuntime.renderStack({
        files: sourceMaterial.files,
        composePaths: sourceMaterial.composePaths,
        environment,
        ownershipLabels: ownership,
        imageOverrides,
      });
      const resolvedSource = projectSwarmStackSource([
        { path: "rendered-stack.yaml", content: rendered.renderedYaml },
      ]);
      const compatibility = evaluateSwarmCompatibility({
        renderedYaml: rendered.renderedYaml,
        discovery: before,
        registryConfigured: !!registry,
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
      const prunePlan = claimPending
        ? { prune: false, removals: [] }
        : safePrunePlan(
            stack,
            current,
            new Set(resolvedSource.services.map((service) => service.sourceServiceName)),
          );
      const prune = prunePlan.prune;
      if (prunePlan.removals.length > 0) {
        logger.log(`→ Confirmed managed-service prune: ${prunePlan.removals.join(", ")}\n`, "warn");
      }
      logger.step(
        "swarm-render",
        "completed",
        "Rendered and validated the authoritative Swarm stack configuration",
      );

      const startedAt = deps.now();
      const revision = await deps.createRevision(stack.id, deployment.organizationId, {
        sourceDigest: stack.sourceDigest,
        sourceCommitSha: stack.sourceCommitSha,
        renderedYamlEnc: encryptSecretField(rendered.renderedYaml)!,
        renderedDigest: rendered.renderedDigest,
        renderedYamlRedacted: redactRenderedStackYaml(rendered.renderedYaml),
        overrideYamlRedacted: redactRenderedStackYaml(rendered.overrideYaml),
        manifest: {
          services: resolvedSource.services,
          networks: resolvedSource.networks,
          volumes: resolvedSource.volumes,
          configs: resolvedSource.configs,
          secrets: resolvedSource.secrets,
          compatibility,
          prune,
          pruneRemovals: prunePlan.removals,
        },
        serviceImages: Object.fromEntries(
          resolvedSource.services.flatMap((service) =>
            service.image ? [[service.sourceServiceName, service.image]] : [],
          ),
        ),
        configRefs: resolvedSource.configs,
        secretRefs: resolvedSource.secrets,
        applyStatus: "applying",
      });
      if (!revision)
        throw new AppError(
          "The Swarm stack binding is no longer available.",
          409,
          "SWARM_STACK_REQUIRED",
        );

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
      const finishedAt = deps.now();
      const ready = convergence.status === "ready" && health.state === "ready";
      await deps.createServiceDeployments(
        serviceRows.flatMap((service) => {
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
        }),
      );
      await deps.updateRevision(revision.id, deployment.organizationId, {
        applyStatus: ready ? "ready" : "converging",
        applyOutput: {
          dockerStackDeploy: dockerStackDeployOutput,
          prune,
          pruneRemovals: prunePlan.removals,
          health,
        },
        serviceRefs: refs,
        ...(ready ? { convergedAt: finishedAt } : {}),
      });
      await deps.updateStack(stack.id, deployment.organizationId, {
        managementMode: "managed",
        sourceStatus: "valid",
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
      return { runtimeRef, revisionId: revision.id, state: "ready" };
    },
  };
}

export const swarmDeploy = createSwarmDeployService();
