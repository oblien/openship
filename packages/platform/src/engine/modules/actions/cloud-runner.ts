import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  ActionsWorker,
  CLOUD_DOCKER_IMAGE,
  CloudWorkspaceExecutor,
  Oblien,
  cloudWorkspaceStatus,
  probeActionCapabilities,
  ensureDockerEmulation,
} from "@repo/adapters";
import {
  AppError,
  actionContainerPlatform,
  actionDockerPlatforms,
  actionRunnerMismatch,
  safeErrorMessage,
} from "@repo/core";
import { repos, type ActionRun, type ActionJob, type ActionRunner } from "@repo/db";
import { env } from "../../config/env";
import { getOblienClient, getOblienBillingApi } from "../../lib/oblien-client";
import type { OblienBillingApi } from "../../lib/oblien-billing-api";
import { findBillingOwnerByNamespace } from "../billing/billing-namespace-owner";

/** Operator-owned mapping. A public request cannot select a reseller namespace
 * or grant credits. Billing remains enforced by Oblien's existing namespace quota. */
const poolsSchema = z
  .array(
    z
      .object({
        organizationId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
        namespace: z.string().regex(/^[a-z0-9][a-z0-9-]{2,127}$/),
        name: z.string().min(1).max(100),
        cpu: z.number().min(0.25).max(32),
        memoryMb: z.number().int().min(1024).max(131072),
        diskGb: z.number().int().min(10).max(256),
        maxParallel: z.number().int().min(1).max(16),
        image: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/@:-]+$/),
        labels: z.array(z.string().regex(/^[a-zA-Z0-9_.-]+$/)).max(20),
      })
      .strict(),
  )
  .max(1000);

/** Operator and purchased profiles use the same immutable worker configuration. */
export async function saveCloudActionRunner(
  pool: z.infer<typeof poolsSchema>[number],
  profileId: string | null = null,
): Promise<void> {
  if (pool.labels.some((label) => /^(macos|windows)(-|$)/i.test(label)))
    throw new Error(
      "Temporary Cloud Actions pools support Linux images; native macOS jobs need a connected Mac",
    );
  const id = `apool_${createHash("sha256")
    .update(profileId ? `${pool.namespace}:${profileId}` : pool.namespace)
    .digest("hex")
    .slice(0, 24)}`;
  const config = {
    mode: "container" as const,
    labels: pool.labels,
    image: pool.image,
    cpu: pool.cpu,
    memoryMb: pool.memoryMb,
    maxParallel: pool.maxParallel,
    // One private VM per job: Docker build actions may use its disposable daemon.
    allowDockerSocket: true,
    cloudDiskGb: pool.diskGb,
  };
  const existing = await repos.actions.runner(pool.organizationId, id);
  if (
    existing &&
    !isDeepStrictEqual(existing.config, config) &&
    (await repos.actions.runnerBusy(pool.organizationId, id))
  ) {
    await repos.actions.disableRunner(pool.organizationId, id);
    throw new AppError(
      "Waiting for active Actions workers before applying the changed pool configuration",
      409,
      "ACTIONS_POOL_DRAINING",
    );
  }
  await repos.actions.saveRunner({
    id,
    organizationId: pool.organizationId,
    serverId: null,
    cloudPoolId: pool.namespace,
    cloudProfileId: profileId,
    name: pool.name,
    config,
    capabilities: {
      os: "linux",
      architecture: "x64",
      docker: true,
      dockerArchitecture: "x64",
      // ARM64 is installed and verified on the disposable VM before any ARM job starts.
      dockerPlatforms: ["linux/amd64", "linux/arm64"],
      git: true,
      node: true,
      distribution: null,
      version: null,
    },
    enabled: true,
  });
}

export async function ensureConfiguredActionPools(): Promise<void> {
  if (!env.CLOUD_MODE) return;
  const configured = poolsSchema.parse(
    JSON.parse(process.env.OPENSHIP_ACTIONS_CLOUD_POOLS || "[]"),
  );
  if (new Set(configured.map((pool) => pool.namespace)).size !== configured.length)
    throw new Error(
      "Each Actions Cloud namespace must belong to exactly one pool and organization",
    );
  const saved = await repos.actions.cloudRunners();
  for (const runner of saved) {
    if (runner.cloudProfileId) continue;
    const pool = configured.find((pool) => pool.namespace === runner.cloudPoolId);
    if (pool && pool.organizationId !== runner.organizationId)
      throw new Error("An existing Actions pool cannot be reassigned to another organization");
    if (!pool) await repos.actions.disableRunner(runner.organizationId, runner.id);
  }
  let draining = false;
  for (const pool of configured) {
    // Customer budgets and managed-server namespaces cannot be overridden by
    // operator configuration, even when the organization happens to match.
    if (await findBillingOwnerByNamespace(pool.namespace))
      throw new AppError(
        "This namespace is already owned by customer billing",
        409,
        "ACTIONS_FUNDING_INVALID",
      );
    // A paid app-server namespace must never be adopted as a CI funding pool.
    const entitlement = await getOblienBillingApi().getEntitlement(pool.namespace);
    if (entitlement.billingMode === "monthly" || entitlement.capacity)
      throw new AppError(
        "Actions requires a separate metered namespace; monthly app servers cannot fund temporary workers",
        409,
        "ACTIONS_FUNDING_INVALID",
      );
    try {
      await saveCloudActionRunner(pool);
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "ACTIONS_POOL_DRAINING") throw error;
      draining = true;
    }
  }
  if (draining)
    throw new AppError(
      "Waiting for active Actions workers before applying the changed pool configuration",
      409,
      "ACTIONS_POOL_DRAINING",
    );
}

