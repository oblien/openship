import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { managedNodeEnvironment } from "./node-listener";
import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { Oblien } from "oblien";
import { AppError, SYSTEM, safeErrorMessage, isHostPathSource } from "@repo/core";
import { DockerRuntime } from "../docker";
import { imageVolumeName } from "../docker-image-volumes";
import { BareRuntime } from "../bare";
import { CloudServerConnection } from "./server-connection";
import { CloudProcessSupervisor } from "./process-supervisor";
import { managedProjectRoutingScope, type ManagedContainerRouteTargets } from "./routing-scope";
import type { CloudProjectRoutingScope } from "../../infra/cloud";
import { BuildLogger, sq } from "../build-pipeline";
import type {
  BuildConfig,
  ContainerInfo,
  DeployConfig,
  LogCallback,
  ProvisionLock,
  RouteConfig,
} from "../../types";
import type { DockerRegistryAuth } from "../docker-auth";
import type {
  MultiServiceDeployConfig,
  MultiServiceDeployResult,
  MultiServiceGroupHandle,
  RuntimeCapability,
} from "../types";
import { CloudWorkspaceExecutor } from "./workspace-executor";
import { CLOUD_DOCKER_BRIDGE_PORT } from "./docker-bridge-source";
import {
  assertDockerWorkspaceOwner,
  assertCloudWorkspaceRunning,
  cloudWorkspaceStatus,
  isDockerWorkspaceRunning,
  waitForCloudDockerWorkspace,
} from "./workspace-ready";
import { cloudDockerProjectPaths } from "./docker-paths";
import { ensureCloudProjectVolume, resolveCloudProjectVolumeName } from "./docker-volume";
import { prepareRemoteSource } from "../remote-source";
import { pickHostPort } from "../host-port";
import { scanPorts } from "../../system/port-scan";
export { CLOUD_SERVER_IMAGE as CLOUD_DOCKER_IMAGE } from "./server-connection";
export { CLOUD_DOCKER_ROUTE_ROOT } from "./docker-paths";
export interface CloudDockerOptions {
  workspaceId: string;
  projectId: string;
  /** Organization-validated subscription owner of the managed server. */
  ownerWorkspaceId: string;
  namespace: string;
  /** Provider-authorized domain; production uses Openship's configured domain. */
  publicDomain?: string;
  beforeProvision?: () => Promise<void>;
  /** Explicit opt-in for a desktop/self-hosted source transfer; SaaS denies it. */
  allowHostSource?: boolean;
  provisionLock: ProvisionLock;
  buildCacheProtection?: import("../docker").DockerConnectionOptions["buildCacheProtection"];
  bridgeLock?: ProvisionLock;
  resolveRegistryAuth: (ref: string) => Promise<DockerRegistryAuth | undefined>;
}
function notFound(error: unknown): boolean {
  const e = error as {
    status?: number;
    statusCode?: number;
  };
  return e?.status === 404 || e?.statusCode === 404;
}
/** Docker semantics on a single permanent Oblien workspace. Resource identity
 * stays explicit: container IDs identify containers; workspaceId identifies the
 * shared host. Inherited retention/rollback never stop or delete that host. */
