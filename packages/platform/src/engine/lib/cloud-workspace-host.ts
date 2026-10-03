import {
  CloudDockerRuntime,
  CloudServerConnection,
  DockerRuntime,
  CloudWorkspaceExecutor,
  cloudDockerProjectPaths,
  cloudWorkspaceStatus,
  dockerProjectStorage,
  Oblien,
  sq,
  type ResourceConfig,
} from "@repo/adapters";
import { repos } from "@repo/db";
import { AppError, withTimeout } from "@repo/core";
import { env } from "../config/env";
import { remoteServerConnection } from "./cloud/server-connection";
import { requireLinkedCloudServer } from "./cloud/server-link";
import type { CloudWorkspaceUsage } from "@repo/contracts";
import { requireCloudWorkspace } from "./cloud-workspace-scope";
import { getNamespaceClient } from "./openship-cloud";
import { readCloudWorkspaceAllocation } from "./cloud-capacity";
import { createProvisionLock } from "./provision-lock";
import { cacheStore } from "./cache-store/index";
import { sampleServerUsage, unavailableServerUsage } from "./server-usage";
import { registryAuthResolver } from "../modules/credentials/registry-auth";
export { unavailableServerUsage as unavailableWorkspaceUsage } from "./server-usage";

/** Inspect the persisted host only. A read must never create/resume a VM. */
export async function readCloudWorkspaceHost(organizationId: string, id: string) {
  const owner = await requireCloudWorkspace(organizationId, id);
  if (!env.CLOUD_MODE) {
    const connection = await remoteServerConnection(organizationId, id);
    const client = new Oblien({ token: connection.token, baseUrl: connection.providerApiUrl });
    const workspace = await client.workspaces.get(connection.workspaceId);
    if (workspace.namespace !== connection.namespace) throw new AppError("Cloud server namespace changed", 409, "CLOUD_NAMESPACE_MISMATCH");
    if (workspace.id !== connection.workspaceId)
      throw new AppError("Cloud returned a different managed server", 502, "CLOUD_SERVER_IDENTITY_MISMATCH");
    const binding = await repos.cloudDockerWorkspace.find({ ownerWorkspaceId: id }, organizationId);
    return { owner, binding, provider: { workspace, allocation: connection.resources }, credentials: { client, namespace: connection.namespace } };
  }
  if (owner.remote) throw new AppError("Invalid Cloud server authority", 409, "CLOUD_SERVER_LINK_INVALID");
  const binding = await repos.cloudDockerWorkspace.find({ ownerWorkspaceId: id }, organizationId);
  if (!binding?.workspaceId) return { owner, binding, provider: null, credentials: null };
  if (!owner.namespace || binding.namespace !== owner.namespace)
    throw new AppError("Cloud workspace ownership changed", 409, "CLOUD_NAMESPACE_MISMATCH");
  const provider = await readCloudWorkspaceAllocation(binding.workspaceId, binding.namespace);
  return { owner, binding, provider, credentials: null };
}

export async function readCloudWorkspaceConnection(organizationId: string, id: string) {
  const { owner, binding, provider, credentials } = await readCloudWorkspaceHost(organizationId, id);
  if (!binding?.workspaceId || !provider)
    throw new AppError(
      "The managed server has not been provisioned yet",
      409,
      "CLOUD_WORKSPACE_NOT_READY",
    );
  const { client, namespace } = credentials ?? await getNamespaceClient(organizationId, id);
  if (namespace !== binding.namespace) throw new Error("Cloud workspace namespace changed");
  return { client, namespace, binding, provider };
}

async function runningConnection(organizationId: string, id: string) {
  const connection = await readCloudWorkspaceConnection(organizationId, id);
  if (!["running", "active"].includes(cloudWorkspaceStatus(connection.provider.workspace)))
    throw new AppError(
      "The server is stopped. Resume it to read live usage.",
      409,
      "CLOUD_WORKSPACE_NOT_RUNNING",
    );
  return connection;
}

/** Commands use the same owned provider connection as Docker, without starting
 * a host or installing the Docker API bridge just to read metrics/open a shell. */
export async function openCloudWorkspaceExecutor(organizationId: string, id: string) {
  const { client, binding } = await runningConnection(organizationId, id);
  return new CloudWorkspaceExecutor(() => client.workspace(binding.workspaceId!).runtime(), binding.workspaceId!);
}

/** Server-authorized Docker operations (inventory and migration). Applications
 * continue to use CloudDockerRuntime's additional project ownership guards. */
export async function openCloudWorkspaceDockerRuntime(organizationId: string, id: string) {
  const { client, namespace, binding } = await runningConnection(organizationId, id);
  const connection = new CloudServerConnection(client, {
    workspaceId: binding.workspaceId!, namespace,
    bridgeLock: createProvisionLock(`cloud:docker-bridge:${binding.workspaceId}`),
  });
  try {
    const runtime = await DockerRuntime.create({
      transport: "cloud", executor: connection.executor,
      cloudConnection: () => connection.connectDocker(),
      resolveRegistryAuth: registryAuthResolver(organizationId),
    });
    const dispose = runtime.dispose.bind(runtime);
    runtime.dispose = async () => {
      try { await dispose(); } finally { await connection.dispose(); }
    };
    return runtime;
  } catch (error) {
    await connection.dispose();
    throw error;
  }
}