async function clientFor(run: ActionRun, runner: ActionRunner) {
  if (!env.CLOUD_MODE || runner.organizationId !== run.organizationId || !runner.cloudPoolId)
    throw new AppError(
      "This Cloud Actions pool is not owned by the current organization",
      403,
      "ACTIONS_POOL_FORBIDDEN",
    );
  // Namespace-scoped clients only, even inside the SaaS. Never pass the master
  // client to an executor or expose a runtime token to workflow code.
  const result = await getOblienClient().tokens.create({
    scope: "namespace",
    namespace: runner.cloudPoolId,
    ttl: 1800,
  });
  return new Oblien({ token: result.token, baseUrl: env.OBLIEN_API_URL });
}

function workspaceInput(job: ActionJob, runner: ActionRunner) {
  return {
    name: `Openship Actions ${job.id}`,
    // Job IDs are case-sensitive and can end in URL-safe punctuation. A hash
    // preserves their identity while satisfying the provider's hostname rules.
    slug: `actions-${createHash("sha256").update(job.id).digest("hex").slice(0, 32)}`,
    namespace: runner.cloudPoolId!,
    image: CLOUD_DOCKER_IMAGE,
    mode: "temporary" as const,
    wait_ready: false,
    idempotency_key: `openship-actions-${job.id}`,
    cpus: runner.config.cpu,
    memory_mb: runner.config.memoryMb,
    disk_size_mb: (runner.config.cloudDiskGb ?? 32) * 1024,
    config: {
      ttl: (job.spec?.timeoutSeconds ?? 3600) + 1200,
      ttl_action: "remove" as const,
      restart_policy: "no",
      ssh_access: false,
      network_config: { allow_internet: true, public_ingress: false },
    },
  };
}

function assertWorkspace(
  workspace: { id: string; namespace?: string | null; slug?: string | null },
  job: ActionJob,
  runner: ActionRunner,
) {
  if (
    workspace.namespace !== runner.cloudPoolId ||
    workspace.slug !== workspaceInput(job, runner).slug ||
    (job.providerWorkspaceId && workspace.id !== job.providerWorkspaceId)
  )
    throw new AppError(
      "Cloud returned a different Actions worker",
      502,
      "ACTIONS_WORKER_IDENTITY_MISMATCH",
    );
}

function assertFunded(balance: Awaited<ReturnType<OblienBillingApi["getBalance"]>>) {
  if (balance.billingMode === "monthly")
    throw new AppError(
      "Actions requires a separate prepaid budget",
      409,
      "ACTIONS_FUNDING_INVALID",
    );
  if (balance.balance === null)
    throw new AppError(
      "The Actions balance could not be verified. Try again shortly.",
      503,
      "ACTIONS_BALANCE_UNAVAILABLE",
    );
  if (balance.balance <= 0)
    throw new AppError(
      "Add funds in Actions → Budget, then rerun this workflow.",
      402,
      "ACTIONS_CREDITS_REQUIRED",
    );
  if (balance.blocking)
    throw new AppError(
      "Cloud Actions is paused for this budget. Your funds are saved; contact support if it remains paused.",
      503,
      "ACTIONS_POOL_BLOCKED",
    );
}

