import { createHash } from "node:crypto";
import {
  CLOUD_DOCKER_IMAGE,
  CloudWorkspaceExecutor,
  Oblien,
  cloudCpus,
  cloudWorkspaceCreationFailure,
  cloudWorkspaceStatus,
  managedProcessState,
  readManagedProcessStatus,
  waitForManagedProcess,
  sq,
  waitForCloudDockerWorkspace,
  waitForCloudWorkspaceStopped,
  updateCloudWorkspaceResources,
  type ResourceConfig,
} from "@repo/adapters";
import { repos, type Project, type CloudWorkspaceOperation } from "@repo/db";
import { AppError, deploymentBelongsToProject } from "@repo/core";
import { env } from "../config/env";
import { issueNamespaceToken } from "./openship-cloud";
import { ensureLinkedCloudServer } from "./cloud/server-connection";
import { createProvisionLock } from "./provision-lock";
import {
  assertCloudCanSpend,
  syncOblienEntitlement,
} from "../modules/billing/billing-oblien-quota";
import type { DeploymentMeta } from "./deployment-runtime";
import { withProjectRuntimeLock } from "./project-runtime-lock";
import { requireCloudWorkspace } from "./cloud-workspace-scope";

function workspaceSlug(ownerWorkspaceId: string): string {
  return `os-docker-${createHash("sha256").update(ownerWorkspaceId).digest("hex").slice(0, 24)}`;
}

/** Recover provider identity by the exact subscription slug within its namespace.
 * A negative lookup cannot rule out an earlier POST still in progress. */
export async function findOwnedDockerWorkspace(
  client: Oblien,
  ownerWorkspaceId: string,
  namespace: string,
) {
  let found: Awaited<ReturnType<typeof client.workspaces.get>> | undefined;
  for (let page = 1; ; page++) {
    const result = await client.workspaces.list({ page, limit: 100 });
    const matches = result.workspaces.filter(
      (item) => item.slug === workspaceSlug(ownerWorkspaceId) && item.namespace === namespace,
    );
    for (const workspace of matches) {
      if (found && found.id !== workspace.id)
        throw new Error(
          "Multiple Cloud servers match this subscription. Contact support@openship.io to verify its workspace before retrying.",
        );
      found = workspace;
    }
    if (!result.workspaces.length || page * result.limit >= result.total) return found;
  }
}

/** Project cleanup only reads its server binding. Host lifecycle belongs to the subscription. */
export async function cloudDockerWorkspaceForCleanup(projectId: string, organizationId: string) {
  return repos.cloudDockerWorkspace.find(projectId, organizationId);
}

export { cloudDockerNeedsBuild, cloudDockerResources } from "./resources";

