import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import {
  CloudDockerRuntime,
  CloudServerConnection,
  DockerRuntime,
  CloudWorkspaceExecutor,
  cloudDockerProjectPaths,
  cloudWorkspaceStatus,
  dockerProjectStorage,
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
import { decideCloudBuildResources } from "./cloud-build-resources";
import { sampleServerUsage, unavailableServerUsage } from "./server-usage";
import { registryAuthResolver } from "../modules/credentials/registry-auth";
export { unavailableServerUsage as unavailableWorkspaceUsage } from "./server-usage";

/** Inspect the persisted host only. A read must never create/resume a VM. */
export async function readCloudWorkspaceHost(organizationId: string, id: string) {
  const owner = await requireCloudWorkspace(organizationId, id);
  if (!env.CLOUD_MODE) {
    const connection = await remoteServerConnection(organizationId, id);
    const { client } = await getNamespaceClient(organizationId, id, connection);
    const workspace = await client.workspaces.get(connection.workspaceId);
    if (workspace.namespace !== connection.namespace) throw new AppError("Cloud space ownership changed", 409, "CLOUD_NAMESPACE_MISMATCH");
    if (workspace.id !== connection.workspaceId)
      throw new AppError("Cloud returned a different Cloud space", 502, "CLOUD_SERVER_IDENTITY_MISMATCH");
    const binding = await repos.cloudDockerWorkspace.find({ ownerWorkspaceId: id }, organizationId);
    return { owner, binding, provider: { workspace, allocation: connection.resources }, credentials: { client, namespace: connection.namespace } };
  }
  if (owner.remote) throw new AppError("The Cloud space connection could not be verified", 409, "CLOUD_SERVER_LINK_INVALID");
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
      "Your Cloud space is not set up yet. Complete setup to continue.",
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
      "Your Cloud space is stopped. Resume it to view resource usage.",
      409,
      "CLOUD_WORKSPACE_NOT_RUNNING",
    );
  return connection;
}

/** Commands use the same owned provider connection as Docker, without starting
 * a host or installing the Docker API bridge just to read metrics/open a shell. */
export async function openCloudWorkspaceExecutor(organizationId: string, id: string) {
  const { client, binding } = await runningConnection(organizationId, id);
  return new CloudWorkspaceExecutor(options => client.workspace(binding.workspaceId!).runtime(options), binding.workspaceId!);
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
      buildCacheProtection: async () => {
        const { buildCacheProtection } = await import("./build-cache-protection");
        return buildCacheProtection(organizationId, id);
      },
    }, null, createProvisionLock(`cloud:server:${binding.workspaceId}`));
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

/** Read verified host allocation; sample live usage only for configured caps. */
export async function sampleCloudWorkspaceResources(organizationId: string, id: string, sampleUsage = true) {
  const { client, binding, provider } = await runningConnection(organizationId, id);
  if (!sampleUsage) return { capacity: provider.allocation, usage: unavailableServerUsage("Not sampled for an uncapped build") };
  const executor = new CloudWorkspaceExecutor(options => client.workspace(binding.workspaceId!).runtime(options), binding.workspaceId!);
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
      (async () => {
        const info = await withTimeout(
          runtime.docker.info(),
          5_000,
          "Storage driver inspection timed out",
        );
        // fuse-overlayfs sizes writable layers by walking both full directory
        // trees in daemon memory. A caller timeout does not stop that work.
        // Keep host totals available; detailed attribution stays unknown.
        if (info.Driver === "fuse-overlayfs") return null;
        return withTimeout(runtime.docker.df(), 15_000, "Storage inventory timed out");
      })().catch((diagnosticFailure) => {
        observeCaughtError(diagnosticFailure, "platform/engine/lib/cloud-workspace-host");
        return null;
      }),
      repos.project.listByWorkspace(id, organizationId),
    ]);
    const projects = [...new Map([
      ...owner.linkedProjects.flatMap(link => link.projects),
      ...localProjects,
    ].map(project => [project.id, project])).values()];
    const disk = storage ? dockerProjectStorage(storage, projects) : [];
    const paths = storage ? projects.map((project) => cloudDockerProjectPaths(project.id).mounts) : [];
    const bindSizes = paths.length
      ? await runtime.executor
          .exec(
            `for p in ${paths.map(sq).join(" ")}; do if [ -d "$p" ]; then du -sk -- "$p"; else printf '0\\n'; fi; done`,
            { timeout: 15_000 },
          )
          .then((raw) => raw.trim().split("\n"))
          .catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "platform/engine/lib/cloud-workspace-host"); return []; })
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

/** Admission ledger only. This result must not replace the user's build caps.
 * Uncapped dimensions stay shared; only explicit caps reserve capacity. */
export function workspaceBuildResources(
  capacity: ResourceConfig,
  usage: CloudWorkspaceUsage,
  requested?: Partial<ResourceConfig>,
): ResourceConfig {
  const decision = decideCloudBuildResources({ capacity, usage, requested, reservations: [] });
  if (decision.kind === "admit") return { ...decision.resources, diskMb: capacity.diskMb };
  if (decision.kind === "impossible" && decision.reason === "invalid-request")
    throw new AppError(
      "Choose automatic build resources or specify at least 0.25 vCPU and 128 MB of memory.",
      400,
      "CLOUD_BUILD_RESOURCES_INVALID",
    );
  if (
    decision.kind === "wait" &&
    ["usage-unavailable", "capacity-unavailable"].includes(decision.reason)
  )
    throw new AppError(
      "Couldn't measure the server's available build capacity. Retry after the server is reachable.",
      503,
      "CLOUD_WORKSPACE_USAGE_UNAVAILABLE",
    );
  if (decision.kind === "wait" && decision.reason === "memory-pressure")
    throw new AppError(
      "The server has too little free memory to build safely. Stop an idle app, lower the build allocation, or increase the server's capacity, then retry.",
      409,
      "CLOUD_WORKSPACE_BUILD_CAPACITY",
    );
  throw new AppError(
    "The requested build allocation cannot fit the server's available capacity. Stop an idle app, lower the build allocation, or increase the server's capacity, then retry.",
    409,
    "CLOUD_WORKSPACE_BUILD_CAPACITY",
  );
}