export async function openCloudActionWorker(
  run: ActionRun,
  job: ActionJob,
  runner: ActionRunner,
  owner: string,
  assets: string,
) {
  const client = await clientFor(run, runner);
  const firstRequest = !job.providerRequestedAt;
  if (!job.providerRequestedAt) {
    const balance = await getOblienBillingApi().getBalance(runner.cloudPoolId!);
    assertFunded(balance);
    const saved = await repos.actions.updateJob(run.organizationId, job.id, owner, {
      providerRequestedAt: new Date(),
    });
    if (!saved) throw new Error("Actions lease changed before provisioning");
    job = saved;
  }
  let workspace;
  try {
    workspace = job.providerWorkspaceId
      ? await client.workspaces.get(job.providerWorkspaceId)
      : await client.workspaces.create(workspaceInput(job, runner));
  } catch (error) {
    if (job.providerWorkspaceId && isMissing(error))
      throw new AppError(
        "The temporary Actions worker was removed before completion. This attempt will not be replayed automatically.",
        410,
        "ACTIONS_WORKER_LOST",
      );
    if (
      firstRequest &&
      !job.providerWorkspaceId &&
      [400, 402, 403, 404, 422].includes(httpStatus(error))
    ) {
      // The SDK sends this create once (no automatic POST retry). A definitive
      // rejection of that first request creates nothing. After an uncertain
      // response, keep the intent and reconcile its original key instead.
      await repos.actions.updateJob(run.organizationId, job.id, owner, {
        providerRequestedAt: null,
      });
      throw new AppError(safeErrorMessage(error), 409, "ACTIONS_PROVISIONING_REJECTED");
    }
    throw error;
  }
  assertWorkspace(workspace, job, runner);
  if (!job.providerWorkspaceId) {
    const saved = await repos.actions.updateJob(run.organizationId, job.id, owner, {
      providerWorkspaceId: workspace.id,
    });
    if (!saved) return null; // The next lease holder resolves the same idempotency key.
  }
  if (workspace.provisioning?.state === "failed")
    throw new AppError(
      workspace.provisioning.error?.message ?? "The temporary Actions worker could not start",
      502,
      "ACTIONS_PROVISIONING_FAILED",
    );
  const status = cloudWorkspaceStatus(workspace);
  if (["stopped", "suspended", "paused"].includes(status)) {
    const balance = await getOblienBillingApi().getBalance(runner.cloudPoolId!);
    assertFunded(balance);
    if (job.workerStartedAt)
      throw new AppError(
        "The Cloud worker stopped before the workflow finished. This attempt will not be restarted automatically.",
        410,
        "ACTIONS_WORKER_STOPPED",
      );
  }
  if (workspace.ready === false || !["active", "running"].includes(status)) return null;
  const executor = new CloudWorkspaceExecutor(
    () => client.workspace(workspace.id).runtime(),
    workspace.id,
  );
  try {
    const worker = new ActionsWorker(executor, assets);
    if (job.workerBinary && job.directory && job.workerStartedAt)
      return {
        worker,
        binary: job.workerBinary,
        directory: job.directory,
        release: () => executor.dispose(),
      };
    // The authenticated Runtime API gateway needs host ingress. Enabling the
    // API adds its port but does not enable that firewall path. Restrict this
    // disposable VM to the API port; do not expose SSH or workflow services.
    await client.workspaces.network.update(workspace.id, {
      public_access: true,
      ingress_ports: [9990],
    });
    let capabilities = await probeActionCapabilities(executor);
    if (capabilities.os !== "linux" || capabilities.architecture !== "x64" || !capabilities.docker)
      throw new AppError(
        "The Cloud worker image does not provide the configured Linux Docker capabilities",
        502,
        "ACTIONS_RUNNER_UNSUPPORTED",
      );
    const containerPlatform = actionContainerPlatform(capabilities, runner.config, job.spec!);
    if (containerPlatform && !actionDockerPlatforms(capabilities).includes(containerPlatform)) {
      capabilities = {
        ...capabilities,
        dockerPlatforms: await ensureDockerEmulation(
          executor,
          capabilities.dockerArchitecture ?? capabilities.architecture,
        ),
      };
    }
    const mismatch = actionRunnerMismatch(capabilities, runner.config, job.spec!);
    if (mismatch) throw new AppError(mismatch, 409, "ACTIONS_RUNNER_UNSUPPORTED");
    const prepared = await worker.prepare(capabilities);
    return {
      worker,
      binary: prepared.binary,
      containerPlatform,
      directory: `${prepared.root}/jobs/${job.id}`,
      release: () => executor.dispose(),
    };
  } catch (error) {
    await executor.dispose();
    throw error;
  }
}

export async function removeCloudActionWorker(
  run: ActionRun,
  job: ActionJob,
  runner: ActionRunner,
  owner: string,
): Promise<boolean> {
  if (!job.providerRequestedAt && !job.providerWorkspaceId) return true;
  const client = await clientFor(run, runner);
  try {
    // An uncertain create is resolved with its ORIGINAL key and config. No new
    // key, image, resources or paid purchase is introduced by cleanup retries.
    const workspace = job.providerWorkspaceId
      ? await client.workspaces.get(job.providerWorkspaceId)
      : await client.workspaces.create(workspaceInput(job, runner));
    assertWorkspace(workspace, job, runner);
    if (!job.providerWorkspaceId) {
      const saved = await repos.actions.updateJob(run.organizationId, job.id, owner, {
        providerWorkspaceId: workspace.id,
      });
      if (!saved) throw new Error("Actions lease changed before worker cleanup");
      job = saved;
    }
    await client.workspaces.delete(workspace.id);
    try {
      await client.workspaces.get(workspace.id);
      // Deletion is asynchronous. Keep the scheduler slot and poll on the
      // next tick without replacing the workflow result with a cleanup error.
      return false;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  } catch (error) {
    if (!isMissing(error) || !job.providerWorkspaceId) throw error;
  }
  return true;
}

function isMissing(error: unknown): boolean {
  return httpStatus(error) === 404;
}

function httpStatus(error: unknown): number {
  if (!error || typeof error !== "object") return 0;
  return Number("status" in error ? error.status : "statusCode" in error ? error.statusCode : 0);
}
