import { createHash } from "node:crypto";
import { listNamespaceResources, kubernetesProjectNamespace, projectNamespaceManifest } from "../cluster/namespace";
import { kubernetesIdLabel } from "../cluster/kubernetes-label";
import {
  AppError,
  clusterWorkloadNeedsOperator,
  registryForImage,
  validateClusterWorkload,
  type ClusterWorkloadConfig,
  type ClusterWorkloadStatus,
} from "@repo/core";
import type {
  BuildConfig,
  BuildResult,
  ContainerInfo,
  DeployConfig,
  DeploymentResult,
  ImageArtifactConfig,
  LogEntry,
  ResourceUsage,
} from "../types";
import type { RuntimeAdapter, RuntimeCapability, DeploymentRef } from "./types";
import { BuildLogger } from "./build-pipeline";
import type { DockerRuntime } from "./docker";
import { dockerConfigJsonFor, type DockerRegistryAuth } from "./docker-auth";
import {
  KubernetesApiError,
  type KubernetesApi,
  type KubernetesObject,
} from "../cluster/kubernetes-api";
import { splitRuntimeEnv, droppedRuntimeEnvMessage } from "./runtime-env";
import { ownsBuiltImage } from "./docker";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export { kubernetesProjectNamespace } from "../cluster/namespace";
const releaseName = (id: string) => `release-${digest(id).slice(0, 24)}`;
export const kubernetesBuildImageTag = (repository: string, buildId: string) =>
  `${repository}:${releaseName(buildId)}`;
const unsupported = (feature: string): never => {
  throw new AppError(
    `${feature} is not available for cluster workloads.`,
    422,
    "CAPABILITY_UNAVAILABLE",
  );
};
const isMissing = (error: unknown) =>
  error instanceof KubernetesApiError && error.statusCode === 404;
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });

/** Per-release Deployments keep rollback/history honest. Kubernetes Services
 * distribute traffic to ready pods; no OpenShip per-node process scheduler. */
