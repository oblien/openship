import { createHash } from "node:crypto";
import { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type Dockerode from "dockerode";
import {
  AppError,
  parseVolumeMount,
  isHostPathSource,
  UNLIMITED_RESOURCES,
  validateClusterWorkload,
  type ClusterWorkloadConfig,
  type ClusterWorkloadStatus,
  type ComposeAdvanced,
} from "@repo/core";
import { reportCaughtError } from "@repo/core/diagnostics";
import type {
  BuildConfig,
  BuildResult,
  ContainerInfo,
  DeployConfig,
  DeploymentResult,
  ImageArtifactConfig,
  LogEntry,
  LogCallback,
  ResourceUsage,
  RuntimeLogStreamOptions,
} from "../../types";
import type {
  RuntimeCapability,
  MultiServiceRuntimeAdapter,
  MultiServiceDeployConfig,
  MultiServiceDeployResult,
  MultiServiceGroupHandle,
  DeploymentRef,
} from "../types";
import { ClusterImageBuilder } from "../cluster-image-builder";
import { type DockerRuntime } from "../docker";
import { BuildLogger, sq, parseLogLevel } from "../build-pipeline";
import { type DockerRegistryAuth } from "../docker-auth";
import { resolveEdgeImage } from "../../system/proxy/ensure-container-edge";
import { scopeVolumeBinds } from "../volume-namespace";
import { ensureProjectVolume } from "../docker-project-volume";
import { resolveImageVolumeBinds } from "../docker-image-volumes";
import { demuxDockerStream } from "../docker-demux";
import { imageStartCommand } from "../node-output";
import { dockerPublishedPortInfo } from "../docker-container-info";
import { droppedRuntimeEnvMessage, splitRuntimeEnv } from "../runtime-env";
import { inspectDockerSwarm } from "./inspect";
import { swarmRequest, swarmDelay, swarmNotFound, type SwarmTask } from "./api";
import {
  assertSwarmServiceConfig,
  swarmContainerSpec,
  swarmGatewayConfig,
  swarmGatewayPorts,
} from "./spec";

const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 24);
const terminal = new Set(["complete", "shutdown", "failed", "rejected", "remove", "orphaned"]);
type Service = Dockerode.Service & {
  Spec: Dockerode.ServiceSpec & { TaskTemplate: Dockerode.ContainerTaskSpec };
  ID: string;
  Version: { Index: number };
};
type Prepared = {
  config: MultiServiceDeployConfig;
  spec: Dockerode.ServiceSpec;
  networkId: string;
  secrets: string[];
};
const unavailable = (feature: string): never => {
  throw new AppError(
    `${feature} is not available through the Swarm manager.`,
    422,
    "CAPABILITY_UNAVAILABLE",
  );
};

