import { createHash } from "node:crypto";
import { posix } from "node:path";
import type Dockerode from "dockerode";
import {
  AppError,
  assertWorkloadReplicas,
  parseVolumeMount,
  validateWorkloadReplicas,
  type ClusterWorkloadStatus,
} from "@repo/core";
import { reportCaughtError } from "@repo/core/diagnostics";
import type { DockerRuntime } from "./docker";
import type {
  DeployConfig,
  DeploymentResult,
  ContainerInfo,
  LogCallback,
  RuntimeLogStreamOptions,
  ResourceUsage,
  WorkloadReplicaIdentity,
} from "../types";
import type {
  MultiServiceDeployConfig,
  MultiServiceDeployResult,
  MultiServiceGroupHandle,
} from "./types";
import { resolveEdgeImage } from "../system/proxy/ensure-container-edge";
import { workloadGatewayConfig, workloadGatewayContainer } from "./workload-gateway";
import { parsePortBindings, buildNetworkAliases } from "./docker";
import type { DockerEnvironmentOptions, DockerEnvironmentResult } from "./docker-environment";
import type { ContainerStabilitySample } from "./stability";
import { dockerContainerStatus } from "./docker-container-info";

export const REPLICA_GROUP_LABEL = "openship.replica-group";
export const REPLICA_INDEX_LABEL = "openship.replica-index";
export const REPLICA_IMAGE_LABEL = "openship.replica-image";
const DESIRED_LABEL = "openship.replica-count";
const PREFIX = "replicas:";
export const isDockerReplicaRef = (ref: string) => ref.startsWith(PREFIX);
export const dockerReplicaRef = (group: string) => `${PREFIX}${group}`;
export const replicaContainerName = (group: string, index: number) =>
  `opsh-replicas-${group}-${index}`;
export const replicaLabels = (replica: { group: string; index: number }) => ({
  [REPLICA_GROUP_LABEL]: replica.group,
  [REPLICA_INDEX_LABEL]: String(replica.index),
});
export function replicaInventoryStatus(
  anchor: Dockerode.ContainerInfo,
  members: Dockerode.ContainerInfo[],
) {
  const status = (row: Dockerode.ContainerInfo) =>
    dockerContainerStatus(row.State ?? "", { statusLine: row.Status });
  if (members.length !== Number(anchor.Labels[DESIRED_LABEL])) return "missing" as const;
  return [anchor, ...members].map(status).find((value) => value !== "running") ?? "running";
}
export function replicaMembersByGroup(rows: Dockerode.ContainerInfo[]) {
  const groups = new Map<string, Dockerode.ContainerInfo[]>();
  for (const row of rows) {
    const group = row.Labels?.[REPLICA_GROUP_LABEL];
    if (group && row.Labels[REPLICA_INDEX_LABEL] !== "0") {
      const members = groups.get(group) ?? [];
      members.push(row);
      groups.set(group, members);
    }
  }
  return groups;
}
export const replicaGroupIdentity = (projectId: string, deploymentId: string, service: string) =>
  createHash("sha256")
    .update(JSON.stringify([projectId, deploymentId, service]))
    .digest("hex")
    .slice(0, 32);
const missing = (error: unknown) => (error as { statusCode?: number })?.statusCode === 404;

