import net from "node:net";
import { parse } from "yaml";
import {
  AppError,
  clusterWorkloadNeedsOperator,
  infrastructureCidr,
  validateClusterWorkload,
} from "@repo/core";
import { repos } from "@repo/db";
import { KubernetesRuntime, createKubernetesApi, privilegedExecutor } from "@repo/adapters";
import { env } from "../config";
import { inspectHostIssuedIdentity } from "./host-port-target";
import { resolveHostPortTargetIdentity } from "./host-port-target";
import { sshManager } from "./ssh-manager";
import { registryAuthResolver } from "../modules/credentials/registry-auth";
import { usesPrivateNetwork } from "../modules/projects/project-connection.util";
import {
  createServerDockerRuntime,
  resolveServerExecutor,
  resolveTargetPlatform,
  type DeploymentMeta,
  type ResolvedDeploymentPlatform,
} from "./deployment-runtime";
import { requireManagedOrgServer } from "./server-target";

export async function requireClusterDeploymentTarget(
  organizationId: string,
  clusterId: string,
  runtimeId?: string,
) {
  if (env.CLOUD_MODE)
    throw new AppError(
      "Server clusters are available on self-hosted OpenShip.",
      404,
      "CAPABILITY_UNAVAILABLE",
    );
  const cluster = await repos.computeCluster.get(organizationId, clusterId);
  const runtime = await repos.clusterRuntime.get(organizationId, clusterId);
  if (
    !runtime ||
    runtime.status !== "ready" ||
    !runtime.plan.clusterUid ||
    (runtimeId && runtime.id !== runtimeId)
  )
    throw new AppError(
      "This cluster is not ready for scaling, or its installation has changed. Open the cluster to review its setup.",
      409,
      "CLUSTER_NOT_READY",
    );
  if (
    cluster.serverIds.length !== runtime.plan.hosts.length ||
    runtime.plan.hosts.some((host) => !cluster.serverIds.includes(host.serverId))
  )
    throw new AppError(
      "The servers in this cluster have changed since scaling was verified. Open the cluster to review its setup.",
      409,
      "CLUSTER_RUNTIME_CHANGED",
    );
  await Promise.all(cluster.serverIds.map(serverId => requireManagedOrgServer(serverId, organizationId)));
  return { cluster, runtime };
}

export async function assertClusterWorkloadSupported(input: {
  projectId: string;
  workload: string;
  volumes?: string[];
  services?: unknown[];
  framework?: string | null;
  image?: string;
  imageRepository?: string;
}) {
  if (
    input.workload === "static" ||
    input.volumes?.length ||
    input.services?.length ||
    clusterWorkloadNeedsOperator(input.framework, input.image)
  )
    throw new AppError(
      "Scaling currently supports applications and workers that can run independently. Databases and applications with persistent storage need a separate replication and storage setup. Compose stacks must stay on their current target.",
      422,
      "CLUSTER_WORKLOAD_UNSUPPORTED",
    );
  if (!input.image && !input.imageRepository)
    throw new AppError(
      "Choose a registry repository for this project's source builds. Cluster nodes need a shared image to pull.",
      422,
      "CLUSTER_REGISTRY_REQUIRED",
    );
  const links = [
    ...(await repos.projectConnection.listBySource(input.projectId)),
    ...(await repos.projectConnection.listByTarget(input.projectId)),
  ];
  if (links.some(usesPrivateNetwork))
    throw new AppError(
      "This project has connections on a Docker private network. Configure connections reachable from the server cluster before moving this application.",
      422,
      "CLUSTER_CONNECTIONS_UNSUPPORTED",
    );
}