/** Swarm schedules tasks. The shared engine owns releases, routes, authorization and rollback. */
export class SwarmRuntime implements MultiServiceRuntimeAdapter {
  readonly name = "swarm";
  readonly capabilities: ReadonlySet<RuntimeCapability> = new Set([
    "build",
    "prebuiltImage",
    "deploy",
    "multiServiceDeploy",
    "stop",
    "start",
    "restart",
    "destroy",
    "containerInfo",
    "containerIp",
    "runtimeLogs",
    "streamLogs",
    "rollback",
    "projectContainerSweep",
    "deploymentContainerQuery",
    "clusterStatus",
    "retainedServiceCutover",
    "serviceConfigFiles",
  ]);
  readonly unsupportedComposeKeys = new Set<keyof ComposeAdvanced>(); // Validation rejects; never silently drops.
  private readonly lifetime = new AbortController();
  private operationSignal?: AbortSignal;
  private readonly images: ClusterImageBuilder;
  private readonly prepared = new WeakMap<MultiServiceDeployConfig, Prepared>();
  private readonly preparedSingle = new WeakMap<DeployConfig, MultiServiceDeployConfig>();
  private readonly streams = new Set<() => void>();
  // An aborted client request does not prove the manager cancelled its write.
  // Do not restart the incumbent while a delayed create can still launch a writer.
  private readonly uncertainCreations = new Set<string>();
  private readonly prefix: string;
  constructor(
    private readonly options: {
      projectId: string;
      runtimeId: string;
      clusterUid: string;
      managerNodeId: string;
      config: ClusterWorkloadConfig;
      builder: () => Promise<DockerRuntime>;
      resolveRegistryAuth: (image: string) => Promise<DockerRegistryAuth | undefined>;
      /** Tests may use the upstream OpenResty image; production uses the installed Edge release. */
      gatewayImage?: string;
    },
  ) {
    validateClusterWorkload(options.config);
    if (options.config.mounts?.length) unavailable("Kubernetes shared volume claims");
    this.prefix = `opsh-${hash(`${options.runtimeId}:${options.projectId}`)}`;
    this.images = new ClusterImageBuilder({
      imageRepository: options.config.imageRepository,
      builder: options.builder,
      signal: () => this.signal,
    });
  }
  supports(cap: RuntimeCapability) {
    return this.capabilities.has(cap);
  }
  setOperationSignal(signal: AbortSignal) {
    this.operationSignal = signal;
  }
  private get signal() {
    return AbortSignal.any([
      this.lifetime.signal,
      ...(this.operationSignal ? [this.operationSignal] : []),
    ]);
  }
  private labels(deploymentId?: string) {
    return {
      "openship.project": this.options.projectId,
      "openship.runtime": this.options.runtimeId,
      "openship.scheduler": "swarm",
      ...(deploymentId ? { "openship.deployment": deploymentId } : {}),
    };
  }
  private assertOwned(labels?: Record<string, string>) {
    if (Object.entries(this.labels()).some(([key, value]) => labels?.[key] !== value))
      throw new AppError(
        "This Swarm resource is not owned by this project and cluster. It was left unchanged.",
        409,
        "CLUSTER_WORKLOAD_OWNERSHIP",
      );
  }
  private async client() {
    const runtime = await this.images.buildRuntime();
    const identity = await inspectDockerSwarm(runtime.docker);
    if (
      identity.state !== "active" ||
      identity.role !== "manager" ||
      identity.clusterId !== this.options.clusterUid ||
      identity.nodeId !== this.options.managerNodeId
    )
      throw new AppError(
        "The saved Swarm manager or cluster identity changed. Restore its connection before deploying.",
        409,
        "CLUSTER_IDENTITY_CHANGED",
      );
    return runtime.docker;
  }
  private ref(id: string) {
    return `swarm:${hash(this.options.projectId)}:${id}`;
  }
  private id(ref: string) {
    const prefix = `swarm:${hash(this.options.projectId)}:`;
    const id = ref.slice(prefix.length);
    if (!ref.startsWith(prefix) || !/^[a-z0-9]{25}$/.test(id))
      throw new AppError(
        "This Swarm release reference does not belong to this project.",
        409,
        "CLUSTER_WORKLOAD_OWNERSHIP",
      );
    return id;
  }
  private async service(ref: string): Promise<Service> {
    const docker = await this.client();
    const value = await swarmRequest<Service>(docker, "GET", `/services/${this.id(ref)}`, {
      signal: this.lifetime.signal,
    });
    this.assertOwned(value.Spec.Labels);
    return value;
  }
  private filters(deploymentId?: string) {
    return {
      label: Object.entries(this.labels(deploymentId)).map(([key, value]) => `${key}=${value}`),
    };
  }
  private async tasks(id: string, signal = this.lifetime.signal) {
    return swarmRequest<SwarmTask[]>(await this.client(), "GET", "/tasks", {
      query: { filters: JSON.stringify({ service: [id] }) },
      signal,
    });
  }
  private async update(service: Service, mutate: (spec: Service["Spec"]) => void) {
    const spec = structuredClone(service.Spec);
    mutate(spec);
    // Docker rejects a concurrent writer's version; never overwrite an external edit.
    await swarmRequest(await this.client(), "POST", `/services/${service.ID}/update`, {
      body: spec,
      query: { version: service.Version.Index },
      signal: this.lifetime.signal,
    });
  }
  build(config: BuildConfig, logger?: BuildLogger): Promise<BuildResult> {
    return this.images.build(config, logger);
  }
  prepareImage(config: ImageArtifactConfig, logger?: BuildLogger) {
    return this.images.prepareImage(config, logger);
  }
  cancelBuild(id: string) {
    return this.images.cancelBuild(id);
  }
  getBuildLogs(id: string) {
    return this.images.getBuildLogs(id);
  }

  private async network(kind: "overlay" | "bridge") {
    const docker = await this.client();
    const name = `${this.prefix}-${kind}`;
    let network: Dockerode.NetworkInspectInfo;
    try {
      network = await docker.getNetwork(name).inspect();
    } catch (error) {
      if (!swarmNotFound(error)) throw error;
      try {
        await docker.createNetwork({
          Name: name,
          Driver: kind,
          CheckDuplicate: true,
          Labels: this.labels(),
          ...(kind === "overlay" ? { Attachable: true, Options: { encrypted: "" } } : {}),
        });
      } catch (creation) {
        if ((creation as { statusCode?: number })?.statusCode !== 409) throw creation;
      }
      network = await docker.getNetwork(name).inspect();
    }
    this.assertOwned(network.Labels);
    if (
      network.Driver !== kind ||
      (kind === "overlay" && (!network.Attachable || network.Options?.encrypted === undefined))
    )
      throw new AppError(
        "The project's Swarm network configuration changed.",
        409,
        "CLUSTER_WORKLOAD_CONFLICT",
      );
    return network;
  }
  async ensureServiceGroup(config: {
    projectId: string;
    deploymentId: string;
    slug: string;
  }): Promise<MultiServiceGroupHandle> {
    if (config.projectId !== this.options.projectId)
      throw new Error("Swarm project identity mismatch");
    return { id: (await this.network("overlay")).Id };
  }
  private releaseName(config: MultiServiceDeployConfig) {
    return `${this.prefix}-${hash(`${config.deploymentId}:${config.serviceName}`)}`;
  }
  private async files(
    config: MultiServiceDeployConfig,
  ): Promise<{ references: Dockerode.SecretReference[]; ids: string[] }> {
    const docker = await this.client();
    const references: Dockerode.SecretReference[] = [],
      ids: string[] = [];
    for (const file of config.advanced?.files ?? []) {
      const name = `${this.prefix}-cfg-${hash(`${config.deploymentId}:${config.serviceName}:${file.path}`)}`;
      const fingerprint = hash(file.content);
      let secret: Dockerode.Secret;
      try {
        const created = await swarmRequest<{ ID: string }>(docker, "POST", "/secrets/create", {
          body: {
            Name: name,
            Labels: {
              ...this.labels(config.deploymentId),
              "openship.release": this.releaseName(config),
              "openship.config": fingerprint,
            },
            Data: Buffer.from(file.content).toString("base64"),
          },
          signal: this.signal,
        });
        secret = await docker.getSecret(created.ID).inspect();
      } catch (error) {
        if ((error as { statusCode?: number })?.statusCode !== 409) throw error;
        secret = await docker.getSecret(name).inspect();
      }
      this.assertOwned(secret.Spec?.Labels);
      if (secret.Spec?.Labels?.["openship.config"] !== fingerprint)
        throw new AppError(
          "This release's config already has different content.",
          409,
          "CLUSTER_WORKLOAD_CONFLICT",
        );
      ids.push(secret.ID);
      references.push({
        SecretID: secret.ID,
        SecretName: name,
        File: { Name: file.path, UID: "0", GID: "0", Mode: 0o444 },
      });
    }
    return { references, ids };
  }

