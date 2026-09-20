import { createHash } from "node:crypto";
import { CLOUD_DOCKER_IMAGE, CloudWorkspaceExecutor, Oblien, cloudWorkspaceStatus, sq, waitForCloudDockerWorkspace, type ResourceConfig } from "@repo/adapters";
import { repos, type Project } from "@repo/db";
import { AppError, deploymentBelongsToProject } from "@repo/core";
import { env } from "../config/env";
import { issueNamespaceToken } from "./openship-cloud";
import { getOrgCloudToken } from "./cloud/client";
import { createProvisionLock } from "./provision-lock";
import { assertCloudCanSpend } from "../modules/billing/billing-oblien-quota";
import { resolveCloudServiceResources, resolveBuildResources } from "./resources";
import type { DeploymentMeta } from "./deployment-runtime";

function workspaceSlug(projectId: string): string {
  return `os-docker-${createHash("sha256").update(projectId).digest("hex").slice(0, 24)}`;
}

/** Reconcile an interrupted create before teardown. This only reads provider
 * state; it never provisions or starts a workspace in order to delete it. */
export async function cloudDockerWorkspaceForCleanup(projectId: string, organizationId: string) {
  return createProvisionLock(`cloud:docker-project:${projectId}`).run(async () => {
    const binding = await repos.cloudDockerWorkspace.find(projectId, organizationId);
    if (!binding || binding.workspaceId) return binding;
    const credentials = env.CLOUD_MODE ? await issueNamespaceToken(organizationId) : await getOrgCloudToken(organizationId);
    if (!credentials || credentials.namespace !== binding.namespace) throw new Error("Cannot verify the project's cloud namespace for cleanup");
    const client = new Oblien({ token: credentials.token, baseUrl: env.OBLIEN_API_URL });
    for (let page = 1; ; page++) {
      const result = await client.workspaces.list({ page, limit: 100 });
      const workspace = result.workspaces.find(item => item.slug === workspaceSlug(projectId) && item.namespace === binding.namespace);
      if (workspace) {
        await repos.cloudDockerWorkspace.attach(projectId, organizationId, binding.namespace, workspace.id, true);
        return { ...binding, workspaceId: workspace.id };
      }
      if (!result.workspaces.length || page * result.limit >= result.total) break;
    }
    throw new Error("Cloud Docker provisioning is not yet confirmed. Retry deletion once provisioning has settled.");
  });
}

/** Existing native cloud projects need an explicit data migration. Added services
 * on a single-app project retain their own native workspaces. */
export async function usesCloudDockerWorkspace(project: Project, mode?: "single" | "services"): Promise<boolean> {
  const binding = await repos.cloudDockerWorkspace.find(project.id, project.organizationId);
  if (binding) return true;
  if (mode === "single" || project.cloudWorkspaceId) return false;
  if (project.activeDeploymentId) {
    const active = await repos.deployment.findById(project.activeDeploymentId);
    if (active && !deploymentBelongsToProject(project, active)) throw new Error("Active deployment belongs to a different project");
    if (active && ((active.meta as DeploymentMeta | null)?.deployTarget === "cloud" ||
        (env.CLOUD_MODE && !(active.meta as DeploymentMeta | null)?.deployTarget))) return false;
  }
  return true;
}

export function cloudDockerResources(input: {
  resources?: ResourceConfig | null; buildResources?: ResourceConfig | null;
  services: Array<{ enabled?: boolean; resources?: ResourceConfig | Record<string, unknown> | null }>;
}): ResourceConfig {
  const resources = input.services.filter(s => s.enabled !== false)
    .map(s => resolveCloudServiceResources(s.resources, input.resources));
  const build = resolveBuildResources(input.buildResources, { isCloud: true });
  // Catalog defaults, plus room for Docker/BuildKit. The VM is billed once;
  // each service's limits are still applied by Docker inside that allocation.
  return {
    cpuCores: Math.max(2, Math.ceil(build.cpuCores), Math.ceil(resources.reduce((n, r) => n + r.cpuCores, 0))),
    memoryMb: Math.max(4096, Math.ceil((build.memoryMb + resources.reduce((n, r) => n + r.memoryMb, 0)) / 256) * 256),
    diskMb: Math.max(32768, build.diskMb, ...resources.map(r => r.diskMb)),
  };
}

/** Reserve identity before a provider write. Retries use exactly the same POST
 * and idempotency key, then attach its id before waiting for the VM to boot. */