/** Shared, identity-verified API transport for workloads and database operators. */
export async function openClusterApi(
  organizationId: string,
  clusterId: string,
  runtimeId?: string,
) {
  const { runtime } = await requireClusterDeploymentTarget(
    organizationId,
    clusterId,
    runtimeId,
  );
  const gateway = runtime.plan.hosts.find((host) => host.role === "server")!;
  const target = await resolveServerExecutor(gateway.serverId, organizationId);
  if ((await inspectHostIssuedIdentity(target.executor)) !== gateway.hostIdentity)
    throw new AppError(
      "The cluster gateway's machine identity changed. Restore its inventory connection before deploying.",
      409,
      "CLUSTER_HOST_CHANGED",
    );
  const privileged = await privilegedExecutor(target.executor, "Connecting to the cluster API");
  if (!privileged.supported) throw new AppError(privileged.reason, 409, "CLUSTER_API_UNAVAILABLE");
  const owner = JSON.parse(
    await privileged.value.executor.readFile("/var/lib/openship/k3s/owner.json"),
  );
  if (owner.id !== runtime.id)
    throw new AppError("The server's cluster ownership has changed.", 409, "CLUSTER_HOST_CHANGED");
  // The admin certificate remains in memory and is never exposed in a DTO,
  // deployment snapshot, environment variable or log. SSH is the transport to
  // a private API endpoint, not the workload execution/control mechanism.
  const config = parse(await privileged.value.executor.readFile("/etc/rancher/k3s/k3s.yaml"));
  const ca = config?.clusters?.[0]?.cluster?.["certificate-authority-data"];
  const cert = config?.users?.[0]?.user?.["client-certificate-data"];
  const key = config?.users?.[0]?.user?.["client-key-data"];
  if (![ca, cert, key].every((value) => typeof value === "string" && value.length > 0))
    throw new Error("The cluster's API certificate is unavailable.");
  sshManager.retain(gateway.serverId);
  const api = createKubernetesApi({
    host: gateway.privateIp,
    ca: Buffer.from(ca, "base64").toString(),
    cert: Buffer.from(cert, "base64").toString(),
    key: Buffer.from(key, "base64").toString(),
    connect: async () => {
      const executor = await sshManager.acquire(gateway.serverId);
      if (executor.forwardPort) return executor.forwardPort(gateway.privateIp, 6443);
      if (!target.isLocal)
        throw new Error("Enable SSH TCP forwarding to reach the private cluster API.");
      return net.connect({ host: gateway.privateIp, port: 6443 });
    },
  });
  const dispose = api.dispose;
  let disposed = false;
  api.dispose = async () => {
    if (disposed) return;
    disposed = true;
    await dispose();
    sshManager.release(gateway.serverId);
  };
  try {
    const identity = await api.request("GET", "/api/v1/namespaces/kube-system");
    if (identity.metadata.uid !== runtime.plan.clusterUid)
      throw new AppError(
        "The Kubernetes cluster identity has changed.",
        409,
        "CLUSTER_IDENTITY_CHANGED",
      );
    const node = await api.request("GET", `/api/v1/nodes/${gateway.nodeName}`);
    if (node.metadata.labels?.["openship.io/runtime"] !== runtime.id)
      throw new AppError(
        "The Edge server no longer belongs to this cluster runtime.",
        409,
        "CLUSTER_IDENTITY_CHANGED",
      );
    const podRange =
      typeof node.spec?.podCIDR === "string" ? infrastructureCidr(node.spec.podCIDR) : null;
    if (!podRange || podRange.prefix > 30)
      throw new AppError("The Edge server's pod network is not ready.", 409, "CLUSTER_NOT_READY");
    // Host-originated Service traffic can be masqueraded through flannel.1 or
    // cni0. Permit their reserved addresses, without opening other projects' pods.
    const ipv4 = (address: number) =>
      [24, 16, 8, 0].map((shift) => (address >>> shift) & 255).join(".");
    const edgeSourceIps = [gateway.privateIp, ipv4(podRange.start), ipv4(podRange.start + 1)];
    return { api, runtime, gateway, target, edgeSourceIps };
  } catch (error) {
    await api.dispose();
    throw error;
  }
}

export async function resolveClusterDeploymentRuntime(
  snapshot: DeploymentMeta,
  organizationId?: string,
) {
  if (!organizationId || !snapshot.clusterId || !snapshot.clusterRuntimeId || !snapshot.clusterProjectId || !snapshot.clusterConfig)
    throw new AppError("This deployment is missing its saved cluster target.", 409, "CLUSTER_TARGET_REQUIRED");
  validateClusterWorkload(snapshot.clusterConfig);
  const project = await repos.project.findByIdInOrganization(snapshot.clusterProjectId, organizationId);
  if (!project) throw new AppError("Cluster project not found.", 404, "PROJECT_NOT_FOUND");
  const { api, runtime, gateway, target, edgeSourceIps } = await openClusterApi(organizationId, snapshot.clusterId, snapshot.clusterRuntimeId);
  try {
    const workload = new KubernetesRuntime({
      api,
      projectId: snapshot.clusterProjectId,
      runtimeId: runtime.id,
      edgePrivateIp: gateway.privateIp,
      edgeSourceIps,
      servers: runtime.plan.hosts,
      config: snapshot.clusterConfig,
      resolveRegistryAuth: registryAuthResolver(organizationId),
      builder: async () => {
        const builderPlatform = await resolveTargetPlatform(
          "server",
          "docker",
          gateway.serverId,
          organizationId,
        );
        // Build on one host; publish once. Only Kubernetes starts workload pods.
        return builderPlatform.runtime as Awaited<ReturnType<typeof createServerDockerRuntime>>;
      },
    });
    const hostPortTarget = await resolveHostPortTargetIdentity({
      localHost: target.isLocal,
      serverId: target.id,
      executor: target.executor,
      connection: target.hostPortConnection,
    });
    return { runtime: workload, serverId: gateway.serverId, hostPortTarget };
  } catch (error) {
    await api.dispose();
    throw error;
  }
}

export async function resolveClusterDeploymentPlatform(
  snapshot: DeploymentMeta,
  organizationId?: string,
): Promise<ResolvedDeploymentPlatform> {
  const resolved = await resolveClusterDeploymentRuntime(snapshot, organizationId);
  try {
    const gatewayPlatform = await resolveTargetPlatform(
      "server",
      "bare",
      resolved.serverId,
      organizationId,
    );
    await gatewayPlatform.runtime.dispose?.();
    return {
      platform: { ...gatewayPlatform, runtime: resolved.runtime },
      effectiveTarget: "cluster",
      runtimeMode: "docker",
      usesManagedRouting: true,
      serverId: resolved.serverId,
      hostPortTarget: resolved.hostPortTarget,
    };
  } catch (error) {
    await resolved.runtime.dispose();
    throw error;
  }
}