async function measuredHost(organizationId: string, id: string) {
  const { client, namespace, binding, provider } = await runningConnection(organizationId, id);
  const runtime = await CloudDockerRuntime.forWorkspace(client, {
    workspaceId: binding.workspaceId!,
    ownerWorkspaceId: id,
    projectId: `workspace:${id}`,
    namespace,
    provisionLock: createProvisionLock(`cloud:server:${binding.workspaceId}`),
    bridgeLock: createProvisionLock(`cloud:docker-bridge:${binding.workspaceId}`),
    resolveRegistryAuth: async () => undefined,
  });
  return { runtime, capacity: provider.allocation };
}

/** Build admission needs only a cheap host sample, never a filesystem scan. */
export async function sampleCloudWorkspaceResources(organizationId: string, id: string) {
  const { client, binding, provider } = await runningConnection(organizationId, id);
  const executor = new CloudWorkspaceExecutor(() => client.workspace(binding.workspaceId!).runtime(), binding.workspaceId!);
  try {
    return { capacity: provider.allocation, usage: await sampleServerUsage(executor) };
  } finally {
    await executor.dispose();
  }
}

/** Internal whole-host reader. Public callers enforce workspace permissions. */
export async function measureCloudWorkspace(
  organizationId: string,
  id: string,
  fresh = false,
): Promise<CloudWorkspaceUsage> {
  const owner = await requireCloudWorkspace(organizationId, id);
  if (owner.remote) await requireLinkedCloudServer(organizationId, id);

  const cache = await cacheStore<CloudWorkspaceUsage>("cloud-workspace-usage", { maxSize: 500 });
  const key = `${organizationId}:${id}`;
  if (!fresh) {
    const hit = await cache.get(key);
    if (hit) return hit;
  }
  const { runtime } = await measuredHost(organizationId, id);
  try {
    const [sample, storage, localProjects] = await Promise.all([
      sampleServerUsage(runtime.executor),
      withTimeout(runtime.docker.df(), 15_000, "Storage inventory timed out").catch(() => null),
      repos.project.listByWorkspace(id, organizationId),
    ]);
    const projects = [...new Map([
      ...owner.linkedProjects.flatMap(link => link.projects),
      ...localProjects,
    ].map(project => [project.id, project])).values()];
    const disk = storage ? dockerProjectStorage(storage, projects) : [];
    const paths = projects.map((project) => cloudDockerProjectPaths(project.id).mounts);
    const bindSizes = paths.length
      ? await runtime.executor
          .exec(
            `for p in ${paths.map(sq).join(" ")}; do if [ -d "$p" ]; then du -sk -- "$p"; else printf '0\\n'; fi; done`,
            { timeout: 15_000 },
          )
          .then((raw) => raw.trim().split("\n"))
          .catch(() => [])
      : [];
    const members = [];
    for (const [index, project] of projects.entries()) {
      let bytes = disk.find((item) => item.id === project.id)?.bytes ?? null;
      // The project mount root includes Docker binds and bare releases/shared data.
      const kb = Number(bindSizes[index]?.trim().split(/\s+/)[0] ?? NaN);
      bytes = bytes !== null && Number.isFinite(kb) && kb >= 0 ? bytes + kb * 1024 : null;
      members.push({
        id: project.id,
        name: project.name,
        diskMb: bytes === null ? null : bytes / 1048576,
      });
    }
    const diskUsedMb = sample.diskUsedMb;
    const result: CloudWorkspaceUsage = {
      ...sample,
      sharedDiskMb: diskUsedMb === null || members.some((item) => item.diskMb === null)
        ? null
        : Math.max(0, diskUsedMb - members.reduce((sum, item) => sum + item.diskMb!, 0)),
      projects: members,
    };
    await cache.set(key, result, 20);
    return result;
  } finally {
    await runtime.dispose();
  }
}

/** Container caps are ceilings, not reserved VMs. A serial build uses currently
 * available memory/CPU inside the purchased host, without allocating another VM. */
export function workspaceBuildResources(
  capacity: ResourceConfig,
  usage: CloudWorkspaceUsage,
  requested?: Partial<ResourceConfig>,
): ResourceConfig {
  if (!usage.available || usage.memoryAvailableMb === null || usage.cpuPercent === null)
    throw new AppError(
      "Couldn't measure the server's available build capacity. Retry after the server is reachable.",
      503,
      "CLOUD_WORKSPACE_USAGE_UNAVAILABLE",
    );
  const headroomMb = Math.min(512, Math.max(128, capacity.memoryMb * 0.05));
  const availableMb = Math.floor(Math.min(capacity.memoryMb, usage.memoryAvailableMb) - headroomMb);
  if (availableMb < 128)
    throw new AppError(
      "The server has too little free memory to build safely. Stop an idle app or increase the server's capacity, then retry.",
      409,
      "CLOUD_WORKSPACE_BUILD_CAPACITY",
    );
  return {
    cpuCores: Math.min(
      requested?.cpuCores || capacity.cpuCores,
      Math.max(
        0.25,
        Math.floor(capacity.cpuCores * (1 - Math.min(100, usage.cpuPercent) / 100) * 4) / 4,
      ),
    ),
    memoryMb: Math.min(requested?.memoryMb || availableMb, availableMb),
    diskMb: capacity.diskMb,
  };
}