export async function ensureCloudDockerWorkspace(input: {
  projectId: string; organizationId: string; resources: ResourceConfig; signal?: AbortSignal;
  onProgress?: (message: string) => void;
}): Promise<NonNullable<DeploymentMeta["cloudDockerWorkspace"]>> {
  return createProvisionLock(`cloud:docker-project:${input.projectId}`).run(async () => {
    input.signal?.throwIfAborted();
    const project = await repos.project.findByIdInOrganization(input.projectId, input.organizationId);
    if (!project || project.deletedAt || project.deletionInProgress) throw new AppError("Project not found", 404, "PROJECT_NOT_FOUND");
    if (env.CLOUD_MODE) await assertCloudCanSpend(input.organizationId);
    const credentials = env.CLOUD_MODE ? await issueNamespaceToken(input.organizationId) : await getOrgCloudToken(input.organizationId);
    if (!credentials) throw new AppError("Connect Openship Cloud before deploying", 503, "CLOUD_NOT_CONNECTED");
    const { namespace, token } = credentials;
    const client = new Oblien({ token, baseUrl: env.OBLIEN_API_URL });
    const binding = await repos.cloudDockerWorkspace.reserve({
      projectId: input.projectId, namespace, image: CLOUD_DOCKER_IMAGE, resources: input.resources,
    }, input.organizationId);
    let workspaceId = binding.workspaceId;
    if (!workspaceId) {
      if (project.cloudWorkspaceId) throw new Error("An existing native workspace must be migrated before enabling Docker");
      input.signal?.throwIfAborted();
      const workspace = await client.workspaces.create({
        name: `Openship Compose ${input.projectId}`,
        slug: workspaceSlug(input.projectId),
        namespace, image: binding.image, mode: "temporary",
        wait_ready: false, idempotency_key: binding.provisionKey,
        config: {
          cpus: binding.resources.cpuCores, memory_mb: binding.resources.memoryMb,
          disk_size_mb: binding.resources.diskMb, wait_for_init: true,
          ttl: "1h", ttl_action: "remove", remove_on_exit: false,
          network_config: { allow_internet: true, public_ingress: false },
        },
      }).catch(async error => {
        // These responses definitively reject creation. A timeout, a conflict,
        // or a provider outage can still have created a VM and must keep its key.
        if ([400, 401, 402, 403, 404, 422].includes(Number((error as { status?: number }).status))) {
          await repos.cloudDockerWorkspace.discardUncreated(input.projectId, input.organizationId, binding.provisionKey);
        }
        throw error;
      });
      if (!workspace.id || workspace.namespace !== namespace) throw new Error("Oblien returned an unexpected workspace namespace");
      workspaceId = workspace.id;
      // Complete this write even when cancellation arrived during POST. Teardown
      // and retries must know which resource exists outside our process.
      await repos.cloudDockerWorkspace.attach(input.projectId, input.organizationId, namespace, workspaceId);
    }
    const ws = client.workspace(workspaceId);
    const current = await ws.get();
    if (current.namespace !== namespace) throw new Error("Cloud workspace namespace changed");
    input.signal?.throwIfAborted();
    const status = cloudWorkspaceStatus(current);
    if (status === "stopped") await ws.start();
    else if (status === "paused" || status === "suspended") await ws.resume();
    const ready = await waitForCloudDockerWorkspace(client, workspaceId, namespace, { signal: input.signal });
    // Permanence precedes the first container/volume write; a failed later build
    // must never expire a disk already holding customer data.
    await ws.lifecycle.makePermanent();
    const allocated = ready.resources;
    if (allocated && (input.resources.cpuCores > (allocated.cpus ?? binding.resources.cpuCores) ||
        input.resources.memoryMb > (allocated.memory_mb ?? binding.resources.memoryMb) ||
        input.resources.diskMb > (allocated.disk_size_mb ?? binding.resources.diskMb))) {
      // Oblien applies resource changes by restarting the VM. Capture exactly
      // the running service containers so custom Docker restart policies do not
      // strand a sibling, and intentionally stopped services stay stopped.
      input.onProgress?.("Increasing the shared Cloud workspace allocation; running services will briefly restart.\n");
      const executor = new CloudWorkspaceExecutor(() => ws.runtime());
      try {
        const inspect = () => executor.exec(`docker ps --filter ${sq(`label=openship.project=${input.projectId}`)} --filter status=running --format '{{.ID}}'`, { timeout: 30_000 });
        const previous = await (input.signal ? executor.runWithAbortSignal(input.signal, inspect) : inspect());
        const running = previous.trim().split(/\s+/).filter(Boolean);
        if (running.some(id => !/^[a-f0-9]{12,64}$/.test(id))) throw new Error("Invalid container identity during Cloud workspace resizing");
        input.signal?.throwIfAborted();
        let resizeFailure: { error: unknown } | undefined;
        try {
          await ws.resources.update({
            cpus: Math.max(input.resources.cpuCores, allocated.cpus ?? binding.resources.cpuCores),
            memory_mb: Math.max(input.resources.memoryMb, allocated.memory_mb ?? binding.resources.memoryMb),
            disk_size_mb: Math.max(input.resources.diskMb, allocated.disk_size_mb ?? binding.resources.diskMb),
            apply: true,
          });
        } catch (error) {
          // The provider may have restarted the VM before its response was
          // lost. Restore the captured running set even on an uncertain result.
          resizeFailure = { error };
        }
        // Once the resize has begun, restore running services even if this
        // deployment is cancelled. Cancelling a build must not strand siblings.
        try {
          await waitForCloudDockerWorkspace(client, workspaceId, namespace);
          ws.invalidateRuntime();
          if (running.length) await executor.exec(`docker start ${running.map(sq).join(" ")}`);
        } catch (error) {
          throw new AggregateError(resizeFailure ? [resizeFailure.error, error] : [error],
            "Could not restore running services after resizing the Cloud workspace. Check the workspace before retrying.", { cause: error });
        }
        if (resizeFailure) throw resizeFailure.error;
        input.signal?.throwIfAborted();
      } finally {
        await executor.dispose();
      }
    }
    await repos.cloudDockerWorkspace.markReady(input.projectId, input.organizationId, workspaceId);
    return { projectId: input.projectId, workspaceId };
  }, input.signal);
}