export async function resizeDockerWorkspace(input: {
  client: Oblien;
  workspaceId: string;
  namespace: string;
  resources: ResourceConfig;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  restartCheckpoint?: {
    workloads?: NonNullable<CloudWorkspaceOperation["restartWorkloads"]>;
    save(workloads: NonNullable<CloudWorkspaceOperation["restartWorkloads"]>): Promise<void>;
  };
}) {
  const ws = input.client.workspace(input.workspaceId);
  const executor = new CloudWorkspaceExecutor(() => ws.runtime(), input.workspaceId);
  try {
    const inspect = () =>
      executor.exec("docker ps --filter status=running --no-trunc --format '{{.ID}}'", {
        timeout: 30_000,
      });
    const initial = await ws.get();
    if (initial.namespace !== input.namespace) throw new Error("Cloud workspace namespace changed");
    let running = input.restartCheckpoint?.workloads;
    if (!running) {
      const state = cloudWorkspaceStatus(initial);
      if (!["running", "stopped", "paused", "suspended"].includes(state))
        throw new Error(
          "Wait for the managed server to finish its current transition before resizing",
        );
      const wasRunning = state === "running";
      const containers = wasRunning
        ? await (input.signal ? executor.runWithAbortSignal(input.signal, inspect) : inspect())
        : "";
      const managed = (wasRunning ? await ws.workloads.list() : [])
        .filter((workload) => {
          const labels = workload.labels as Record<string, unknown> | undefined;
          return (
            labels?.["openship.project"] &&
            labels["openship.deployment"]
          );
        });
      const live = await Promise.all(managed.map(workload => readManagedProcessStatus(ws.workloads, workload)));
      const processes = live.filter(workload => managedProcessState(workload) === "running").map(workload => workload.id);
      running = {
        wasRunning,
        containers: containers.trim().split(/\s+/).filter(Boolean),
        processes,
      };
      if (input.restartCheckpoint) await input.restartCheckpoint.save(running);
    }
    if (
      running.containers.some((id) => !/^[a-f0-9]{12,64}$/.test(id)) ||
      running.processes.some((id) => !/^openship-[A-Za-z0-9_-]{1,160}$/.test(id))
    )
      throw new Error("Invalid workload identity during Cloud server resizing");
    input.signal?.throwIfAborted();
    let failure: { error: unknown } | undefined;
    try {
      const current = await ws.get();
      if (current.namespace !== input.namespace)
        throw new Error("Cloud workspace namespace changed");
      const allocated = current.resources;
      if (allocated?.disk_size_mb && input.resources.diskMb < allocated.disk_size_mb)
        throw new Error("Cloud workspace disks cannot be shrunk in place");
      if (
        allocated?.cpus !== input.resources.cpuCores ||
        allocated?.memory_mb !== input.resources.memoryMb ||
        allocated?.disk_size_mb !== input.resources.diskMb
      ) {
        await updateCloudWorkspaceResources(ws, input.resources);
      }
    } catch (error) {
      failure = { error };
    }
    // Finish restoration even after cancellation or a lost provider response.
    try {
      const changed = await ws.get();
      if (changed.namespace !== input.namespace)
        throw new Error("Cloud workspace namespace changed");
      if (!running.wasRunning) {
        // A resize of an intentionally stopped server must not start its apps.
        if (
          ["starting", "creating", "provisioning", "resuming"].includes(
            cloudWorkspaceStatus(changed),
          )
        )
          await waitForCloudDockerWorkspace(input.client, input.workspaceId, input.namespace);
        const current = await ws.get();
        if (current.namespace !== input.namespace)
          throw new Error("Cloud workspace namespace changed");
        if (cloudWorkspaceStatus(current) === "running" && !(await ws.stop()).success)
          throw new Error("Could not restore the server's stopped state");
        await waitForCloudWorkspaceStopped(input.client, input.workspaceId, input.namespace);
      } else {
        if (cloudWorkspaceStatus(changed) === "stopped") {
          if (!(await ws.start()).success)
            throw new Error("Could not restart the managed server after resizing");
        } else if (["paused", "suspended"].includes(cloudWorkspaceStatus(changed))) {
          if (!(await ws.resume()).success)
            throw new Error("Could not resume the managed server after resizing");
        }
        await waitForCloudDockerWorkspace(input.client, input.workspaceId, input.namespace);
        ws.invalidateRuntime();
        const recovery = await Promise.allSettled([
          ...(running.containers.length
            ? [
                (async () => {
                  await executor.exec(`docker start ${running.containers.map(sq).join(" ")}`);
                  const states = await executor.exec(
                    `docker inspect --format '{{json .State.Running}}' ${running!.containers.map(sq).join(" ")}`,
                  );
                  if (
                    states.trim().split(/\s+/).length !== running!.containers.length ||
                    states
                      .trim()
                      .split(/\s+/)
                      .some((state) => state !== "true")
                  )
                    throw new Error("Some application containers did not restart after resizing");
                })(),
              ]
            : []),
          ...running.processes.map(async (id) => {
            const read = async () => {
              const workload = await ws.workloads.get(id);
              const labels = workload.labels as Record<string, unknown> | undefined;
              if (
                workload.id !== id ||
                !labels?.["openship.project"] ||
                id !== `openship-${labels["openship.deployment"]}`
              )
                throw new Error("Process ownership changed during server resizing");
              return readManagedProcessStatus(ws.workloads, workload);
            };
            const workload = await read();
            if (managedProcessState(workload) === "running") return;
            const started = await ws.workloads.start(id);
            if (!started.success) throw new Error(`Could not restore application process ${id}`);
            await waitForManagedProcess(read, "running");
          }),
        ]);
        const errors = recovery.filter(
          (item): item is PromiseRejectedResult => item.status === "rejected",
        );
        if (errors.length)
          throw new AggregateError(
            errors.map((item) => item.reason),
            "Application recovery failed",
          );
      }
    } catch (error) {
      throw new AggregateError(
        failure ? [failure.error, error] : [error],
        "Could not restore running services after resizing the Cloud workspace. Check the workspace before retrying.",
        { cause: error },
      );
    }
    if (failure) throw failure.error;
    input.signal?.throwIfAborted();
  } finally {
    await executor.dispose();
  }
}