export class CloudDockerRuntime extends DockerRuntime {
  // Managed cloud refuses role containers for now; every other Docker capability is kept.
  override readonly capabilities: ReadonlySet<RuntimeCapability> = new Set(
    DockerRuntime.CAPABILITIES.filter(cap => cap !== "roles"),
  );
  readonly workspaceId: string;
  readonly projectId: string;
  readonly executor: CloudWorkspaceExecutor;
  readonly connection: CloudServerConnection;
  private sourcePath?: string;
  private sourceBase?: string;
  private sourcePromise?: Promise<void>;
  private constructor(
    private readonly client: Oblien,
    private readonly options: CloudDockerOptions,
  ) {
    const connection = new CloudServerConnection(client, options);
    const executor = connection.executor;
    super(
      {
        transport: "cloud",
        executor,
        cloudConnection: () => connection.connectDocker(),
        resolveRegistryAuth: options.resolveRegistryAuth,
        buildCacheProtection: options.buildCacheProtection,
      },
      null,
      options.provisionLock,
    );
    this.workspaceId = options.workspaceId;
    this.projectId = options.projectId;
    this.executor = executor;
    this.connection = connection;
  }
  static async forWorkspace(
    client: Oblien,
    options: CloudDockerOptions,
  ): Promise<CloudDockerRuntime> {
    if (
      !options.namespace ||
      !options.workspaceId ||
      !options.projectId ||
      !options.ownerWorkspaceId
    )
      throw new Error("Cloud Docker requires a project and an owned workspace");
    const runtime = new CloudDockerRuntime(client, options);
    try {
      await runtime.initializeDocker();
      return runtime;
    } catch (error) {
      await runtime.dispose();
      throw error;
    }
  }
  private assertProject(projectId: string): void {
    if (projectId !== this.projectId)
      throw new Error("Docker workspace belongs to a different project");
  }
  private async inspectOwnedContainer(containerId: string) {
    let container;
    try {
      container = await this.docker.getContainer(containerId).inspect();
    } catch (error) {
      if (notFound(error)) return null;
      throw error;
    }
    if (container.Config?.Labels?.["openship.project"] !== this.projectId) {
      throw new AppError("Container does not belong to this project", 404, "CONTAINER_NOT_FOUND");
    }
    return container;
  }
  protected override async assertContainerAccess(containerId: string): Promise<void> {
    await this.inspectOwnedContainer(containerId);
  }
  protected override networkLabels(slug: string): Record<string, string> {
    return { ...super.networkLabels(slug), ...{ "openship.project": this.projectId } };
  }
  protected override containerLabelFilters() {
    return [`openship.project=${this.projectId}`];
  }
  override async assertBackupAccess(
    projectId: string,
    input: {
      containerId?: string | null;
      sources?: readonly string[];
    },
  ) {
    this.assertProject(projectId);
    if (input.containerId) await this.assertContainerAccess(input.containerId);
    for (const source of input.sources ?? []) {
      if (isHostPathSource(source)) {
        if (
          !posix.isAbsolute(source) ||
          !posix.resolve(source).startsWith(`${this.projectPaths.mounts}/`)
        )
          throw new AppError(
            "Backup source does not belong to this project",
            403,
            "CLOUD_STORAGE_FORBIDDEN",
          );
        const path = (await this.executor.exec(`readlink -f -- ${sq(source)}`)).trim();
        if (!path.startsWith(`${this.projectPaths.mounts}/`))
          throw new AppError(
            "Backup source escapes this project's storage",
            403,
            "CLOUD_STORAGE_FORBIDDEN",
          );
      } else {
        const volume = await this.docker.getVolume(source).inspect();
        if (volume.Labels?.["openship.project"] !== this.projectId)
          throw new AppError(
            "Backup volume does not belong to this project",
            403,
            "CLOUD_STORAGE_FORBIDDEN",
          );
      }
    }
  }
  override async ensureNetwork(slug: string, signal?: AbortSignal) {
    const id = await super.ensureNetwork(slug, signal);
    const info = await this.docker.getNetwork(id).inspect();
    if (info.Labels?.["openship.project"] !== this.projectId)
      throw new AppError("Network belongs to another project", 409, "CLOUD_NETWORK_CONFLICT");
    return id;
  }
  override async removeNetwork(slug: string) {
    return this.removeScopedNetwork(slug, "strict");
  }
  /** A slug retained after migration can now name another project's network.
   * Cleanup leaves a proven foreign owner alone; unknown ownership still fails. */
  async removeProjectNetwork(slug: string): Promise<void> {
    return this.removeScopedNetwork(slug, "project-cleanup");
  }
  private async removeScopedNetwork(
    slug: string,
    mode: "strict" | "project-cleanup",
  ): Promise<void> {
    return this.options.provisionLock.run(async () => {
      try {
        const network = await this.docker.getNetwork(`openship-${slug}`).inspect();
        const owner = network.Labels?.["openship.project"];
        if (owner !== this.projectId) {
          if (
            mode === "project-cleanup" &&
            typeof owner === "string" &&
            owner.length > 0 &&
            owner.trim() === owner
          )
            return;
          throw new AppError("Network belongs to another project", 409, "CLOUD_NETWORK_CONFLICT");
        }
        if (typeof network.Id !== "string" || !/^[a-f0-9]{64}$/.test(network.Id))
          throw new AppError(
            "Could not verify the network identity",
            409,
            "CLOUD_NETWORK_CONFLICT",
          );
        // Network names are reusable. Removing the inspected ID cannot target a
        // replacement created with the same name after the ownership read.
        await this.docker.getNetwork(network.Id).remove();
      } catch (error) {
        if (notFound(error)) return;
        throw error;
      }
    });
  }
  override async listProjectContainerIds(id: string) {
    this.assertProject(id);
    return super.listProjectContainerIds(id);
  }
  override async listProjectImages(id: string) {
    this.assertProject(id);
    return super.listProjectImages(id);
  }
  override async listDeploymentContainers(id: string) {
    const containers = await super.listDeploymentContainers(id);
    const owned = new Set(await this.listProjectContainerIds(this.projectId));
    return containers.filter((container) => owned.has(container.containerId));
  }
  private async accessibleImage(ref: string) {
    const image = await this.docker.getImage(ref).inspect();
    const owner = image.Config?.Labels?.["openship.project"];
    if (owner && owner !== this.projectId)
      throw new AppError("Image belongs to another project", 404, "IMAGE_NOT_FOUND");
    return image;
  }
  protected override async inspectDeploymentImage(ref: string) {
    return this.accessibleImage(ref);
  }
  override async removeImage(ref: string) {
    try {
      if ((await this.accessibleImage(ref)).Config?.Labels?.["openship.project"] !== this.projectId)
        return;
    } catch (error) {
      if (notFound(error)) return;
      throw error;
    }
    return super.removeImage(ref);
  }
  override async saveImage(...args: Parameters<DockerRuntime["saveImage"]>) {
    await this.accessibleImage(args[0]);
    return super.saveImage(...args);
  }
  override async inspectImageEnv(...args: Parameters<DockerRuntime["inspectImageEnv"]>) {
    try {
      await this.accessibleImage(args[0]);
    } catch (error) {
      if (error instanceof AppError || !notFound(error)) throw error;
    }
    return super.inspectImageEnv(...args);
  }
  override async inspectImageCmd(ref: string) {
    await this.accessibleImage(ref);
    return super.inspectImageCmd(ref);
  }
  override async tagImage(source: string, target: string) {
    await this.accessibleImage(source);
    try {
      await this.accessibleImage(target);
    } catch (error) {
      if (error instanceof AppError || !notFound(error)) throw error;
    }
    return super.tagImage(source, target);
  }
  override async publishImage(...args: Parameters<DockerRuntime["publishImage"]>) {
    await this.accessibleImage(args[0]);
    return super.publishImage(...args);
  }
  override async joinServiceGroupContainers(
    ...args: Parameters<DockerRuntime["joinServiceGroupContainers"]>
  ) {
    for (const member of args[1]) await this.assertContainerAccess(member.containerId);
    return super.joinServiceGroupContainers(...args);
  }
  override async leaveServiceGroupContainers(
    ...args: Parameters<DockerRuntime["leaveServiceGroupContainers"]>
  ) {
    for (const id of args[1]) await this.assertContainerAccess(id);
    return super.leaveServiceGroupContainers(...args);
  }
  override async attachToExternalNetworks(
    ...args: Parameters<DockerRuntime["attachToExternalNetworks"]>
  ) {
    this.assertProject(args[0]);
    for (const id of [...(args[2] ?? []), ...(args[3]?.onlyContainerIds ?? [])])
      await this.assertContainerAccess(id);
    return super.attachToExternalNetworks(...args);
  }
  override async listAllVolumes() {
    const volumes = await super.listAllVolumes();
    return volumes.filter((volume) => volume.labels["openship.project"] === this.projectId);
  }
  override async listAllNetworks() {
    const networks = await super.listAllNetworks();
    return networks.filter((network) => network.labels["openship.project"] === this.projectId);
  }
  override async removeVolume(name: string) {
    try {
      const volume = await this.docker.getVolume(name).inspect();
      if (volume.Labels?.["openship.project"] !== this.projectId)
        throw new AppError("Volume belongs to another project", 409, "CLOUD_VOLUME_CONFLICT");
    } catch (error) {
      if (notFound(error)) return;
      throw error;
    }
    return super.removeVolume(name);
  }
  private async ownedVolumeBinds(slug: string, volumes: string[]) {
    const scoped: string[] = [];
    for (const spec of volumes) {
      const parts = spec.split(":");
      if (parts.length > 1 && !isHostPathSource(parts[0]!)) {
        parts[0] = await resolveCloudProjectVolumeName(
          this.docker,
          this.projectId,
          slug,
          parts[0]!,
        );
        await ensureCloudProjectVolume(this.docker, parts[0], this.projectId);
      }
      scoped.push(parts.join(":"));
    }
    return scoped;
  }
  protected override async serviceVolumeBinds(config: MultiServiceDeployConfig): Promise<string[]> {
    this.assertProject(config.projectId);
    // Cloud has already resolved and verified the concrete names. Reapplying a
    // slug prefix here would mount a different, unclaimed empty volume.
    return config.volumes;
  }
  private async canSpend(): Promise<void> {
    await this.connection.beforeWork();
  }
  private get publicDomain(): string {
    return this.options.publicDomain ?? SYSTEM.DOMAINS.CLOUD_DOMAIN;
  }
  private get projectPaths() {
    return cloudDockerProjectPaths(this.projectId);
  }
  /** Acquire source once, on the workspace. Also serves image-only Compose
   * stacks whose relative bind mounts need repository files. */
  async prepareComposeSource(config: BuildConfig, logger = new BuildLogger()): Promise<void> {
    this.assertProject(config.projectId);
    if (config.localPath && !this.options.allowHostSource)
      throw new Error("Cloud builds cannot read source paths on the control-plane host");
    // Image-only deploys have no checkout. In particular, don't cache an empty
    // tree before the compose builder supplies an inline catalog context.
    if (!config.inlineSourceFiles && !config.sourceTransfer && !config.localPath && !config.repoUrl)
      return;
    return (this.sourcePromise ??= (async () => {
      await this.canSpend();
      const source = `/tmp/openship-cloud-source-${createHash("sha256").update(config.sessionId).digest("hex").slice(0, 24)}`;
      await this.executor.mkdir(source);
      try {
        if (await prepareRemoteSource(this.connection, config, source, logger)) {
          // The source capability supplies already-authorized uploaded bytes.
        } else if (config.localPath) {
          await this.executor.transferIn(config.localPath, source, logger.callback);
        } else if (config.repoUrl) {
          await super.cloneSourceOnRemote(config, source, logger);
        }
        const base = posix.resolve(source, config.rootDirectory || ".");
        if (base !== source && !base.startsWith(`${source}/`))
          throw new Error("Compose source directory escapes the repository");
        this.sourcePath = source;
        this.sourceBase = base;
      } catch (error) {
        await this.executor.rm(source).catch((diagnosticFailure) => {
          observeCaughtError(diagnosticFailure, "adapters/runtime/cloud/docker");
        });
        throw error;
      }
    })().catch((error) => {
      this.sourcePromise = undefined;
      throw error;
    }));
  }
  protected override async cloneSourceOnRemote(
    config: BuildConfig,
    directory: string,
    logger: BuildLogger,
  ): Promise<void> {
    await this.prepareComposeSource(config, logger);
    await this.executor.exec(
      `mkdir -p ${sq(directory)} && cp -a ${sq(this.sourcePath!)}/. ${sq(directory)}/`,
    );
  }
  override async build(config: BuildConfig, logger?: BuildLogger) {
    this.assertProject(config.projectId);
    await this.canSpend();
    await this.prepareComposeSource(config, logger);
    return super.build(this.remoteBuild(config), logger);
  }
  override async buildImages(
    specs: Parameters<DockerRuntime["buildImages"]>[0],
    logger: BuildLogger,
  ) {
    for (const spec of specs) this.assertProject(spec.config.projectId);
    await this.canSpend();
    if (specs.length) await this.prepareComposeSource(specs[0]!.config, logger);
    return super.buildImages(
      specs.map((spec) => ({ ...spec, config: this.remoteBuild(spec.config) })),
      logger,
    );
  }
  /** Static output stays on the project-owned workspace tree until Pages exports it. */
  staticBuildPath(sessionId: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error("Invalid build session ID");
    return `${cloudDockerProjectPaths(this.projectId).bare}/.builds/${sessionId}`;
  }