/** One durable workload reference, backed by ordinary Docker containers. No control-plane polling is required. */
export class DockerReplicas {
  constructor(private readonly runtime: DockerRuntime) {}
  private readonly prepared = new WeakMap<
    DeployConfig | MultiServiceDeployConfig,
    { internalPorts: string[]; imageRef: string }
  >();
  private signal?: AbortSignal;
  setOperationSignal(signal: AbortSignal) {
    this.signal = signal;
  }
  private group(ref: string) {
    if (!this.runtime.supports("replicas"))
      throw new AppError(
        "This runtime does not support single-server replicas.",
        422,
        "WORKLOAD_REPLICAS_UNSUPPORTED",
      );
    const group = ref.slice(PREFIX.length);
    if (!ref.startsWith(PREFIX) || !/^[a-f0-9]{32}$/.test(group))
      throw new AppError("Invalid replica workload reference.", 422, "WORKLOAD_REFERENCE_INVALID");
    return group;
  }
  private async anchor(ref: string) {
    const group = this.group(ref);
    const data = await this.runtime.docker.getContainer(replicaContainerName(group, 0)).inspect();
    const labels = data.Config.Labels ?? {};
    if (
      labels[REPLICA_GROUP_LABEL] !== group ||
      labels[REPLICA_INDEX_LABEL] !== "0" ||
      !labels["openship.project"] ||
      !labels["openship.deployment"] ||
      !labels["openship.service"] ||
      replicaGroupIdentity(
        labels["openship.project"]!,
        labels["openship.deployment"]!,
        labels["openship.service"]!,
      ) !== group
    )
      throw new AppError("Replica workload ownership changed.", 409, "WORKLOAD_OWNERSHIP_CHANGED");
    validateWorkloadReplicas(Number(labels[DESIRED_LABEL]));
    return data;
  }
  async members(ref: string, allowIncomplete = false) {
    const anchor = await this.anchor(ref);
    const labels = anchor.Config.Labels!;
    const group = this.group(ref);
    const rows = await this.runtime.docker.listContainers({
      all: true,
      filters: {
        label: [
          `${REPLICA_GROUP_LABEL}=${group}`,
          `openship.project=${labels["openship.project"]}`,
          `openship.deployment=${labels["openship.deployment"]}`,
          `openship.service=${labels["openship.service"]}`,
        ],
      },
    });
    const members = rows
      .filter((row) => row.Labels[REPLICA_INDEX_LABEL] !== "0")
      .sort(
        (a, b) => Number(a.Labels[REPLICA_INDEX_LABEL]) - Number(b.Labels[REPLICA_INDEX_LABEL]),
      );
    const desired = Number(labels[DESIRED_LABEL]);
    const seen = new Set<number>();
    for (const member of members) {
      const index = Number(member.Labels[REPLICA_INDEX_LABEL]);
      if (!Number.isInteger(index) || index < 1 || index > desired || seen.has(index))
        throw new AppError(
          "Replica inventory is inconsistent. Redeploy this workload.",
          409,
          "WORKLOAD_REPLICAS_INCOMPLETE",
        );
      seen.add(index);
    }
    if (!allowIncomplete && members.length !== desired)
      throw new AppError(
        "One or more instances are missing. Redeploy this workload.",
        409,
        "WORKLOAD_REPLICAS_INCOMPLETE",
      );
    return { anchor, members, desired };
  }
  async prepare(config: DeployConfig | MultiServiceDeployConfig) {
    this.signal?.throwIfAborted();
    const replicas = config.replicas ?? 1;
    const service = "image" in config;
    assertWorkloadReplicas(replicas, {
      image: service ? config.image : config.imageRef,
      framework: service ? undefined : config.stack,
      volumes: config.volumes,
      advanced: service ? config.advanced : undefined,
    });
    if (replicas === 1) return;
    if (!this.runtime.supports("replicas"))
      throw new AppError(
        "This runtime does not support single-server replicas.",
        422,
        "WORKLOAD_REPLICAS_UNSUPPORTED",
      );
    if (this.prepared.has(config)) return;
    if (service && (config.namespaces?.network || config.namespaces?.pid))
      throw new AppError(
        "Shared namespaces cannot be used with multiple instances.",
        422,
        "WORKLOAD_REPLICAS_UNSUPPORTED",
      );
    const imageRef = service ? config.image : config.imageRef!;
    if (service && !config.imageAlreadyPrepared)
      await this.runtime.pullImage(imageRef, { force: config.forcePull, signal: this.signal });
    const image = await this.runtime.docker.getImage(imageRef).inspect();
    // Image-declared anonymous volumes are writable too, even when absent from the saved configuration.
    const readonlyTargets = new Set(
      (config.volumes ?? [])
        .map(parseVolumeMount)
        .filter((mount) => mount.source && mount.options.includes("ro"))
        .map((mount) => posix.normalize(mount.target)),
    );
    if (
      Object.keys(image.Config?.Volumes ?? {}).some(
        (target) => !readonlyTargets.has(posix.normalize(target)),
      )
    )
      throw new AppError(
        "This image declares persistent volumes. Use a stateless image before adding instances.",
        422,
        "WORKLOAD_REPLICAS_UNSUPPORTED",
      );
    const internalPorts = [
      ...Object.keys(image.Config?.ExposedPorts ?? {}),
      ...(service
        ? (config.advanced?.expose ?? [])
        : config.portless
          ? []
          : [
              config.port,
              ...(config.publicEndpoints ?? []).map((endpoint) => endpoint.port ?? config.port),
            ].map((port) => `${port}/tcp`)),
    ];
    const ports = service ? config.ports : [];
    workloadGatewayConfig(
      ["validation"],
      [...Object.keys(parsePortBindings(ports).exposedPorts), ...internalPorts],
    );
    await this.runtime.pullImage(resolveEdgeImage(), { signal: this.signal });
    this.signal?.throwIfAborted();
    this.prepared.set(config, { internalPorts, imageRef: image.Id ?? imageRef });
  }
  async deploy(
    config: DeployConfig,
    portBindings: Array<{ port: number; hostIp?: string; hostPort?: number }>,
    onLog?: LogCallback,
  ): Promise<DeploymentResult> {
    const serviceName = config.networkAlias ?? config.slug ?? config.projectId;
    const group = await this.runtime.ensureServiceGroup({
      ...config,
      slug: config.slug ?? config.projectId,
    });
    const ports = portBindings.map(
      (port) => `${port.hostIp ?? "127.0.0.1"}:${port.hostPort ?? ""}:${port.port}`,
    );
    const prepared = this.prepared.get(config)!;
    const ref = await this.create(
      group,
      {
        ...config,
        image: config.imageRef!,
        serviceName,
        ports,
        internalPorts: prepared.internalPorts,
        extraAliases: config.extraAliases,
      },
      async (replica) => {
        return this.runtime.deploy(
          {
            ...config,
            imageRef: prepared.imageRef,
            replicas: 1,
            replica,
            networkAlias: replicaContainerName(replica.group, replica.index),
            extraAliases: [],
          },
          onLog,
        );
      },
    );
    return { deploymentId: config.deploymentId, containerId: ref, status: "running" };
  }
  async deployService(
    group: MultiServiceGroupHandle,
    config: MultiServiceDeployConfig,
    onLog?: LogCallback,
  ): Promise<MultiServiceDeployResult> {
    const ports = [...config.ports];
    const parsed = parsePortBindings(ports);
    for (const port of [config.publicPort, ...(config.routedPorts ?? [])])
      if (port && !parsed.exposedPorts[`${port}/tcp`]) ports.push(`127.0.0.1::${port}`);
    const prepared = this.prepared.get(config)!;
    const ref = await this.create(
      group,
      { ...config, ports, internalPorts: prepared.internalPorts },
      (replica) =>
        this.runtime.deployServiceWorkload(
          group,
          {
            ...config,
            image: prepared.imageRef,
            imageAlreadyPrepared: true,
            forcePull: false,
            replicas: 1,
            replica,
            extraAliases: [],
          },
          onLog,
        ),
    );
    try {
      const info = await this.info(ref);
      const imageDigest = await this.runtime.resolveImageDigest(prepared.imageRef, config.image);
      return { ...info, containerId: ref, status: "running", imageDigest };
    } catch (error) {
      // diagnostics-ignore: fail() attempts cleanup and rethrows the original or aggregate failure.
      return this.fail(ref, error);
    }
  }
  private async create(
    network: MultiServiceGroupHandle,
    config: {
      projectId: string;
      deploymentId: string;
      serviceName: string;
      image: string;
      replicas?: number;
      ports: string[];
      internalPorts?: string[];
      extraAliases?: string[];
    },
    start: (replica: WorkloadReplicaIdentity) => Promise<{ containerId?: string }>,
  ) {
    this.signal?.throwIfAborted();
    const group = replicaGroupIdentity(config.projectId, config.deploymentId, config.serviceName);
    const ref = dockerReplicaRef(group);
    const count = config.replicas ?? 1;
    validateWorkloadReplicas(count);
    const ports = parsePortBindings(config.ports);
    for (const port of config.internalPorts ?? []) ports.exposedPorts[port] = {};
    const targets = Array.from({ length: count }, (_, index) =>
      replicaContainerName(group, index + 1),
    );
    const gateway = workloadGatewayContainer(
      workloadGatewayConfig(targets, Object.keys(ports.exposedPorts)),
    );
    // Persist intent before starting any application instance. Inventory and cleanup work after a process restart.
    const anchor = await this.runtime.docker.createContainer({
      ...gateway,
      name: replicaContainerName(group, 0),
      Image: resolveEdgeImage(),
      Labels: {
        "openship.project": config.projectId,
        "openship.deployment": config.deploymentId,
        "openship.service": config.serviceName,
        ...replicaLabels({ group, index: 0 }),
        [DESIRED_LABEL]: String(count),
        [REPLICA_IMAGE_LABEL]: config.image,
      },
      ExposedPorts: ports.exposedPorts,
      HostConfig: {
        ...gateway.HostConfig,
        NetworkMode: network.id,
        PortBindings: ports.portBindings,
      },
      NetworkingConfig: {
        EndpointsConfig: {
          [network.id]: { Aliases: buildNetworkAliases(config.serviceName, config.extraAliases) },
        },
      },
    });
    try {
      // Bounded creation avoids overwhelming a remote daemon; each member uses the existing Docker payload.
      for (let offset = 0; offset < count; offset += 4) {
        this.signal?.throwIfAborted();
        const results = await Promise.allSettled(
          targets
            .slice(offset, offset + 4)
            .map((_, index) =>
              start({ group, index: offset + index + 1, serviceName: config.serviceName }),
            ),
        );
        const failures = results.filter(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        if (failures.length)
          throw new AggregateError(
            failures.map((result) => result.reason),
            "An application instance could not start.",
          );
      }
      this.signal?.throwIfAborted();
      await anchor.start();
      if (!(await anchor.inspect()).State.Running)
        throw new Error("The replica gateway could not start.");
      return ref;
    } catch (error) {
      // diagnostics-ignore: fail() attempts cleanup and rethrows the original or aggregate failure.
      return this.fail(ref, error);
    }
  }
  private async fail(ref: string, error: unknown): Promise<never> {
    try {
      await this.destroy(ref);
    } catch (cleanupError) {
      reportCaughtError(cleanupError, "adapters/runtime/docker-replicas");
      throw new AggregateError(
        [error, cleanupError],
        "Replica deployment failed and needs cleanup.",
      );
    }
    throw error;
  }
  private async each(ids: string[], action: (id: string) => Promise<unknown>) {
    const failures: unknown[] = [];
    for (let offset = 0; offset < ids.length; offset += 4) {
      const settled = await Promise.allSettled(ids.slice(offset, offset + 4).map(action));
      for (const result of settled) if (result.status === "rejected") failures.push(result.reason);
    }
    if (failures.length)
      throw new AggregateError(failures, "One or more instance operations failed.");
  }
  async stop(ref: string) {
    const { anchor, members } = await this.members(ref, true);
    await this.runtime.stop(anchor.Id);
    await this.each(
      members.map((row) => row.Id),
      (id) => this.runtime.stop(id),
    );
  }
  async start(ref: string) {
    const { anchor, members } = await this.members(ref);
    await this.each(
      members.map((row) => row.Id),
      async (id) => {
        if ((await this.runtime.getContainerInfo(id)).status !== "running")
          await this.runtime.start(id);
      },
    );
    if ((await this.runtime.getContainerInfo(anchor.Id)).status === "running")
      await this.runtime.restart(anchor.Id);
    else await this.runtime.start(anchor.Id);
  }
  async restart(ref: string) {
    const { anchor, members } = await this.members(ref);
    await this.each(
      members.map((row) => row.Id),
      (id) => this.runtime.restart(id),
    );
    await this.runtime.restart(anchor.Id);
  }
  async destroy(ref: string) {
    let inventory: Awaited<ReturnType<DockerReplicas["members"]>>;
    try {
      inventory = await this.members(ref, true);
    } catch (error) {
      if (missing(error)) return;
      throw error;
    }
    await this.runtime.stop(inventory.anchor.Id);
    await this.each(
      inventory.members.map((row) => row.Id),
      (id) => this.runtime.destroy(id),
    );
    await this.runtime.destroy(inventory.anchor.Id);
  }
  async info(ref: string): Promise<ContainerInfo> {
    let inventory: Awaited<ReturnType<DockerReplicas["members"]>>;
    try {
      inventory = await this.members(ref, true);
    } catch (error) {
      if (missing(error)) return { containerId: ref, status: "missing" };
      throw error;
    }
    const { anchor, members, desired } = inventory;
    const infos = await Promise.all(members.map((row) => this.runtime.getContainerInfo(row.Id)));
    const gateway = await this.runtime.getContainerInfo(anchor.Id);
    const ready = infos.length === desired && infos.every((info) => info.status === "running");
    const limits = infos.map((info) => info.resources);
    const resources =
      limits.length && limits.every(Boolean)
        ? {
            cpuCores: limits.every((limit) => limit!.cpuCores > 0)
              ? limits.reduce((sum, limit) => sum + limit!.cpuCores, 0)
              : 0,
            memoryMb: limits.every((limit) => limit!.memoryMb > 0)
              ? limits.reduce((sum, limit) => sum + limit!.memoryMb, 0)
              : 0,
            ...(limits.every((limit) => limit!.swapDisabled) ? { swapDisabled: true } : {}),
          }
        : undefined;
    return {
      ...gateway,
      containerId: ref,
      imageId: infos[0]?.imageId,
      resources,
      status:
        members.length < desired
          ? "missing"
          : ready
            ? gateway.status
            : infos.every((info) => info.status === "stopped")
              ? "stopped"
              : "failed",
    };
  }
  async status(ref: string): Promise<ClusterWorkloadStatus> {
    const { anchor, members, desired } = await this.members(ref, true);
    const pods = await Promise.all(
      members.map(async (row) => {
        const data = await this.runtime.docker.getContainer(row.Id).inspect();
        return {
          name: `Instance ${row.Labels[REPLICA_INDEX_LABEL]}`,
          nodeName: null,
          ready:
            data.State.Running &&
            !data.State.Paused &&
            !data.State.Restarting &&
            !["starting", "unhealthy"].includes(data.State.Health?.Status ?? ""),
          phase: data.State.Status,
          restarts: data.RestartCount,
        };
      }),
    );
    const ready =
      anchor.State.Running && !anchor.State.Paused && !anchor.State.Restarting
        ? pods.filter((pod) => pod.ready).length
        : 0;
    return {
      desired,
      ready,
      available: ready,
      updated: pods.length,
      generation: 1,
      observedGeneration: 1,
      message:
        pods.length < desired
          ? "An instance is missing. Redeploy to restore the desired count."
          : null,
      pods,
    };
  }
  async stability(ref: string): Promise<ContainerStabilitySample> {
    let inventory: Awaited<ReturnType<DockerReplicas["members"]>>;
    try {
      inventory = await this.members(ref, true);
    } catch (error) {
      if (missing(error))
        return {
          state: "missing",
          exitCode: null,
          restartCount: 0,
          health: null,
          errorLine: null,
          oomKilled: false,
          restartPolicy: null,
        };
      throw error;
    }
    const { anchor, members, desired } = inventory;
    const samples = await Promise.all(
      [anchor.Id, ...members.map((row) => row.Id)].map((id) => this.runtime.sampleStability(id)),
    );
    const failed = samples.find(
      (sample) => sample.state !== "running" || sample.health === "unhealthy" || sample.oomKilled,
    );
    return {
      ...(failed ?? samples[0]!),
      state: members.length < desired ? "missing" : (failed?.state ?? "running"),
      health: samples.some((sample) => sample.health === "unhealthy")
        ? "unhealthy"
        : samples.some((sample) => sample.health === "starting")
          ? "starting"
          : null,
      restartCount: samples.reduce((sum, sample) => sum + sample.restartCount, 0),
    };
  }
  async logs(ref: string, tail = 200) {
    if (tail <= 0) return [];
    const { members } = await this.members(ref, true);
    const logs = await Promise.all(
      members.map(async (row) =>
        (await this.runtime.getRuntimeLogs(row.Id, Math.ceil(tail / members.length))).map(
          (line) => ({
            ...line,
            message: `[instance ${row.Labels[REPLICA_INDEX_LABEL]}] ${line.message}`,
          }),
        ),
      ),
    );
    return logs
      .flat()
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
      .slice(-tail);
  }
  async stream(ref: string, onLog: LogCallback, opts?: RuntimeLogStreamOptions) {
    const { members } = await this.members(ref, true);
    const stops: Array<() => void> = [];
    let ended = false;
    const cleanup = () => {
      ended = true;
      for (const stop of stops) stop();
    };
    const onEnd = (error?: Error) => {
      if (ended) return;
      cleanup();
      opts?.onEnd?.(error);
    };
    try {
      for (const row of members) {
        const stop = await this.runtime.streamRuntimeLogs(
          row.Id,
          (line) =>
            onLog({
              ...line,
              message: `[instance ${row.Labels[REPLICA_INDEX_LABEL]}] ${line.message}`,
            }),
          { ...opts, tail: Math.ceil((opts?.tail ?? 200) / members.length), onEnd },
        );
        if (ended) {
          stop();
          break;
        }
        stops.push(stop);
      }
    } catch (error) {
      cleanup();
      throw error;
    }
    return cleanup;
  }
  async usage(ref: string): Promise<ResourceUsage> {
    const { members, anchor } = await this.members(ref, true);
    const values = await Promise.all(
      [anchor.Id, ...members.map((row) => row.Id)].map((id) => this.runtime.getUsage(id)),
    );
    return values.reduce(
      (sum, value) => ({
        cpuPercent: sum.cpuPercent + value.cpuPercent,
        memoryMb: sum.memoryMb + value.memoryMb,
        diskMb: sum.diskMb + value.diskMb,
        networkRxBytes: sum.networkRxBytes + value.networkRxBytes,
        networkTxBytes: sum.networkTxBytes + value.networkTxBytes,
      }),
      { cpuPercent: 0, memoryMb: 0, diskMb: 0, networkRxBytes: 0, networkTxBytes: 0 },
    );
  }
  async primary(ref: string, allowIncomplete = false) {
    const { members } = await this.members(ref, allowIncomplete);
    if (!members.length)
      throw new AppError(
        "No application instances were found.",
        409,
        "WORKLOAD_REPLICAS_INCOMPLETE",
      );
    return members[0]!.Id;
  }

  async applyEnvironment(
    ref: string,
    environment: Record<string, string>,
    options: DockerEnvironmentOptions,
  ): Promise<DockerEnvironmentResult> {
    const { anchor, members } = await this.members(ref);
    if (
      anchor.Config.Labels?.["openship.project"] !== options.projectId ||
      anchor.Config.Labels?.["openship.service"] !== options.serviceName
    )
      throw new AppError("Replica workload ownership changed.", 409, "WORKLOAD_OWNERSHIP_CHANGED");
    const previous = await Promise.all(
      members.map((row) => this.runtime.docker.getContainer(row.Id).inspect()),
    );
    const applied: Array<{ id: string; before: Dockerode.ContainerInspectInfo }> = [];
    const reload = async () => {
      // HUP re-resolves member names without dropping established connections.
      await this.runtime.docker.getContainer(anchor.Id).kill({ signal: "HUP" });
    };
    try {
      for (const before of previous) {
        const changed = await this.runtime.applyEnvironment(before.Id, environment, {
          ...options,
          onReplaced: reload,
          onRestored: reload,
        });
        applied.push({ id: changed.containerId, before });
      }
      const result = { containerId: ref, ip: (await this.info(ref)).ip };
      await options.onReplaced(result);
      return result;
    } catch (error) {
      const failures: unknown[] = [];
      for (const item of applied.reverse()) {
        try {
          const oldEnvironment = Object.fromEntries(
            (item.before.Config.Env ?? []).map((value) => {
              const index = value.indexOf("=");
              return [value.slice(0, index), value.slice(index + 1)];
            }),
          );
          await this.runtime.applyEnvironment(item.id, oldEnvironment, {
            ...options,
            commandArgv: item.before.Config.Cmd ?? [],
            onReplaced: reload,
            onRestored: reload,
          });
        } catch (restoreError) {
          reportCaughtError(restoreError, "adapters/runtime/docker-replicas");
          failures.push(restoreError);
        }
      }
      if (failures.length)
        throw new AggregateError(
          [error, ...failures],
          "The environment could not be restored on every instance. Redeploy this workload.",
        );
      await options.onRestored?.({ containerId: ref, ip: (await this.info(ref)).ip });
      throw error;
    }
  }
}