export async function cloudSubscriptionWorkspaceResources(
  organizationId: string,
  ownerWorkspaceId: string,
): Promise<ResourceConfig> {
  const { resourceLimits: policy } = await syncOblienEntitlement(organizationId, {
    workspaceId: ownerWorkspaceId,
    syncResourceLimits: false,
  });
  const cpuCores = policy.max_total_vcpus ?? policy.max_vcpus;
  const memoryMb = policy.max_total_ram_mb ?? policy.max_ram_mb;
  const diskGb = policy.max_total_disk_gb ?? policy.max_disk_gb;
  if (
    cpuCores == null ||
    memoryMb == null ||
    diskGb == null ||
    cpuCores <= 0 ||
    memoryMb <= 0 ||
    diskGb <= 0
  ) {
    throw new AppError(
      "Choose a Cloud workspace plan with a defined capacity before provisioning",
      402,
      "CLOUD_WORKSPACE_CAPACITY_REQUIRED",
    );
  }
  return { cpuCores, memoryMb, diskMb: diskGb * 1024 };
}

interface EnsureDockerInput {
  organizationId: string;
  signal?: AbortSignal;
  existingWorkspaceId?: string;
  onProgress?: (message: string) => void;
}

/** Deployment entry: freeze project membership while returning the shared provider host. */
export async function ensureCloudDockerWorkspace(
  input: EnsureDockerInput & { projectId: string },
): Promise<NonNullable<DeploymentMeta["managedServer"]>> {
  const project = await repos.project.findByIdInOrganization(input.projectId, input.organizationId);
  if (!project || project.deletedAt || project.deletionInProgress)
    throw new AppError("Project not found", 404, "PROJECT_NOT_FOUND");
  if (!project.workspaceId || !project.serverId)
    throw new AppError(
      "Select a managed server before deploying",
      409,
      "DEPLOYMENT_SERVER_REQUIRED",
    );
  const workspaceId = await ensureDockerHost({ ...input, ownerWorkspaceId: project.workspaceId });
  return {
    projectId: project.id,
    workspaceId,
    ownerWorkspaceId: project.workspaceId,
  };
}

/** Subscription/onboarding entry, also valid before the first project exists. */
export async function ensureCloudWorkspaceHost(
  input: EnsureDockerInput & { ownerWorkspaceId: string },
): Promise<string> {
  return ensureDockerHost(input);
}