  override async buildStaticToHost(config: BuildConfig, hostOutDir: string, logger?: BuildLogger) {
    this.assertProject(config.projectId);
    if (hostOutDir !== this.staticBuildPath(config.sessionId))
      throw new Error("Static build output must belong to this project's build session");
    const result = await super.buildStaticToHost(config, hostOutDir, logger);
    if (result.status !== "deploying") {
      const files = this.staticServeRuntime();
      try {
        await files.destroy(hostOutDir);
      } catch (error) {
        observeCaughtError(error, "adapters/runtime/cloud/docker");
        logger?.log(`Static build cleanup deferred: ${safeErrorMessage(error)}\n`, "warn");
      } finally {
        await files.dispose();
      }
    }
    return result;
  }

  staticServeRuntime(): BareRuntime {
    return new BareRuntime({
      projectId: this.projectId,
      workDir: cloudDockerProjectPaths(this.projectId).bare,
      executor: this.executor,
      allowHostBuild: false,
    });
  }

  private remoteBuild(config: BuildConfig): BuildConfig {
    // Repository commands must not run on the SaaS control plane. Inline/folder
    // sources are transferred; Git sources clone directly inside the workspace.
    return {
      ...config,
      cloneOnServer: true,
      managedNodeListener: true,
      localPath: undefined,
      staticExtractOnly: Boolean(config.isStatic && config.staticExtractOnly),
    };
  }
  protected override withDeploymentLock<T>(work: () => Promise<T>): Promise<T> {
    return this.options.provisionLock.run(work);
  }
  protected override async deploymentPorts(config: DeployConfig) {
    this.assertProject(config.projectId);
    const ports = config.portless
      ? []
      : [
          ...new Set([
            config.port,
            ...(config.publicEndpoints ?? []).map((endpoint) => endpoint.port ?? config.port),
          ]),
        ];
    if (ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535))
      throw new Error("Invalid cloud service port");
    const reserved = await this.occupiedHostPorts();
    const bindings: Array<{
      port: number;
      hostIp: string;
      hostPort: number;
    }> = [];
    for (const port of ports) {
      const hostPort = pickHostPort(reserved, {
        avoid: [CLOUD_DOCKER_BRIDGE_PORT],
        rangeStart: 30000,
        rangeEnd: 59999,
      });
      reserved.add(hostPort);
      bindings.push({ port, hostIp: "0.0.0.0", hostPort });
    }
    return bindings;
  }
  protected override async deploymentVolumeBinds(config: DeployConfig): Promise<string[]> {
    this.assertProject(config.projectId);
    const image = await this.accessibleImage(config.imageRef!);
    const volumes = await this.persistentMounts(
      {
        ...config,
        volumes: config.volumes ?? [],
        slug: config.slug || config.projectId,
        serviceName: config.networkAlias || "app",
      },
      Object.keys(image.Config?.Volumes ?? {}),
    );
    return this.ownedVolumeBinds(config.slug || config.projectId, volumes);
  }
  // Managed mounts are already resolved and ownership-checked by Cloud
  // activation. They never relied on Docker's anonymous-volume allocation.
  override async prepareDeploymentVolumes(_config: DeployConfig): Promise<void> {}
  override async prepareServiceVolumes(_config: MultiServiceDeployConfig): Promise<void> {}
  override async deploy(config: DeployConfig, onLog?: LogCallback) {
    this.assertProject(config.projectId);
    await this.canSpend();
    await this.connection.ensureDocker();
    // Even a single web app/worker gets a project network on a subscribed host.
    const image = await this.accessibleImage(config.imageRef!);
    const ports = config.portless
      ? []
      : [config.port, ...(config.publicEndpoints ?? []).flatMap((e) => (e.port ? [e.port] : []))];
    return super.deploy(
      {
        ...config,
        networkAlias: config.networkAlias || "app",
        envVars: managedNodeEnvironment(image.Config?.Labels, config.envVars ?? {}, ports),
      },
      onLog,
    );
  }
  override async ensureServiceGroup(config: Parameters<DockerRuntime["ensureServiceGroup"]>[0]) {
    this.assertProject(config.projectId);
    await this.canSpend();
    await this.connection.ensureDocker();
    return super.ensureServiceGroup(config);
  }
  /** Stopped containers still own their bindings. Docker's list endpoint omits
   * those ports, but allocating or validating routes must use the same inventory. */
  private async publishedContainers(projectOnly = false) {
    const containers = await this.docker.listContainers({
      all: true,
      ...(projectOnly ? { filters: { label: this.containerLabelFilters() } } : {}),
    });
    const reserved = await Promise.all(
      containers.map(async (container) => {
        if (container.State === "running") return container;
        try {
          const info = await this.docker.getContainer(container.Id).inspect();
          return {
            ...container,
            Ports: [
              ...container.Ports,
              ...Object.entries(info.HostConfig.PortBindings ?? {}).flatMap(([port, bindings]) =>
                (Array.isArray(bindings) ? bindings : []).map((binding: { HostPort: string }) => ({
                  PrivatePort: Number(port.split("/")[0]),
                  PublicPort: Number(binding.HostPort),
                  Type: port.split("/")[1] ?? "tcp",
                })),
              ),
            ],
          };
        } catch (error) {
          if (notFound(error)) return null;
          throw error;
        }
      }),
    );
    return reserved.filter(
      (container): container is NonNullable<typeof container> => container !== null,
    );
  }
  private async occupiedHostPorts(): Promise<Set<number>> {
    const [reserved, scan] = await Promise.all([
      this.connection.publishedPorts(),
      scanPorts(this.executor),
    ]);
    if (!scan.scanned)
      throw new Error("Could not read server listeners before publishing applications");
    return new Set([
      ...reserved,
      ...scan.listeners
        .filter((listener) => listener.proto === "tcp")
        .map((listener) => listener.port),
    ]);
  }
  override async deployServiceWorkload(
    group: MultiServiceGroupHandle,
    config: MultiServiceDeployConfig,
    onLog?: LogCallback,
  ): Promise<MultiServiceDeployResult> {
    this.assertProject(config.projectId);
    const network = await this.docker.getNetwork(group.id).inspect();
    if (network.Labels?.["openship.project"] !== this.projectId)
      throw new AppError("Network belongs to another project", 409, "CLOUD_NETWORK_CONFLICT");
    for (const mode of [config.namespaces?.network, config.namespaces?.pid]) {
      if (!mode || mode === "none") continue;
      if (!mode.startsWith("container:"))
        throw new Error("Shared Cloud workspaces do not expose host network or PID namespaces");
      await this.assertContainerAccess(mode.slice("container:".length));
    }
    await this.canSpend();
    await this.connection.ensureDocker();
    const endpoints =
      config.cloudEndpoints ??
      (config.expose && config.publicPort
        ? [
            {
              hostname: config.customDomain ?? `${config.publicSlug}.${this.publicDomain}`,
              port: config.publicPort,
              custom: Boolean(config.customDomain),
            },
          ]
        : []);
    // Port allocation and replacement share a workspace lock. This is separate
    // from bridge initialization, which must complete before entering the lock.
    return this.options.provisionLock.run(async () => {
      const ports = [
        ...new Set([
          ...endpoints.map((endpoint) => endpoint.port),
          ...(config.cloudProxyPorts ?? []),
        ]),
      ];
      if (ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535))
        throw new Error("Invalid cloud service port");
      const reserved = await this.publishedContainers();
      const used = await this.occupiedHostPorts();
      const previous = reserved.find(
        (container) =>
          container.Labels["openship.project"] === this.projectId &&
          container.Labels["openship.service"] === config.serviceName &&
          container.Names.includes(`/openship-${config.slug}-${config.serviceName}`),
      );
      const published = new Map<number, number>();
      for (const port of ports) {
        const prior = previous?.Ports.find(
          (binding) => binding.PrivatePort === port && binding.Type === "tcp",
        )?.PublicPort;
        const hostPort = pickHostPort(used, {
          preferred: prior,
          reuseOccupiedPreferred: !!prior,
          avoid: [CLOUD_DOCKER_BRIDGE_PORT],
          rangeStart: 30000,
          rangeEnd: 59999,
        });
        used.add(hostPort);
        published.set(port, hostPort);
      }
      // Internal database/worker ports remain on the project network. Only
      // approved public endpoints are published, with distinct workspace ports.
      if (!config.imageAlreadyPrepared)
        await this.pullImage(config.image, { force: config.forcePull });
      const image = await this.accessibleImage(config.image);
      const persistent = await this.persistentMounts(
        config,
        Object.keys(image.Config?.Volumes ?? {}),
      );
      const volumes = await this.ownedVolumeBinds(config.slug, persistent);
      const result = await super.deployServiceWorkload(
        group,
        {
          ...config,
          volumes,
          imageAlreadyPrepared: true,
          environment: managedNodeEnvironment(image.Config?.Labels, config.environment, [...published.keys()]),
          ...{ namespaceVolumes: true },
          ports: [...published].map(([port, hostPort]) => `0.0.0.0:${hostPort}:${port}`),
        },
        onLog,
      );
      return result;
    });
  }
  private async persistentMounts(
    config: Pick<MultiServiceDeployConfig, "volumes" | "slug" | "deploymentId" | "serviceName">,
    imageVolumes: string[],
  ): Promise<string[]> {
    const targets = new Set<string>();
    const volumes: string[] = [];
    for (const spec of config.volumes) {
      const parts = spec.split(":");
      if (parts.length === 1) {
        imageVolumes.push(parts[0]!);
        continue;
      }
      const [source, target] = parts as [string, string];
      if (
        posix.isAbsolute(source) &&
        !posix.resolve(source).startsWith(`${this.projectPaths.mounts}/`)
      ) {
        throw new Error(
          "Shared Cloud mounts must use named volumes or repository paths. Host paths and the Docker socket are not available.",
        );
      }
      targets.add(target);
      if (source.startsWith(".") || source.startsWith("~")) {
        if (!this.sourcePath || !this.sourceBase || source.startsWith("~"))
          throw new Error("A relative Compose mount needs repository or uploaded source");
        const from = posix.resolve(this.sourceBase, source);
        if (from !== this.sourcePath && !from.startsWith(`${this.sourcePath}/`))
          throw new Error("Compose mount escapes its source repository");
        if (await this.executor.exists(from)) {
          const resolved = (await this.executor.exec(`readlink -f -- ${sq(from)}`)).trim();
          if (resolved !== this.sourcePath && !resolved.startsWith(`${this.sourcePath}/`))
            throw new Error("Compose mount symlink escapes its source repository");
        }
        const readOnly = parts.slice(2).some((mode) => mode.split(",").includes("ro"));
        const key = createHash("sha256")
          .update(posix.relative(this.sourcePath, from))
          .digest("hex")
          .slice(0, 24);
        const release = createHash("sha256").update(config.deploymentId).digest("hex").slice(0, 24);
        const dest = `${this.projectPaths.mounts}/${readOnly ? `releases/${release}` : "data"}/${key}`;
        await this.executor.mkdir(posix.dirname(dest));
        // Writable relative mounts are initialized once, then retain application
        // data. Read-only configuration gets a release-specific copy.
        if (!(await this.executor.exists(dest))) {
          if (await this.executor.exists(from))
            await this.executor.exec(`cp -a ${sq(from)} ${sq(dest)}`);
          else if (!readOnly) await this.executor.mkdir(dest);
          else throw new Error(`Compose mount source is missing: ${source}`);
        }
        parts[0] = dest;
      }
      if (posix.isAbsolute(parts[0]!)) {
        if (!(await this.executor.exists(parts[0]!)))
          throw new Error(
            "This project's managed mount is missing. Use a named volume or a repository path for new storage.",
          );
        const resolved = (await this.executor.exec(`readlink -f -- ${sq(parts[0]!)}`)).trim();
        if (!resolved.startsWith(`${this.projectPaths.mounts}/`))
          throw new Error("Persistent mount escapes this project's storage");
      }
      volumes.push(parts.join(":"));
    }
    for (const target of new Set(imageVolumes)) {
      if (!target.startsWith("/")) throw new Error("Invalid anonymous volume destination");
      if (targets.has(target)) continue;
      volumes.push(`${imageVolumeName(config.serviceName, target)}:${target}`);
    }
    return volumes;
  }
  /** The infrastructure provider translates application targets to managed ingress. */
  routingScope(): CloudProjectRoutingScope {
    return managedProjectRoutingScope(this.connection, this.options, async () => this.containerRouteTargets());
  }
  containerRouteTargets(): ManagedContainerRouteTargets {
    const resolveTarget = async (containerId: string, port: number) => {
      const info = await this.getContainerInfo(containerId);
      const published = info.hostPortByContainerPort?.[port];
      if (!published) throw new Error(`Service port ${port} is not published on its server`);
      return published;
    };
    return {
      resolveTarget,
      resolveUrl: async (url) => {
        const target = new URL(url);
        const targetPort = Number(target.port || 80);
        if (["127.0.0.1", "localhost"].includes(target.hostname)) {
          const containers = await this.publishedContainers(true);
          const owned = containers.some(item => item.Labels["openship.project"] === this.projectId &&
            item.Ports.some(port => port.Type === "tcp" && port.PublicPort === targetPort));
          if (!owned) throw new Error("Published routing port does not belong to this project");
          return targetPort;
        }
        const container = (await this.listAllContainers()).find(item => item.ip === target.hostname);
        if (!container) throw new Error("Route target does not belong to this project's containers");
        return resolveTarget(container.id, targetPort);
      },
    };
  }
  override async listAllContainers() {
    const workspace = await this.client.workspaces.get(this.workspaceId);
    assertDockerWorkspaceOwner(workspace, this.options.namespace, this.workspaceId);
    assertCloudWorkspaceRunning(workspace);
    const containers = await super.listAllContainers();
    return containers.filter(
      (container) => container.labels["openship.project"] === this.projectId,
    );
  }
  override async getContainerInfo(containerId: string): Promise<ContainerInfo> {
    if (containerId === this.workspaceId)
      throw new Error("A Docker workspace is not a service container");
    let workspace;
    try {
      workspace = await this.client.workspaces.get(this.workspaceId);
    } catch (error) {
      if (notFound(error)) return { containerId, status: "missing" };
      throw error;
    }
    assertDockerWorkspaceOwner(workspace, this.options.namespace, this.workspaceId);
    if (!isDockerWorkspaceRunning(workspace)) {
      const status = cloudWorkspaceStatus(workspace);
      return {
        containerId,
        status: ["failed", "error"].includes(status)
          ? "failed"
          : ["starting", "creating", "provisioning", "resuming"].includes(status)
            ? "deploying"
            : "stopped",
      };
    }
    return super.getContainerInfo(containerId);
  }
  override async start(containerId: string) {
    if (containerId === this.workspaceId)
      throw new Error("A Docker workspace is not a service container");
    await this.connection.resume();
    try {
      return await super.start(containerId);
    } catch (error) {
      if (
        (
          error as {
            statusCode?: number;
          }
        ).statusCode !== 304
      )
        throw error;
    }
  }
  override async stop(containerId: string) {
    if (containerId === this.workspaceId)
      throw new Error("A Docker workspace is not a service container");
    const workspace = await this.client.workspaces.get(this.workspaceId);
    assertDockerWorkspaceOwner(workspace, this.options.namespace, this.workspaceId);
    if (!isDockerWorkspaceRunning(workspace)) return;
    return super.stop(containerId);
  }
  override async restart(containerId: string) {
    if (containerId === this.workspaceId)
      throw new Error("A Docker workspace is not a service container");
    await this.connection.resume();
    return super.restart(containerId);
  }
  override async applyEnvironment(...args: Parameters<DockerRuntime["applyEnvironment"]>) {
    this.assertProject(args[2].projectId);
    if (args[0] === this.workspaceId)
      throw new Error("A Docker workspace is not a service container");
    await this.connection.resume();
    await this.connection.ensureDocker();
    await this.assertContainerAccess(args[0]);
    const info = await this.docker.getContainer(args[0]).inspect();
    const ports = Object.entries(info.HostConfig.PortBindings ?? {}).flatMap(([key, bindings]) =>
      /^\d+\/tcp$/.test(key) && Array.isArray(bindings) && bindings.length
        ? [Number(key.split("/")[0])]
        : [],
    );
    return super.applyEnvironment(
      args[0],
      managedNodeEnvironment(info.Config.Labels, args[1], ports),
      args[2],
    );
  }
  override async pullImage(...args: Parameters<DockerRuntime["pullImage"]>) {
    await this.canSpend();
    return super.pullImage(...args);
  }
  override async destroy(containerId: string) {
    if (containerId === this.workspaceId)
      throw new Error("A project's containers cannot delete their Docker workspace");
    if (posix.isAbsolute(containerId))
      throw new Error("A managed Docker deployment must identify a container, not a host path");
    return this.options.provisionLock.run(async () => {
      const owned = await this.inspectOwnedContainer(containerId);
      if (!owned) return;
      // Docker accepts names and shortened IDs. Resolve once so ingress cleanup
      // and removal identify the same container even if its name is reused.
      await super.destroy(owned.Id);
    });
  }
  override async cleanupProject(
    projectId: string,
    options?: {
      wipeVolumes?: boolean;
    },
  ): Promise<void> {
    this.assertProject(projectId);
    if ((await this.listProjectContainerIds(projectId)).length)
      throw new Error("Remove the project's containers before cleaning its storage");
    await super.cleanupProject(projectId, options);
    if (options?.wipeVolumes) {
      // Include detached volumes left by interrupted deployments. Inventory is
      // label-scoped; retained data is removed only on the explicit wipe path.
      for (const volume of await this.listAllVolumes()) await this.removeVolume(volume.name);
      await this.executor.exec(`rm -rf -- ${sq(this.projectPaths.mounts)}`);
    } else {
      await this.executor.exec(
        `rm -rf -- ${sq(`${this.projectPaths.mounts}/releases`)} ${sq(`${this.projectPaths.mounts}/config`)} ${sq(`${this.projectPaths.bare}/.builds`)}`,
      );
    }
    await this.executor.exec(`rm -rf -- ${sq(this.projectPaths.routes)}`);
  }
  override async dispose() {
    await super.dispose();
    if (this.sourcePath) await this.executor.rm(this.sourcePath).catch((diagnosticFailure) => {
      observeCaughtError(diagnosticFailure, "adapters/runtime/cloud/docker");
    });
    await this.connection.dispose();
  }
}