export class KubernetesRuntime implements RuntimeAdapter {
  readonly name = "kubernetes";
  readonly capabilities: ReadonlySet<RuntimeCapability> = new Set([
    "build",
    "prebuiltImage",
    "deploy",
    "stop",
    "start",
    "restart",
    "destroy",
    "containerInfo",
    "runtimeLogs",
    "streamLogs",
    "containerIp",
    "rollback",
    "projectContainerSweep",
    "deploymentContainerQuery",
  ]);
  readonly namespace: string;
  private readonly lifetime = new AbortController();
  private operationSignal?: AbortSignal;
  setOperationSignal(signal: AbortSignal) {
    this.operationSignal = signal;
  }
  private get signal() {
    return AbortSignal.any([
      this.lifetime.signal,
      ...(this.operationSignal ? [this.operationSignal] : []),
    ]);
  }
  private builder?: Promise<DockerRuntime>;
  private readonly artifacts = new Map<string, string>();
  constructor(
    private readonly options: {
      api: KubernetesApi;
      projectId: string;
      runtimeId: string;
      edgePrivateIp: string;
      edgeSourceIps?: string[];
      servers?: ReadonlyArray<{ serverId: string; name: string; nodeName: string }>;
      config: ClusterWorkloadConfig;
      builder: () => Promise<DockerRuntime>;
      resolveRegistryAuth: (image: string) => Promise<DockerRegistryAuth | undefined>;
    },
  ) {
    validateClusterWorkload(options.config);
    this.namespace = kubernetesProjectNamespace(options.projectId);
  }
  supports(cap: RuntimeCapability) {
    return this.capabilities.has(cap);
  }
  private buildRuntime() {
    return (this.builder ??= this.options.builder());
  }
  private get base() {
    return `/apis/apps/v1/namespaces/${this.namespace}/deployments`;
  }
  private get core() {
    return `/api/v1/namespaces/${this.namespace}`;
  }
  private labels(deploymentId?: string) {
    return {
      "app.kubernetes.io/managed-by": "openship",
      "openship.io/project": kubernetesIdLabel(this.options.projectId),
      "openship.io/runtime": this.options.runtimeId,
      ...(deploymentId ? { "openship.io/deployment": kubernetesIdLabel(deploymentId) } : {}),
    };
  }
  private assertOwned(object: KubernetesObject) {
    const labels = object.metadata.labels ?? {};
    for (const [key, value] of Object.entries(this.labels()))
      if (labels[key] !== value)
        throw new AppError(
          "A Kubernetes resource at this address is not owned by this project and cluster. It was left unchanged.",
          409,
          "CLUSTER_WORKLOAD_OWNERSHIP",
        );
  }
  private ref(name: string) {
    return `k8s:${this.namespace}:${name}`;
  }
  private refName(ref: string) {
    const prefix = `k8s:${this.namespace}:`;
    if (!ref.startsWith(prefix) || !/^release-[a-f0-9]{24}$/.test(ref.slice(prefix.length)))
      throw new AppError(
        "This workload reference belongs to another project.",
        409,
        "CLUSTER_WORKLOAD_OWNERSHIP",
      );
    return ref.slice(prefix.length);
  }
  private async owned(path: string) {
    const object = await this.options.api.request("GET", path, undefined, this.lifetime.signal);
    this.assertOwned(object);
    return object;
  }
  private async create(path: string, object: KubernetesObject) {
    try {
      return await this.options.api.request("POST", path, object, this.signal);
    } catch (error) {
      if (!(error instanceof KubernetesApiError && error.statusCode === 409)) throw error;
      const existing = await this.owned(`${path}/${object.metadata.name}`);
      const hash = object.metadata.annotations?.["openship.io/config"];
      if (hash && existing.metadata.annotations?.["openship.io/config"] !== hash)
        throw new AppError(
          "This release already has different configuration. Start a new deployment.",
          409,
          "CLUSTER_WORKLOAD_CONFLICT",
        );
      return existing;
    }
  }
  private async ensureNamespace() {
    await this.create("/api/v1/namespaces", projectNamespaceManifest(this.options.projectId, this.options.runtimeId));
    // Ingress is restricted to this project's pods and its OpenShip Edge host.
    // Existing Docker network links are rejected at preflight until translated.
    await this.create(`/apis/networking.k8s.io/v1/namespaces/${this.namespace}/networkpolicies`, {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: { name: "project-ingress", namespace: this.namespace, labels: this.labels() },
      spec: {
        podSelector: {},
        policyTypes: ["Ingress"],
        ingress: [
          {
            from: [
              { podSelector: {} },
              ...(this.options.edgeSourceIps ?? [this.options.edgePrivateIp]).map((ip) => ({
                ipBlock: { cidr: `${ip}/32` },
              })),
            ],
          },
        ],
      },
    });
  }
  private async rememberArchitecture(imageRef: string, builder: DockerRuntime) {
    const image = await builder.docker.getImage(imageRef).inspect();
    if (!["amd64", "arm64"].includes(image.Architecture) || image.Os !== "linux")
      throw new Error("Cluster applications require a Linux amd64 or arm64 image.");
    this.artifacts.set(imageRef, image.Architecture);
  }
  async build(config: BuildConfig, logger?: BuildLogger): Promise<BuildResult> {
    if (!this.options.config.imageRepository)
      throw new Error("Choose a registry repository for cluster source builds.");
    const builder = await this.buildRuntime();
    const result = await builder.build(config, logger);
    if (!result.imageRef || result.status === "failed" || result.status === "cancelled")
      return result;
    logger?.log(
      "Publishing this release so every eligible cluster server can pull the same image.\n",
    );
    await this.rememberArchitecture(result.imageRef, builder);
    const publishedTag = kubernetesBuildImageTag(
      this.options.config.imageRepository,
      config.sessionId,
    );
    try {
      const imageRef = await builder.publishImage(result.imageRef, publishedTag, this.signal);
      this.artifacts.set(imageRef, this.artifacts.get(result.imageRef)!);
      return { ...result, imageRef, artifactOwned: false };
    } finally {
      // Kubernetes pulls from the registry; the builder's generated aliases
      // are disposable cache, not the retained release artifact.
      for (const image of [
        publishedTag,
        ...(ownsBuiltImage(result.imageRef) ? [result.imageRef] : []),
      ]) {
        await builder
          .removeImage(image)
          .catch((error) =>
            logger?.log(
              `Local build image cleanup deferred: ${error instanceof Error ? error.message : String(error)}\n`,
              "warn",
            ),
          );
      }
    }
  }
  async prepareImage(config: ImageArtifactConfig, logger?: BuildLogger): Promise<BuildResult> {
    const builder = await this.buildRuntime();
    const result = await builder.prepareImage(config, logger);
    if (result.status === "failed" || result.status === "cancelled") return result;
    if (result.imageRef) {
      if (!/@sha256:[a-f0-9]{64}$/.test(result.imageRef))
        throw new Error(
          "The registry did not provide an immutable image digest. Retry after checking the image repository.",
        );
      await this.rememberArchitecture(result.imageRef, builder);
    }
    return result;
  }
  async cancelBuild(id: string) {
    if (this.builder) await (await this.builder).cancelBuild(id);
  }
  async getBuildLogs(id: string) {
    return this.builder ? (await this.builder).getBuildLogs(id) : [];
  }
  async deploy(config: DeployConfig, onLog?: (entry: LogEntry) => void): Promise<DeploymentResult> {
    if (config.projectId !== this.options.projectId)
      throw new Error("Cluster project identity mismatch");
    if (config.volumes?.length || config.adopt)
      unsupported("Persistent mounts and process adoption");
    if (clusterWorkloadNeedsOperator(undefined, config.imageRef))
      throw new AppError(
        "Database workloads need an engine operator and persistent storage before cluster deployment.",
        422,
        "CLUSTER_WORKLOAD_UNSUPPORTED",
      );
    if (!config.imageRef || !/@sha256:[a-f0-9]{64}$/.test(config.imageRef))
      throw new Error("Cluster releases require an immutable registry image digest.");
    if (!this.artifacts.has(config.imageRef)) {
      const builder = await this.buildRuntime();
      await builder.pullImage(config.imageRef);
      await this.rememberArchitecture(config.imageRef, builder);
    }
    await this.ensureNamespace();
    const name = releaseName(config.deploymentId);
    const labels = this.labels(config.deploymentId);
    const metadata = { name, namespace: this.namespace, labels };
    const auth = await this.options.resolveRegistryAuth(config.imageRef);
    const projectEnv = splitRuntimeEnv(config.envVars);
    if (projectEnv.dropped.length)
      onLog?.({
        timestamp: new Date().toISOString(),
        level: "warn",
        message: droppedRuntimeEnvMessage(projectEnv.dropped),
      });
    const env = {
      NODE_ENV: config.environment === "production" ? "production" : "development",
      ...(!config.portless ? { PORT: String(config.port) } : {}),
      ...Object.fromEntries(projectEnv.entries),
    };
    const secretData = Object.fromEntries(
      Object.entries(env).map(([key, value]) => [key, Buffer.from(value).toString("base64")]),
    );
    const registry = registryForImage(config.imageRef);
    const pullJson = auth
      ? dockerConfigJsonFor({
          ...auth,
          serveraddress: registry === "docker.io" ? "https://index.docker.io/v1/" : registry,
        } as DockerRegistryAuth)
      : null;
    const pullData = pullJson ? Buffer.from(pullJson).toString("base64") : undefined;
    const ports = config.portless
      ? []
      : [
          ...new Set([
            config.port,
            ...(config.publicEndpoints ?? [])
              .map((p) => p.port)
              .filter((p): p is number => typeof p === "number"),
          ]),
        ];
    const limits: Record<string, string> = {};
    if (config.resources.cpuCores > 0) limits.cpu = String(config.resources.cpuCores);
    if (config.resources.memoryMb > 0) limits.memory = `${config.resources.memoryMb}Mi`;
    const spec = {
      replicas: this.options.config.replicas,
      revisionHistoryLimit: 2,
      progressDeadlineSeconds: 300,
      minReadySeconds: 5,
      selector: { matchLabels: { "openship.io/deployment": kubernetesIdLabel(config.deploymentId) } },
      template: {
        metadata: { labels },
        spec: {
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          nodeSelector: {
            "openship.io/runtime": this.options.runtimeId,
            "kubernetes.io/arch": this.artifacts.get(config.imageRef),
          },
          topologySpreadConstraints: [
            {
              maxSkew: 1,
              topologyKey: "kubernetes.io/hostname",
              whenUnsatisfiable: "ScheduleAnyway",
              labelSelector: { matchLabels: { "openship.io/project": kubernetesIdLabel(this.options.projectId) } },
            },
          ],
          ...(pullData ? { imagePullSecrets: [{ name: `${name}-registry` }] } : {}),
          containers: [
            {
              name: "app",
              image: config.imageRef,
              imagePullPolicy: "IfNotPresent",
              ...(config.startCommand?.trim() ? { args: ["sh", "-c", config.startCommand] } : {}),
              envFrom: [{ secretRef: { name: `${name}-env` } }],
              resources: { requests: limits, limits },
              securityContext: {
                allowPrivilegeEscalation: false,
                capabilities: { drop: ["ALL"], add: ["NET_BIND_SERVICE"] },
                seccompProfile: { type: "RuntimeDefault" },
              },
              ...(ports.length
                ? {
                    ports: ports.map((port) => ({ containerPort: port })),
                    readinessProbe: {
                      tcpSocket: { port: config.port },
                      periodSeconds: 3,
                      failureThreshold: 10,
                    },
                  }
                : {}),
            },
          ],
          terminationGracePeriodSeconds: 30,
        },
      },
    };
    const hash = digest(JSON.stringify({ spec, secretData, pullData }));
    const deployment = await this.create(this.base, {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: {
        ...metadata,
        annotations: {
          "openship.io/config": hash,
          "openship.io/replicas": String(this.options.config.replicas),
          ...(config.previousDeploymentId
            ? { "openship.io/previous": releaseName(config.previousDeploymentId) }
            : {}),
        },
      },
      spec,
    });
    const ownerReferences = [
      { apiVersion: "apps/v1", kind: "Deployment", name, uid: deployment.metadata.uid! },
    ];
    try {
      await this.create(`${this.core}/secrets`, {
        apiVersion: "v1",
        kind: "Secret",
        metadata: {
          ...metadata,
          name: `${name}-env`,
          ownerReferences,
          annotations: { "openship.io/config": hash },
        },
        type: "Opaque",
        data: secretData,
      });
      if (pullData)
        await this.create(`${this.core}/secrets`, {
          apiVersion: "v1",
          kind: "Secret",
          metadata: {
            ...metadata,
            name: `${name}-registry`,
            ownerReferences,
            annotations: { "openship.io/config": hash },
          },
          type: "kubernetes.io/dockerconfigjson",
          data: { ".dockerconfigjson": pullData },
        });
      if (ports.length)
        await this.create(`${this.core}/services`, {
          apiVersion: "v1",
          kind: "Service",
          metadata: { ...metadata, ownerReferences },
          spec: {
            type: "ClusterIP",
            selector: { "openship.io/deployment": kubernetesIdLabel(config.deploymentId) },
            ports: ports.map((port) => ({
              name: `tcp-${port}`,
              port,
              targetPort: port,
              protocol: "TCP",
            })),
          },
        });
      onLog?.({
        timestamp: new Date().toISOString(),
        level: "info",
        message: `Waiting for ${this.options.config.replicas} cluster replicas to become ready.`,
        step: "deploy",
      });
      await this.waitReady(name, onLog);
      await this.activateService(name);
      return { deploymentId: config.deploymentId, containerId: this.ref(name), status: "running" };
    } catch (error) {
      const observed = await this.status(this.ref(name)).catch(() => null);
      const detail = observed?.pods
        .filter((pod) => !pod.ready)
        .map((pod) => `${pod.nodeName ?? pod.name}: ${pod.phase}`)
        .join("; ");
      const message = `${error instanceof Error ? error.message : String(error)}${detail ? ` (${detail})` : ""}`;
      onLog?.({ timestamp: new Date().toISOString(), level: "error", message, step: "deploy" });
      try {
        await this.destroy(this.ref(name));
      } catch (cleanup) {
        onLog?.({
          timestamp: new Date().toISOString(),
          level: "warn",
          message: `Could not confirm cleanup of ${name}: ${cleanup instanceof Error ? cleanup.message : String(cleanup)}`,
          step: "deploy",
        });
      }
      throw new Error(message);
    }
  }
  private async activateService(name: string) {
    let release: KubernetesObject;
    try {
      release = await this.owned(`${this.core}/services/${name}`);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    const path = `${this.core}/services`;
    let current: KubernetesObject | null = null;
    try {
      current = await this.owned(`${path}/app`);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const spec = { selector: release.spec.selector, ports: release.spec.ports, type: "ClusterIP" };
    if (current)
      await this.options.api.request(
        "PATCH",
        `${path}/app`,
        { metadata: { resourceVersion: current.metadata.resourceVersion }, spec },
        this.lifetime.signal,
      );
    else
      await this.create(path, {
        apiVersion: "v1",
        kind: "Service",
        metadata: { name: "app", namespace: this.namespace, labels: this.labels() },
        spec,
      });
  }
  private async waitReady(name: string, onLog?: (entry: LogEntry) => void) {
    const signal = AbortSignal.any([this.signal, AbortSignal.timeout(6 * 60_000)]);
    let failures = 0;
    let previousStatus = "";
    while (true) {
      signal.throwIfAborted();
      const deployment = await this.owned(`${this.base}/${name}`);
      const ready = (value: KubernetesObject) =>
        (value.status?.observedGeneration ?? 0) >= (value.metadata.generation ?? 0) &&
        (value.status?.availableReplicas ?? 0) >= value.spec.replicas &&
        (value.status?.updatedReplicas ?? 0) >= value.spec.replicas;
      const check = (value: KubernetesObject) => {
        this.assertOwned(value);
        const status = `${value.status?.availableReplicas ?? 0}/${value.spec.replicas} replicas ready`;
        if (status !== previousStatus) {
          previousStatus = status;
          onLog?.({
            timestamp: new Date().toISOString(),
            level: "info",
            message: status,
            step: "deploy",
          });
        }
        const failure = value.status?.conditions?.find(
          (c: { type: string; status: string }) => c.type === "Progressing" && c.status === "False",
        );
        if (failure)
          throw new AppError(
            failure.message || "Kubernetes could not make this release ready.",
            409,
            "CLUSTER_ROLLOUT_FAILED",
          );
        return ready(value);
      };
      if (check(deployment)) return;
      try {
        for await (const event of this.options.api.watch(
          `${this.base}?watch=1&allowWatchBookmarks=true&timeoutSeconds=30&fieldSelector=metadata.name%3D${name}&resourceVersion=${encodeURIComponent(deployment.metadata.resourceVersion ?? "")}`,
          signal,
        )) {
          if (event.type === "ERROR") {
            if (event.object.code === 410) break;
            throw new KubernetesApiError(
              event.object.code ?? 500,
              event.object.message ?? "Kubernetes watch failed",
            );
          }
          if (event.type === "DELETED")
            throw new AppError(
              "The cluster workload was removed during deployment.",
              409,
              "CLUSTER_ROLLOUT_FAILED",
            );
          if (event.type !== "BOOKMARK" && check(event.object)) return;
        }
        failures = 0;
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof AppError && !(error instanceof KubernetesApiError)) throw error;
        if (error instanceof KubernetesApiError && error.statusCode === 410) continue;
        if (++failures > 3) throw error;
        onLog?.({
          timestamp: new Date().toISOString(),
          level: "warn",
          message: "Reconnecting to Kubernetes rollout status…",
          step: "deploy",
        });
        await sleep(500 * 2 ** failures, signal);
      }
    }
  }
  async status(ref: string): Promise<ClusterWorkloadStatus> {
    const deployment = await this.owned(`${this.base}/${this.refName(ref)}`);
    const selector = encodeURIComponent(
      `openship.io/deployment=${deployment.metadata.labels!["openship.io/deployment"]}`,
    );
    const pods = await this.options.api.request<{ items: KubernetesObject[] }>(
      "GET",
      `${this.core}/pods?labelSelector=${selector}`,
      undefined,
      this.lifetime.signal,
    );
    return {
      desired: deployment.spec.replicas,
      ready: deployment.status?.readyReplicas ?? 0,
      available: deployment.status?.availableReplicas ?? 0,
      updated: deployment.status?.updatedReplicas ?? 0,
      generation: deployment.metadata.generation ?? 0,
      observedGeneration: deployment.status?.observedGeneration ?? 0,
      message:
        deployment.status?.conditions?.find(
          (c: { type: string; status: string }) => c.type === "Progressing" && c.status === "False",
        )?.message ?? null,
      pods: pods.items.map((pod) => {
        this.assertOwned(pod);
        const server = this.options.servers?.find(
          (candidate) => candidate.nodeName === pod.spec?.nodeName,
        );
        return {
          name: pod.metadata.name!,
          nodeName: pod.spec?.nodeName ?? null,
          serverId: server?.serverId ?? null,
          serverName: server?.name ?? null,
          ready: !!pod.status?.conditions?.some(
            (c: { type: string; status: string }) => c.type === "Ready" && c.status === "True",
          ),
          phase:
            pod.status?.containerStatuses?.find((c: any) => c.state?.waiting)?.state.waiting
              .reason ??
            pod.status?.phase ??
            "Unknown",
          restarts: (pod.status?.containerStatuses ?? []).reduce(
            (sum: number, c: any) => sum + (c.restartCount ?? 0),
            0,
          ),
        };
      }),
    };
  }
  private async replicas(ref: string, count?: number) {
    const path = `${this.base}/${this.refName(ref)}`;
    const value = await this.owned(path);
    const replicas = count ?? Number(value.metadata.annotations?.["openship.io/replicas"] ?? 1);
    await this.options.api.request(
      "PATCH",
      path,
      { metadata: { resourceVersion: value.metadata.resourceVersion }, spec: { replicas } },
      this.lifetime.signal,
    );
  }
  async stop(ref: string) {
    await this.replicas(ref, 0);
  }
  async start(ref: string) {
    await this.replicas(ref);
    await this.waitReady(this.refName(ref));
    await this.activateService(this.refName(ref));
  }
  async restart(ref: string) {
    const path = `${this.base}/${this.refName(ref)}`;
    const value = await this.owned(path);
    await this.options.api.request(
      "PATCH",
      path,
      {
        metadata: { resourceVersion: value.metadata.resourceVersion },
        spec: {
          template: {
            metadata: { annotations: { "openship.io/restarted-at": new Date().toISOString() } },
          },
        },
      },
      this.lifetime.signal,
    );
    await this.waitReady(this.refName(ref));
  }
  async destroy(ref: string) {
    const path = `${this.base}/${this.refName(ref)}`;
    let value: KubernetesObject;
    try {
      value = await this.owned(path);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    // A failed new release may already have switched the internal alias. Restore
    // the still-running previous release before removing it; never guess a peer.
    try {
      const active = await this.owned(`${this.core}/services/app`);
      if (
        active.spec.selector?.["openship.io/deployment"] ===
        value.metadata.labels?.["openship.io/deployment"]
      ) {
        const previous = value.metadata.annotations?.["openship.io/previous"];
        let restored = false;
        if (previous && /^release-[a-f0-9]{24}$/.test(previous)) {
          try {
            const old = await this.owned(`${this.base}/${previous}`);
            if ((old.status?.availableReplicas ?? 0) > 0 && old.spec.replicas > 0) {
              await this.activateService(previous);
              restored = true;
            }
          } catch (error) {
            if (!isMissing(error)) throw error;
          }
        }
        if (!restored)
          await this.options.api.request(
            "DELETE",
            `${this.core}/services/app`,
            {
              preconditions: {
                uid: active.metadata.uid,
                resourceVersion: active.metadata.resourceVersion,
              },
            },
            this.lifetime.signal,
          );
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    await this.options.api.request(
      "DELETE",
      path,
      { propagationPolicy: "Foreground", preconditions: { uid: value.metadata.uid } },
      this.lifetime.signal,
    );
  }
  async getContainerInfo(ref: string): Promise<ContainerInfo> {
    let status: ClusterWorkloadStatus;
    try {
      status = await this.status(ref);
    } catch (error) {
      if (isMissing(error)) return { containerId: ref, status: "missing" };
      throw error;
    }
    return {
      containerId: ref,
      status:
        status.desired === 0
          ? "stopped"
          : status.available >= status.desired && status.observedGeneration >= status.generation
            ? "running"
            : "deploying",
      ip: (await this.getContainerIp(ref)) ?? undefined,
    };
  }
  async getContainerIp(ref: string) {
    try {
      return (await this.owned(`${this.core}/services/${this.refName(ref)}`)).spec
        .clusterIP as string;
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }
  async listProjectContainerIds(projectId: string) {
    if (projectId !== this.options.projectId) throw new Error("Cluster project identity mismatch");
    try {
      const list = await this.options.api.request<{ items: KubernetesObject[] }>(
        "GET",
        `${this.base}?labelSelector=${encodeURIComponent(`openship.io/project=${kubernetesIdLabel(projectId)}`)}`,
        undefined,
        this.lifetime.signal,
      );
      return list.items.map((object) => {
        this.assertOwned(object);
        return this.ref(object.metadata.name!);
      });
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }
  async listDeploymentContainers(id: string) {
    try {
      const info = await this.getContainerInfo(this.ref(releaseName(id)));
      return info.status === "missing"
        ? []
        : [{ containerId: info.containerId, status: info.status }];
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }
  private logEntry(line: string, pod: string): LogEntry {
    const split = line.indexOf(" ");
    const timestamp = split > 0 ? line.slice(0, split) : "";
    return {
      timestamp: Number.isNaN(Date.parse(timestamp)) ? new Date().toISOString() : timestamp,
      level: "info",
      message: `[${pod}] ${split > 0 ? line.slice(split + 1) : line}`,
    };
  }
  async getRuntimeLogs(ref: string, tail = 100): Promise<LogEntry[]> {
    const status = await this.status(ref);
    const result: LogEntry[] = [];
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(30_000)]);
    for (let index = 0; index < status.pods.length; index += 4) {
      await Promise.all(
        status.pods.slice(index, index + 4).map(async (pod) => {
          try {
            for await (const line of this.options.api.logs(
              `${this.core}/pods/${pod.name}/log?container=app&timestamps=true&tailLines=${Math.max(1, Math.min(tail, 2000))}`,
              signal,
            ))
              result.push(this.logEntry(line, pod.name));
          } catch (error) {
            if (
              !isMissing(error) &&
              !(error instanceof KubernetesApiError && error.statusCode === 400)
            )
              throw error;
          }
        }),
      );
    }
    return result.sort((a, b) => a.timestamp.localeCompare(b.timestamp)).slice(-tail);
  }
  async streamRuntimeLogs(ref: string, onLog: (entry: LogEntry) => void): Promise<() => void> {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.lifetime.signal]);
    const deployment = await this.owned(`${this.base}/${this.refName(ref)}`);
    const selector = encodeURIComponent(
      `openship.io/deployment=${deployment.metadata.labels!["openship.io/deployment"]}`,
    );
    const path = `${this.core}/pods?labelSelector=${selector}`;
    const streams = new Map<string, AbortController>();
    const pods = new Map<string, KubernetesObject>();
    let warned = false;
    const synchronize = () => {
      // Reserve channels for status/watch/control requests. Historical logs
      // still aggregate every replica; live followers have an explicit limit.
      const selected = [...pods.values()]
        .filter((pod) => pod.status?.phase === "Running" && !pod.metadata.deletionTimestamp)
        .sort((a, b) => a.metadata.name!.localeCompare(b.metadata.name!))
        .slice(0, 6);
      const names = new Set(selected.map((pod) => pod.metadata.name!));
      for (const [name, stream] of streams)
        if (!names.has(name)) {
          stream.abort();
          streams.delete(name);
        }
      if (pods.size > 6 && !warned) {
        warned = true;
        onLog({
          timestamp: new Date().toISOString(),
          level: "info",
          message:
            "Live logs follow up to 6 replicas. Refresh logs to read recent output across all replicas.",
        });
      }
      for (const pod of selected) {
        const name = pod.metadata.name!;
        if (streams.has(name)) continue;
        const follower = new AbortController();
        streams.set(name, follower);
        const followSignal = AbortSignal.any([signal, follower.signal]);
        void (async () => {
          let since = new Date().toISOString();
          while (!followSignal.aborted) {
            try {
              for await (const line of this.options.api.logs(
                `${this.core}/pods/${name}/log?container=app&timestamps=true&follow=true&sinceTime=${encodeURIComponent(since)}&tailLines=2000`,
                followSignal,
              )) {
                const entry = this.logEntry(line, name);
                since = entry.timestamp;
                onLog(entry);
              }
            } catch (error) {
              if (isMissing(error) || followSignal.aborted) return;
              if (error instanceof KubernetesApiError && [401, 403].includes(error.statusCode)) {
                onLog({
                  timestamp: new Date().toISOString(),
                  level: "warn",
                  message: `Live logs unavailable for ${name}: ${error.message}`,
                });
                return;
              }
            }
            await sleep(1000, followSignal).catch(() => {});
          }
        })().catch(() => {});
      }
    };
    const readPods = async () => {
      const list = await this.options.api.request<{
        items: KubernetesObject[];
        metadata: { resourceVersion: string };
      }>("GET", path, undefined, signal);
      pods.clear();
      for (const pod of list.items) {
        this.assertOwned(pod);
        pods.set(pod.metadata.name!, pod);
      }
      synchronize();
      return list.metadata.resourceVersion;
    };
    let version: string;
    try {
      version = await readPods();
    } catch (error) {
      controller.abort();
      throw error;
    }
    void (async () => {
      while (!signal.aborted) {
        try {
          for await (const event of this.options.api.watch(
            `${path}&watch=1&allowWatchBookmarks=true&timeoutSeconds=30&resourceVersion=${encodeURIComponent(version)}`,
            signal,
          )) {
            if (event.type === "ERROR") {
              if (event.object.code === 410) {
                version = await readPods();
                break;
              }
              throw new KubernetesApiError(event.object.code ?? 500, "Pod log status watch failed");
            }
            version = event.object.metadata.resourceVersion ?? version;
            if (event.type === "BOOKMARK") continue;
            this.assertOwned(event.object);
            if (event.type === "DELETED") pods.delete(event.object.metadata.name!);
            else pods.set(event.object.metadata.name!, event.object);
            synchronize();
          }
        } catch (error) {
          if (signal.aborted) return;
          if (error instanceof AppError && !(error instanceof KubernetesApiError)) throw error;
          await sleep(1000, signal);
          version = await readPods();
        }
      }
    })().catch((error) => {
      if (!signal.aborted)
        onLog({
          timestamp: new Date().toISOString(),
          level: "warn",
          message: `Cluster log stream stopped: ${error instanceof Error ? error.message : String(error)}`,
        });
      controller.abort();
    });
    return () => controller.abort();
  }
  async getUsage(_ref: string): Promise<ResourceUsage> {
    return unsupported("Cluster usage metrics");
  }
  async archive(deployment: DeploymentRef) {
    if (deployment.containerId) {
      try {
        await this.stop(deployment.containerId);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
  }
  async purge(deployment: DeploymentRef) {
    if (deployment.containerId) await this.destroy(deployment.containerId);
  }
  async cleanupProject(projectId: string) {
    if (projectId !== this.options.projectId) throw new Error("Cluster project identity mismatch");
    let namespace: KubernetesObject;
    try {
      namespace = await this.owned(`/api/v1/namespaces/${this.namespace}`);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(90_000)]);
    // Foreground Deployment deletion must finish before inspecting its children.
    while ((await this.listProjectContainerIds(projectId)).length) await sleep(1000, signal);
    const objects = await listNamespaceResources(this.options.api, this.namespace, signal);
    // Never turn an application delete into deleting manually attached data or
    // an operator-managed service. Discovery covers custom resources as well.
    const acceptable = new Set<string>();
    const managedKinds = new Set([
      "Deployment",
      "ReplicaSet",
      "Pod",
      "Service",
      "Endpoints",
      "EndpointSlice",
      "Secret",
      "NetworkPolicy",
    ]);
    for (const object of objects) {
      if (object.kind === "PersistentVolumeClaim")
        throw new Error(
          "This project namespace contains persistent storage. Remove or migrate it before deleting the project.",
        );
      if (
        (object.kind === "ConfigMap" && object.metadata.name === "kube-root-ca.crt") ||
        (object.kind === "ServiceAccount" && object.metadata.name === "default")
      ) {
        acceptable.add(object.metadata.uid!);
        continue;
      }
      if (!managedKinds.has(object.kind!))
        throw new Error(
          `Project namespace contains unmanaged ${object.kind} ${object.metadata.name}. It was left unchanged.`,
        );
      try {
        this.assertOwned(object);
        acceptable.add(object.metadata.uid!);
      } catch {}
    }
    for (let pass = 0; pass < objects.length; pass++) {
      let added = false;
      for (const object of objects)
        if (
          !acceptable.has(object.metadata.uid!) &&
          object.metadata.ownerReferences?.some((owner) => acceptable.has(owner.uid))
        ) {
          acceptable.add(object.metadata.uid!);
          added = true;
        }
      if (!added) break;
    }
    const foreign = objects.find((object) => !acceptable.has(object.metadata.uid!));
    if (foreign)
      throw new Error(
        `Project namespace contains unmanaged ${foreign.kind ?? "resource"} ${foreign.metadata.name}. It was left unchanged.`,
      );
    await this.options.api.request(
      "DELETE",
      `/api/v1/namespaces/${this.namespace}`,
      { propagationPolicy: "Foreground", preconditions: { uid: namespace.metadata.uid } },
      signal,
    );
    while (true) {
      try {
        await this.options.api.request(
          "GET",
          `/api/v1/namespaces/${this.namespace}`,
          undefined,
          signal,
        );
      } catch (error) {
        if (isMissing(error)) return;
        throw error;
      }
      await sleep(1000, signal);
    }
  }
  async dispose() {
    this.lifetime.abort();
    await this.options.api.dispose();
    if (this.builder) await (await this.builder).dispose();
  }
}