/** Provision or resume one subscribed server. Application deploys never resize it. */
async function ensureDockerHost(
  input: EnsureDockerInput & { ownerWorkspaceId: string },
): Promise<string> {
  if (!env.CLOUD_MODE) return ensureLinkedCloudServer(input);
  const owner = { ownerWorkspaceId: input.ownerWorkspaceId };
  const ownerId = input.ownerWorkspaceId;
  return createProvisionLock(`cloud:server-owner:${ownerId}`).run(async () => {
    input.signal?.throwIfAborted();
    const managed = await requireCloudWorkspace(input.organizationId, input.ownerWorkspaceId);
    if (managed.deletionInProgress)
      throw new AppError("Managed server is being deleted", 409, "CLOUD_WORKSPACE_UNAVAILABLE");
    const existing = await repos.cloudDockerWorkspace.find(owner, input.organizationId);
    if (
      input.existingWorkspaceId !== undefined &&
      existing?.workspaceId !== input.existingWorkspaceId
    ) {
      throw new AppError(
        "Cloud Docker host does not belong to this execution target",
        404,
        "CLOUD_WORKSPACE_NOT_FOUND",
      );
    }
    if (managed.remote) throw new AppError("A Cloud server cannot delegate its subscription", 409, "CLOUD_SERVER_LINK_INVALID");
    await assertCloudCanSpend(input.organizationId, managed.id);
    const credentials = await issueNamespaceToken(input.organizationId, managed.id);
    const { namespace, token } = credentials;
    const client = new Oblien({ token, baseUrl: env.OBLIEN_API_URL });
    const requested =
      existing?.resources ??
      (await cloudSubscriptionWorkspaceResources(input.organizationId, managed.id));
    if (!requested) throw new Error("Docker host capacity is required");
    const binding =
      existing ??
      (await repos.cloudDockerWorkspace.reserve(
        {
          ownerWorkspaceId: managed.id,
          namespace,
          image: CLOUD_DOCKER_IMAGE,
          resources: requested,
        },
        input.organizationId,
      ));
    if (binding.namespace !== namespace)
      throw new Error("Cloud workspace namespace binding does not match its owner");
    let workspaceId = binding.workspaceId;
    if (!workspaceId) {
      if (input.signal?.aborted) {
        if (!existing)
          await repos.cloudDockerWorkspace.discardUncreated(
            owner,
            input.organizationId,
            binding.provisionKey,
          );
        input.signal.throwIfAborted();
      }
      const workspace = await client.workspaces
        .create({
          name: managed.name,
          slug: workspaceSlug(ownerId),
          namespace,
          image: binding.image,
          mode: "temporary",
          wait_ready: false,
          idempotency_key: binding.provisionKey,
          config: {
            cpus: binding.resources.cpuCores,
            memory_mb: binding.resources.memoryMb,
            disk_size_mb: binding.resources.diskMb,
            wait_for_init: true,
            ttl: "1h",
            ttl_action: "remove",
            remove_on_exit: false,
            network_config: { allow_internet: true, public_ingress: false },
          },
        })
        .catch(async (error) => {
          const failure = cloudWorkspaceCreationFailure(error);
          if (failure.workspaceId) {
            const created = await client.workspaces.get(failure.workspaceId);
            if (
              created.id !== failure.workspaceId ||
              created.namespace !== namespace ||
              created.slug !== workspaceSlug(ownerId)
            ) {
              throw new Error("Could not verify the failed Cloud workspace's ownership");
            }
            await repos.cloudDockerWorkspace.attach(
              owner,
              input.organizationId,
              namespace,
              failure.workspaceId,
            );
          } else if (failure.capacityRejected && existing) {
            const recovered = await findOwnedDockerWorkspace(client, ownerId, namespace);
            if (recovered) return recovered;
          } else if (failure.rejected && !existing) {
            await repos.cloudDockerWorkspace.discardUncreated(
              owner,
              input.organizationId,
              binding.provisionKey,
            );
          }
          throw error;
        });
      if (!workspace.id || workspace.namespace !== namespace)
        throw new Error("Oblien returned an unexpected workspace namespace");
      workspaceId = workspace.id;
      // Complete this even after cancellation: retries must know which disk exists.
      await repos.cloudDockerWorkspace.attach(owner, input.organizationId, namespace, workspaceId);
    }
    const ws = client.workspace(workspaceId);
    const current = await ws.get();
    if (current.namespace !== namespace) throw new Error("Cloud workspace namespace changed");
    input.signal?.throwIfAborted();
    const status = cloudWorkspaceStatus(current);
    const provisioning = current.provisioning as { state?: string } | undefined;
    if (binding.state === "provisioning" && provisioning?.state === "failed") {
      input.onProgress?.(
        "Retrying the managed server's initial provisioning with its existing disk.\n",
      );
      const retried = await client.workspaces.retryCreation(workspaceId);
      if (retried.id !== workspaceId || retried.namespace !== namespace)
        throw new Error("Cloud provisioning retry returned an unexpected workspace");
    } else if (status === "stopped") await ws.start();
    else if (status === "paused" || status === "suspended") await ws.resume();
    const ready = await waitForCloudDockerWorkspace(client, workspaceId, namespace, {
      signal: input.signal,
    });
    await ws.lifecycle.makePermanent();
    await repos.cloudDockerWorkspace.markReady(owner, input.organizationId, workspaceId);
    return workspaceId;
  }, input.signal);
}