  /** Prepare immutable images and durable mounts while the outgoing release still exists. */
  async prepareServiceWorkload(config: MultiServiceDeployConfig): Promise<void> {
    assertSwarmServiceConfig(config);
    if (config.projectId !== this.options.projectId)
      throw new Error("Swarm project identity mismatch");
    const docker = await this.client();
    const builder = await this.images.buildRuntime();
    const imageResult = await this.prepareImage({
      sessionId: config.deploymentId,
      projectId: config.projectId,
      imageRef: config.image,
      envVars: {},
      resources: UNLIMITED_RESOURCES,
      forcePull: config.forcePull,
    });
    if (!imageResult.imageRef || imageResult.status === "failed")
      throw new Error("Could not prepare the Swarm image");
    config.image = imageResult.imageRef;
    const image = await docker.getImage(config.image).inspect();
    const previous = config.previousContainerId
      ? await this.service(config.previousContainerId)
      : undefined;
    const declared = scopeVolumeBinds(config.slug, config.volumes, config.namespaceVolumes);
    const binds = await resolveImageVolumeBinds(
      docker,
      declared,
      Object.keys(image.Config?.Volumes ?? {}),
      {
        projectId: config.projectId,
        workload: config.serviceName,
        readPrevious: async () =>
          previous
            ? {
                Mounts: (previous.Spec.TaskTemplate.ContainerSpec?.Mounts ?? []).map((mount) => ({
                  Type: mount.Type,
                  Name: mount.Type === "volume" ? mount.Source : undefined,
                  Source: mount.Source ?? "",
                  Destination: mount.Target!,
                  Driver: "local",
                  Mode: mount.ReadOnly ? "ro" : "rw",
                  RW: !mount.ReadOnly,
                  Propagation: "",
                })),
              }
            : undefined,
      },
    );
    const mounts: Dockerode.MountSettings[] = [];
    for (const bind of binds) {
      const mount = parseVolumeMount(bind);
      if (
        !mount.source ||
        isHostPathSource(mount.source) ||
        mount.options.some((option) => !["rw", "ro", "nocopy"].includes(option))
      )
        throw new AppError(
          "Swarm storage requires named volumes. Host bind paths and SELinux mount flags cannot be scheduled safely.",
          422,
          "SWARM_SETTING_UNSUPPORTED",
        );
      const old = previous?.Spec.TaskTemplate.ContainerSpec?.Mounts?.find(
        (item) => item.Target === mount.target && item.Source === mount.source,
      );
      if (old) await docker.getVolume(mount.source).inspect(); // Never silently replace missing saved data.
      if (!(await ensureProjectVolume(docker, mount.source, config.projectId)))
        throw new AppError(
          "A named volume belongs to another project. It was left unchanged.",
          409,
          "CLUSTER_WORKLOAD_OWNERSHIP",
        );
      mounts.push({
        Type: "volume",
        Source: mount.source,
        Target: mount.target,
        ReadOnly: mount.options.includes("ro"),
        VolumeOptions: {
          NoCopy: mount.options.includes("nocopy"),
          Labels: { "openship.project": config.projectId },
          DriverConfig: { Name: "local", Options: {} },
        },
      });
    }
    // Node-local data is never rescheduled onto an empty volume on another worker.
    const replicas = mounts.length ? 1 : this.options.config.replicas;
    const network = await this.network("overlay");
    const files = await this.files(config);
    const aliases = [...new Set([config.serviceName, ...(config.extraAliases ?? [])])];
    if (aliases.some((name) => !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)))
      throw new Error("Invalid Swarm network alias");
    const limits = {
      ...(config.resources?.cpuCores
        ? { NanoCPUs: Math.round(config.resources.cpuCores * 1e9) }
        : {}),
      ...(config.resources?.memoryMb
        ? { MemoryBytes: Math.round(config.resources.memoryMb * 1024 * 1024) }
        : {}),
    };
    const spec: Dockerode.ServiceSpec = {
      Name: this.releaseName(config),
      Labels: {
        ...this.labels(config.deploymentId),
        "openship.service": config.serviceName,
        "openship.replicas": String(replicas),
        "openship.aliases": JSON.stringify(aliases),
        "openship.ports": JSON.stringify(swarmGatewayPorts(config)),
        "openship.secrets": JSON.stringify(files.ids),
      },
      Mode: { Replicated: { Replicas: replicas } },
      EndpointSpec: { Mode: "vip", Ports: [] },
      TaskTemplate: {
        ContainerSpec: {
          ...swarmContainerSpec(config, image),
          Mounts: mounts,
          Secrets: files.references,
          Labels: this.labels(config.deploymentId),
        },
        Networks: [{ Target: network.Id, Aliases: aliases }],
        Placement: {
          Constraints: [
            "node.platform.os == linux",
            `node.platform.arch == ${image.Architecture === "amd64" ? "x86_64" : "aarch64"}`,
            ...(mounts.length ? [`node.id == ${this.options.managerNodeId}`] : []),
          ],
        },
        Resources: { Limits: limits },
        RestartPolicy: {
          Condition:
            config.restart === "no"
              ? "none"
              : config.restart === "on-failure"
                ? "on-failure"
                : "any",
          Delay: 5_000_000_000,
        },
        LogDriver: { Name: "json-file", Options: { "max-size": "10m", "max-file": "3" } },
      },
      UpdateConfig: { Parallelism: 1, Order: "stop-first", FailureAction: "pause" },
    };
    spec.Labels!["openship.config"] = hash(JSON.stringify(spec));
    // Pull the gateway before the old service is stopped too.
    if (swarmGatewayPorts(config).ports.length)
      await builder.pullImage(this.options.gatewayImage ?? resolveEdgeImage());
    this.prepared.set(config, { config, spec, networkId: network.Id, secrets: files.ids });
  }
  async prepareDeployment(config: DeployConfig) {
    if (config.adopt || config.hostPort !== undefined)
      unavailable("Process adoption and pinned single-host routes");
    if (!config.imageRef) throw new Error("The Swarm release has no image");
    const prepared = await this.prepareImage({
      sessionId: config.buildSessionId,
      projectId: config.projectId,
      imageRef: config.imageRef,
      envVars: {},
      resources: UNLIMITED_RESOURCES,
    });
    if (!prepared.imageRef || prepared.status === "failed" || prepared.status === "cancelled")
      throw new Error("Could not prepare the Swarm image");
    config.imageRef = prepared.imageRef;
    const image = await (await this.client()).getImage(config.imageRef).inspect();
    const service: MultiServiceDeployConfig = {
      projectId: config.projectId,
      deploymentId: config.deploymentId,
      previousContainerId: config.previousContainerId,
      slug: config.slug ?? config.projectId,
      serviceName: config.networkAlias ?? "app",
      image: config.imageRef!,
      ports: config.portless ? [] : [String(config.port)],
      publicPort: config.portless ? undefined : config.port,
      environment: { ...(config.portless ? {} : { PORT: String(config.port) }), ...config.envVars },
      volumes: config.volumes ?? [],
      namespaceVolumes: true,
      command: imageStartCommand(image.Config?.Labels, config.startCommand),
      cloudProxyPorts: config.publicEndpoints?.map((endpoint) => endpoint.port ?? config.port),
      extraAliases: config.extraAliases,
      resources: config.resources,
      restart: config.restartPolicy,
    };
    await this.prepareServiceWorkload(service);
    this.preparedSingle.set(config, service);
  }
  async deploy(config: DeployConfig, onLog?: LogCallback): Promise<DeploymentResult> {
    if (!this.preparedSingle.has(config)) await this.prepareDeployment(config);
    const service = this.preparedSingle.get(config)!;
    const result = await this.deployServiceWorkload(
      { id: this.prepared.get(service)!.networkId },
      service,
      onLog,
    );
    return {
      deploymentId: config.deploymentId,
      containerId: result.containerId,
      status: "running",
    };
  }
  private async assertNoOtherWriter(serviceName: string, exceptName: string) {
    const services = await swarmRequest<Service[]>(await this.client(), "GET", "/services", {
      query: { filters: JSON.stringify(this.filters()) },
      signal: this.lifetime.signal,
    });
    for (const service of services) {
      this.assertOwned(service.Spec.Labels);
      if (
        service.Spec.Labels?.["openship.service"] !== serviceName ||
        service.Spec.Name === exceptName
      )
        continue;
      if (
        (service.Spec.Mode?.Replicated?.Replicas ?? 0) > 0 ||
        (await this.tasks(service.ID)).some((task) => !terminal.has(task.Status.State))
      )
        throw new AppError(
          "Another release of this service may still be running. Recover or stop it before starting this release.",
          409,
          "CLUSTER_WORKLOAD_BUSY",
        );
    }
  }
  async deployServiceWorkload(
    group: MultiServiceGroupHandle,
    config: MultiServiceDeployConfig,
    onLog?: LogCallback,
  ): Promise<MultiServiceDeployResult> {
    if (!this.prepared.has(config)) await this.prepareServiceWorkload(config);
    const prepared = this.prepared.get(config)!;
    if (group.id !== prepared.networkId) throw new Error("Swarm network identity mismatch");
    await this.assertNoOtherWriter(config.serviceName, prepared.spec.Name!);
    const docker = await this.client();
    const log = (message: string) =>
      onLog?.({ timestamp: new Date().toISOString(), level: "info", message, step: "deploy" });
    const dropped = droppedRuntimeEnvMessage(splitRuntimeEnv(config.environment).dropped);
    if (dropped) log(dropped);
    if (
      prepared.spec.TaskTemplate &&
      "ContainerSpec" in prepared.spec.TaskTemplate &&
      prepared.spec.TaskTemplate.ContainerSpec?.Mounts?.length
    )
      log(
        "Persistent service: one instance pinned to the connected manager so its local data stays on the same node.",
      );
    let id: string;
    const auth = await this.options.resolveRegistryAuth(config.image);
    this.signal.throwIfAborted();
    this.uncertainCreations.add(config.serviceName);
    try {
      const result = await swarmRequest<{ ID: string }>(docker, "POST", "/services/create", {
        body: prepared.spec,
        signal: this.signal,
        headers: auth
          ? {
              "X-Registry-Auth": Buffer.from(JSON.stringify(auth))
                .toString("base64")
                .replaceAll("+", "-")
                .replaceAll("/", "_"),
            }
          : undefined,
      });
      id = result.ID;
    } catch (error) {
      const status = (error as { statusCode?: number })?.statusCode;
      if (status !== 409) {
        // A definite rejection cannot launch a task; retain ordinary recovery.
        // Transport errors, timeouts and server failures remain uncertain.
        if (status !== undefined && [400, 401, 403, 404].includes(status))
          this.uncertainCreations.delete(config.serviceName);
        throw error;
      }
      const existing = await swarmRequest<Service>(
        docker,
        "GET",
        `/services/${prepared.spec.Name}`,
        { signal: this.signal },
      );
      this.assertOwned(existing.Spec.Labels);
      if (existing.Spec.Labels?.["openship.config"] !== prepared.spec.Labels?.["openship.config"])
        throw new AppError(
          "This release already has different settings. Start a new deployment.",
          409,
          "CLUSTER_WORKLOAD_CONFLICT",
        );
      id = existing.ID;
    }
    const ref = this.ref(id);
    this.id(ref); // Validate the receipt before allowing automatic incumbent recovery.
    this.uncertainCreations.delete(config.serviceName);
    try {
      await this.waitReady(ref, log);
      await this.ensureGateway(await this.service(ref));
      const info = await this.getContainerInfo(ref);
      return {
        containerId: ref,
        status: "running",
        ip: info.ip,
        hostPort: info.hostPort,
        hostPortByContainerPort: info.hostPortByContainerPort,
        imageDigest: config.image,
      };
    } catch (error) {
      try {
        await this.destroy(ref);
      } catch (cleanup) {
        reportCaughtError(cleanup, "adapters/runtime/swarm/runtime");
        throw new AggregateError(
          [error, cleanup],
          "Swarm rollout failed and cleanup could not be confirmed. Recover this release before retrying.",
        );
      }
      throw error;
    }
  }
  private async waitReady(
    ref: string,
    log?: (message: string) => void,
    operationSignal = this.signal,
  ) {
    const signal = AbortSignal.any([operationSignal, AbortSignal.timeout(6 * 60_000)]);
    let previous = "",
      stableSince = 0;
    while (true) {
      signal.throwIfAborted();
      const status = await this.status(ref);
      const message = `${status.ready}/${status.desired} Swarm tasks running${status.message ? `: ${status.message}` : ""}`;
      if (message !== previous) {
        log?.(message);
        previous = message;
      }
      if (
        status.ready === status.desired &&
        status.updated === status.desired &&
        status.desired > 0
      ) {
        stableSince ||= Date.now();
        if (Date.now() - stableSince >= 5_000) return;
      } else stableSince = 0;
      await swarmDelay(1000, signal);
    }
  }

  private gatewayName(service: Service) {
    return `${service.Spec.Name}-edge`;
  }
  private async gateway(service: Service) {
    const docker = await this.client();
    const value = await docker.getContainer(this.gatewayName(service)).inspect();
    this.assertOwned(value.Config.Labels);
    if (value.Config.Labels?.["openship.swarm-service"] !== service.ID)
      throw new Error("Swarm gateway ownership changed");
    return value;
  }
  private async ensureGateway(service: Service) {
    const ports = JSON.parse(service.Spec.Labels!["openship.ports"]!) as ReturnType<
      typeof swarmGatewayPorts
    >;
    if (!ports.ports.length) return;
    const docker = await this.client();
    let existing: Dockerode.ContainerInspectInfo | undefined;
    try {
      existing = await this.gateway(service);
    } catch (error) {
      if (!swarmNotFound(error)) throw error;
    }
    if (existing) {
      if (!existing.State.Running) await docker.getContainer(existing.Id).start();
      return;
    }
    const bridge = await this.network("bridge"),
      overlay = await this.network("overlay");
    const config = swarmGatewayConfig(service.Spec.Name!, ports.ports);
    const image = this.options.gatewayImage ?? resolveEdgeImage();
    const created = await docker.createContainer({
      name: this.gatewayName(service),
      Image: image,
      Labels: {
        ...this.labels(service.Spec.Labels!["openship.deployment"]),
        "openship.swarm-service": service.ID,
      },
      User: "101:101",
      Entrypoint: [],
      Cmd: [
        "sh",
        "-c",
        `printf %s ${sq(Buffer.from(config).toString("base64"))} | base64 -d > /tmp/swarm.conf && exec openresty -c /tmp/swarm.conf -g 'daemon off;'`,
      ],
      ExposedPorts: Object.fromEntries(ports.ports.map((port) => [port, {}])),
      HostConfig: {
        NetworkMode: bridge.Id,
        RestartPolicy: { Name: "unless-stopped" },
        ReadonlyRootfs: true,
        Tmpfs: { "/tmp": "rw,nosuid,nodev,noexec,size=16m" },
        CapDrop: ["ALL"],
        Sysctls: { "net.ipv4.ip_unprivileged_port_start": "0" },
        SecurityOpt: ["no-new-privileges:true"],
        PortBindings: ports.portBindings,
        LogConfig: { Type: "json-file", Config: { "max-size": "5m", "max-file": "2" } },
      },
    });
    await docker.getNetwork(overlay.Id).connect({ Container: created.id });
    await created.start();
    const observed = await this.gateway(service);
    if (!observed.State.Running) throw new Error("The private Swarm gateway did not start");
  }
  private async waitStopped(service: Service) {
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(120_000)]);
    while ((await this.tasks(service.ID, signal)).some((task) => !terminal.has(task.Status.State)))
      await swarmDelay(500, signal);
  }
  async stop(ref: string) {
    const service = await this.service(ref);
    await this.update(service, (spec) => {
      spec.Mode = { Replicated: { Replicas: 0 } };
      spec.TaskTemplate.Networks = spec.TaskTemplate.Networks?.map((network) => ({
        ...network,
        Aliases: [],
      }));
    });
    await this.waitStopped(service);
    try {
      const gateway = await this.gateway(service);
      if (gateway.State.Running) await (await this.client()).getContainer(gateway.Id).stop();
    } catch (error) {
      if (!swarmNotFound(error)) throw error;
    }
  }
  async start(ref: string) {
    const service = await this.service(ref);
    if (this.uncertainCreations.has(service.Spec.Labels!["openship.service"]!))
      throw new AppError(
        "The manager has not confirmed whether the candidate was created. The previous release stays stopped to protect its data. Inspect and recover this deployment before retrying.",
        409,
        "CLUSTER_ROLLOUT_UNCERTAIN",
      );
    await this.assertNoOtherWriter(service.Spec.Labels!["openship.service"]!, service.Spec.Name!);
    await this.update(service, (spec) => {
      spec.Mode = { Replicated: { Replicas: Number(spec.Labels!["openship.replicas"]) } };
      spec.TaskTemplate.Networks = spec.TaskTemplate.Networks?.map((network) => ({
        ...network,
        Aliases: JSON.parse(spec.Labels!["openship.aliases"]!),
      }));
    });
    await this.waitReady(ref, undefined, this.lifetime.signal);
    await this.ensureGateway(await this.service(ref));
  }
  async restart(ref: string) {
    const service = await this.service(ref);
    if (!service.Spec.Mode?.Replicated?.Replicas) return this.start(ref);
    await this.update(service, (spec) => {
      spec.TaskTemplate.ForceUpdate = (spec.TaskTemplate.ForceUpdate ?? 0) + 1;
    });
    await this.waitReady(ref);
  }
  async destroy(ref: string) {
    let service: Service;
    try {
      service = await this.service(ref);
    } catch (error) {
      if (swarmNotFound(error)) return;
      throw error;
    }
    await this.stop(ref); // Verify tasks are gone before releasing single-writer data or ports.
    const docker = await this.client();
    await swarmRequest(docker, "DELETE", `/services/${service.ID}`, {
      signal: this.lifetime.signal,
    });
    try {
      const gateway = await this.gateway(service);
      await docker.getContainer(gateway.Id).remove();
    } catch (error) {
      if (!swarmNotFound(error)) throw error;
    }
    for (const id of JSON.parse(service.Spec.Labels!["openship.secrets"] ?? "[]") as string[]) {
      try {
        const secret = await docker.getSecret(id).inspect();
        this.assertOwned(secret.Spec?.Labels);
        if (secret.Spec?.Labels?.["openship.release"] !== service.Spec.Name)
          throw new Error("Swarm secret ownership changed");
        await docker.getSecret(secret.ID).remove();
      } catch (error) {
        if (!swarmNotFound(error)) throw error;
      }
    }
  }
  async status(ref: string): Promise<ClusterWorkloadStatus> {
    const service = await this.service(ref),
      tasks = await this.tasks(service.ID);
    const current = tasks.filter((task) => task.DesiredState === "running");
    const ready = current.filter((task) => task.Status.State === "running").length;
    return {
      desired: service.Spec.Mode?.Replicated?.Replicas ?? 0,
      ready,
      available: ready,
      updated: current.filter(
        (task) =>
          task.Status.State === "running" &&
          (task.Spec?.ForceUpdate ?? 0) === (service.Spec.TaskTemplate.ForceUpdate ?? 0),
      ).length,
      generation: service.Version.Index,
      observedGeneration: service.Version.Index,
      message:
        current
          .filter((task) => task.Status.State !== "running")
          .map((task) => task.Status.Err || task.Status.State)
          .join("; ") || null,
      pods: current.map((task) => ({
        name: task.ID,
        nodeName: task.NodeID ?? null,
        ready: task.Status.State === "running",
        phase: task.Status.State,
        restarts: tasks.filter(
          (prior) =>
            prior.Slot === task.Slot && prior.ID !== task.ID && terminal.has(prior.Status.State),
        ).length,
      })),
    };
  }
  async getContainerInfo(ref: string): Promise<ContainerInfo> {
    let service: Service;
    try {
      service = await this.service(ref);
    } catch (error) {
      if (swarmNotFound(error)) return { containerId: ref, status: "missing" };
      throw error;
    }
    const status = await this.status(ref);
    let gateway: Dockerode.ContainerInspectInfo | undefined;
    try {
      gateway = await this.gateway(service);
    } catch (error) {
      if (!swarmNotFound(error)) throw error;
    }
    const needsGateway =
      (JSON.parse(service.Spec.Labels!["openship.ports"]!) as { ports: string[] }).ports.length > 0;
    return {
      containerId: ref,
      status:
        status.desired === 0
          ? "stopped"
          : needsGateway && !gateway?.State.Running
            ? "failed"
            : status.ready === status.desired
              ? "running"
              : "deploying",
      imageId: service.Spec.TaskTemplate.ContainerSpec?.Image,
      ip: gateway?.NetworkSettings.Networks[`${this.prefix}-bridge`]?.IPAddress,
      ...dockerPublishedPortInfo(
        Object.entries(gateway?.NetworkSettings.Ports ?? {}).flatMap(([key, bindings]) =>
          (bindings ?? []).map((binding) => ({
            privatePort: Number(key.split("/")[0]),
            publicPort: Number(binding.HostPort),
            ip: binding.HostIp,
            type: key.split("/")[1],
          })),
        ),
      ),
      resources: {
        cpuCores: (service.Spec.TaskTemplate.Resources?.Limits?.NanoCPUs ?? 0) / 1e9,
        memoryMb: (service.Spec.TaskTemplate.Resources?.Limits?.MemoryBytes ?? 0) / (1024 * 1024),
      },
    };
  }
  async getContainerIp(ref: string): Promise<string | null> {
    const service = await this.service(ref);
    try {
      return (
        (await this.gateway(service)).NetworkSettings.Networks[`${this.prefix}-bridge`]
          ?.IPAddress || null
      );
    } catch (error) {
      if (swarmNotFound(error)) return null;
      throw error;
    }
  }
  async listProjectContainerIds(projectId: string) {
    if (projectId !== this.options.projectId) throw new Error("Swarm project identity mismatch");
    const services = await swarmRequest<Service[]>(await this.client(), "GET", "/services", {
      query: { filters: JSON.stringify(this.filters()) },
      signal: this.lifetime.signal,
    });
    return services.map((service) => {
      this.assertOwned(service.Spec.Labels);
      return this.ref(service.ID);
    });
  }
  async listDeploymentContainers(deploymentId: string) {
    const services = await swarmRequest<Service[]>(await this.client(), "GET", "/services", {
      query: { filters: JSON.stringify(this.filters(deploymentId)) },
      signal: this.lifetime.signal,
    });
    return Promise.all(
      services.map(async (service) => {
        this.assertOwned(service.Spec.Labels);
        const info = await this.getContainerInfo(this.ref(service.ID));
        return {
          containerId: info.containerId,
          status: info.status,
          serviceName: service.Spec.Labels?.["openship.service"],
        };
      }),
    );
  }
  async getUsage(_ref: string): Promise<ResourceUsage> {
    return unavailable("Aggregate task resource measurements");
  }
  async archive(deployment: DeploymentRef) {
    if (deployment.containerId)
      try {
        await this.stop(deployment.containerId);
      } catch (error) {
        if (!swarmNotFound(error)) throw error;
      }
  }
  async purge(deployment: DeploymentRef) {
    if (deployment.containerId) await this.destroy(deployment.containerId);
  }
  async cleanupProject(projectId: string, options?: { wipeVolumes?: boolean }) {
    if ((await this.listProjectContainerIds(projectId)).length)
      throw new Error("Swarm services still use this project network");
    const docker = await this.client();
    // Reclaim orphan helpers/configs only after exact owner checks. Docker refuses attached networks/volumes.
    for (const container of await docker.listContainers({ all: true, filters: this.filters() })) {
      this.assertOwned(container.Labels);
      if (container.Labels["com.docker.swarm.task.id"]) continue; // Only the scheduler removes task containers.
      if (!container.Labels["openship.swarm-service"])
        throw new Error("An unrecognized container still uses the Swarm project");
      await docker.getContainer(container.Id).remove({ force: true });
    }
    for (const secret of await docker.listSecrets({ filters: this.filters() })) {
      this.assertOwned(secret.Spec?.Labels);
      await docker.getSecret(secret.ID).remove();
    }
    for (const kind of ["overlay", "bridge"] as const) {
      const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(30_000)]);
      for (;;) {
        try {
          const network = await docker.getNetwork(`${this.prefix}-${kind}`).inspect();
          this.assertOwned(network.Labels);
          await docker.getNetwork(network.Id).remove();
          break;
        } catch (error) {
          if (swarmNotFound(error)) break;
          if ((error as { statusCode?: number }).statusCode !== 409) throw error;
          await swarmDelay(500, signal); // Swarm detaches terminal tasks asynchronously.
        }
      }
    }
    if (options?.wipeVolumes) {
      const volumes = await docker.listVolumes({
        filters: { label: [`openship.project=${projectId}`] },
      });
      for (const volume of volumes.Volumes ?? []) {
        if (volume.Labels?.["openship.project"] !== projectId)
          throw new Error("Swarm volume ownership changed");
        await docker.getVolume(volume.Name).remove();
      }
    }
  }
  private async logs(
    ref: string,
    onLog: LogCallback,
    opts: RuntimeLogStreamOptions | undefined,
    follow: boolean,
  ) {
    const service = await this.service(ref),
      docker = await this.client();
    const raw = await swarmRequest<Readable | Buffer>(
      docker,
      "GET",
      `/services/${service.ID}/logs`,
      {
        query: {
          stdout: true,
          stderr: true,
          timestamps: true,
          follow,
          tail: Math.max(0, Math.min(opts?.tail ?? 200, 10_000)),
        },
        stream: follow,
        signal: this.lifetime.signal,
      },
    );
    const source = Buffer.isBuffer(raw) ? Readable.from([raw]) : raw;
    let closed = false,
      finished = false;
    const buffers = ["", ""],
      decoders = [new StringDecoder("utf8"), new StringDecoder("utf8")];
    const sinks = (["info", "error"] as const).map(
      (level, index) =>
        new Writable({
          write(chunk, _encoding, callback) {
            if (closed) return callback();
            const value = buffers[index] + decoders[index]!.write(chunk);
            const lines = value.split("\n");
            buffers[index] = lines.pop() ?? "";
            if (buffers[index]!.length > 256_000) {
              lines.push(buffers[index]!);
              buffers[index] = "";
            }
            for (const line of lines.filter(Boolean)) {
              const match = line.match(/^(\S+) (.*)$/);
              const timestamp =
                match && !Number.isNaN(Date.parse(match[1]!))
                  ? match[1]!
                  : new Date().toISOString();
              const message = timestamp === match?.[1] ? match[2]! : line;
              onLog({
                timestamp,
                message,
                level: level === "error" ? level : parseLogLevel(message),
              });
            }
            callback();
          },
        }),
    );
    let settleStopped: () => void = () => {};
    const stop = () => {
      if (closed) return;
      closed = true;
      settleStopped();
      source.destroy();
      sinks.forEach((sink) => sink.destroy());
      this.streams.delete(stop);
    };
    this.streams.add(stop);
    const completed = new Promise<void>((resolve, reject) => {
      settleStopped = resolve;
      const finish = (error?: Error) => {
        if (finished || closed) return;
        finished = true;
        for (const [index, buffer] of buffers.entries()) {
          const message = buffer + decoders[index]!.end();
          if (message)
            onLog({
              timestamp: new Date().toISOString(),
              message,
              level: index === 1 ? "error" : parseLogLevel(message),
            });
        }
        opts?.onEnd?.(error);
        this.streams.delete(stop);
        if (error) reject(error);
        else resolve();
      };
      demuxDockerStream(source, sinks[0]!, sinks[1]!, finish);
      source.once("end", () => finish());
      source.once("error", finish);
      source.once("close", () => {
        if (!finished && !closed) finish(new Error("Swarm log connection closed"));
      });
    });
    if (!follow) await completed;
    else
      void completed.catch((error) => {
        reportCaughtError(error, "adapters/runtime/swarm/runtime");
      });
    return stop;
  }
  async getRuntimeLogs(ref: string, tail?: number): Promise<LogEntry[]> {
    const logs: LogEntry[] = [];
    await this.logs(ref, (entry) => logs.push(entry), { tail }, false);
    return logs;
  }
  streamRuntimeLogs(ref: string, onLog: LogCallback, opts?: RuntimeLogStreamOptions) {
    return this.logs(ref, onLog, opts, true);
  }
  async dispose() {
    this.streams.forEach((stop) => stop());
    this.lifetime.abort();
    await this.images.dispose();
  }
}
