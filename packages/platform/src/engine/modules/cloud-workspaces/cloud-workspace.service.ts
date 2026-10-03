import { createHash, randomUUID } from "node:crypto";
import { AppError, safeErrorMessage } from "@repo/core";
import { repos, type CloudWorkspace, type CloudWorkspaceOperation } from "@repo/db";
import { cloudWorkspaceStatus, deleteCloudWorkspace } from "@repo/adapters";
import type {
  CreateManagedServerInput,
  ResizeManagedServerInput,
  RemoveManagedServerInput,
  CloudWorkspaceSummary,
  CloudWorkspaceResizePreview,
  ServerDetail,
} from "@repo/contracts";
import type { ExecutionContext } from "../../../context";
import { env } from "../../config/env";
import { authorization } from "../../lib/authorization";
import { requireCloudWorkspace, requireWorkspaceServer } from "../../lib/cloud-workspace-scope";
import {
  ensureCloudWorkspaceHost,
  cloudSubscriptionWorkspaceResources,
  resizeDockerWorkspace,
  findOwnedDockerWorkspace,
} from "../../lib/cloud-docker-workspace";
import { getNamespaceClient } from "../../lib/openship-cloud";
import { getOblienClient } from "../../lib/oblien-client";
import {
  assertCloudCanSpend,
  syncOblienEntitlement,
  withCloudBillingLock,
} from "../billing/billing-oblien-quota";
import {
  readCloudWorkspaceHost,
  measureCloudWorkspace,
  unavailableWorkspaceUsage,
} from "../../lib/cloud-workspace-host";
import { withCloudWorkspaceActivity, reconcileSettledCloudActivity } from "../../lib/cloud-workspace-lock";
import { createProvisionLock } from "../../lib/provision-lock";
import { trackBackgroundWork } from "../../lib/background-work";
import { withProjectRuntimeLock } from "../../lib/project-runtime-lock";
import { assertWorkspaceCheckoutsSettled } from "../billing/workspace-checkout";
import { createLinkedCloudServer, linkedServerRequest, linkedServerSummary, localizeCloudSummary, requireLinkedCloudServer, confirmLinkedServerDeletion } from "../../lib/cloud/server-link";

function requireSaas() {
  if (!env.CLOUD_MODE)
    throw new AppError(
      "Managed servers are available in Openship Cloud",
      400,
      "CLOUD_WORKSPACE_TARGET_UNAVAILABLE",
    );
}
const digest = (data: unknown) => createHash("sha256").update(JSON.stringify(data)).digest("hex");

async function linkedSummaryOperation(
  ctx: Pick<ExecutionContext, "organizationId">,
  id: string,
  suffix: string,
  method = "POST",
  input?: unknown,
) {
  const row = await requireLinkedCloudServer(ctx.organizationId, id);
  const result = await linkedServerRequest<CloudWorkspaceSummary>(ctx.organizationId, id, suffix, {
    method, ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
  return localizeCloudSummary(row, result);
}

async function linkedResizePreview(ctx: ExecutionContext, id: string) {
  const remote = await linkedServerRequest<CloudWorkspaceResizePreview>(ctx.organizationId, id, "/resize");
  const projects = await repos.project.listByWorkspace(id, ctx.organizationId);
  for (const project of projects) await authorization.authorize(ctx, {
    resourceType: "project", resourceId: project.id, action: "write",
  });
  return {
    ...remote,
    remoteRevision: remote.revision,
    revision: digest({ remote: remote.revision, projects: projects.map(project => [project.id, project.updatedAt]) }),
    restartProjects: [...new Map([...remote.restartProjects, ...projects.map(project => ({ id: project.id, name: project.name }))].map(project => [project.id, project])).values()],
  };
}

async function resizeLinked(ctx: ExecutionContext, id: string, input: ResizeManagedServerInput) {
  return createProvisionLock(`cloud:workspace-activity:${id}`).run(async () => {
    let owner = await requireLinkedCloudServer(ctx.organizationId, id);
    if (owner.operation?.id === input.idempotencyKey) {
      if (owner.operation.kind !== "resize" || owner.operation.revision !== input.revision || !owner.operation.remoteRevision)
        throw new AppError("This request key belongs to a different server operation", 409, "IDEMPOTENCY_KEY_CONFLICT");
    } else {
      const preview = await linkedResizePreview(ctx, id);
      if (preview.revision !== input.revision)
        throw new AppError("The server changed. Review its resize again.", 409, "CLOUD_WORKSPACE_CHANGED");
      await repos.cloudWorkspace.requestOperation(id, ctx.organizationId, {
        ...operation("resize", input.idempotencyKey), revision: input.revision,
        remoteRevision: preview.remoteRevision, resources: preview.after,
        restartProjectIds: preview.restartProjects.map(project => project.id),
      });
      owner = await requireLinkedCloudServer(ctx.organizationId, id);
    }
    try {
      return await linkedSummaryOperation(ctx, id, "/resize", "POST", {
        ...input, revision: owner.operation!.remoteRevision,
      });
    } catch (error) {
      if (error instanceof AppError && error.statusCode < 500)
        await repos.cloudWorkspace.rejectLinkedOperation(id, ctx.organizationId, input.idempotencyKey, error.message);
      throw error;
    }
  });
}

export async function summary(row: CloudWorkspace, live = false): Promise<CloudWorkspaceSummary> {
  if (row.remote) return linkedServerSummary(row);
  requireSaas();
  const [binding, projects, server] = await Promise.all([
    repos.cloudDockerWorkspace.find({ ownerWorkspaceId: row.id }, row.organizationId),
    repos.project.listByWorkspace(row.id, row.organizationId),
    requireWorkspaceServer(row.organizationId, row.id),
  ]);
  const unfinished = row.operation && row.operation.status !== "succeeded";
  let state = row.deletionInProgress
    ? "deleting"
    : unfinished
      ? row.operation!.status === "running"
        ? "running_operation"
        : row.operation!.status
      : binding?.state === "ready"
        ? "ready"
        : row.planTierId === "free"
          ? "needs_plan"
          : "not_provisioned";
  let resources = binding?.resources ?? null;
  if (live && binding?.workspaceId && !unfinished) {
    try {
      const host = await readCloudWorkspaceHost(row.organizationId, row.id);
      if (host.provider) {
        state = cloudWorkspaceStatus(host.provider.workspace);
        resources = host.provider.allocation;
      }
    } catch {
      state = "unreachable";
    }
  }
  const operation = row.operation
    ? {
        id: row.operation.id,
        kind: row.operation.kind,
        status: row.operation.status,
        requestedAt: row.operation.requestedAt,
        nextAttemptAt: row.operation.nextAttemptAt,
        error: row.operation.error,
        logs: row.operation.logs,
      }
    : null;
  return {
    id: row.id,
    serverId: server.id,
    name: row.name,
    planTierId: row.planTierId,
    subscriptionStatus: row.subscriptionStatus,
    projectCount: projects.length + row.linkedProjects.reduce((count, link) => count + link.projects.length, 0),
    state,
    resources,
    operation,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function get(ctx: ExecutionContext, id: string) {
  if (!env.CLOUD_MODE) {
    await reconcileLinkedOperation(id).catch(error =>
      console.warn(`[cloud-workspace] ${id}: ${safeErrorMessage(error)}`));
  }
  return summary(await requireCloudWorkspace(ctx.organizationId, id), true);
}
export async function create(
  ctx: ExecutionContext,
  input: CreateManagedServerInput,
) {
  if (!env.CLOUD_MODE) return createLinkedCloudServer(ctx.organizationId, input);
  requireSaas();
  const rows = await repos.cloudWorkspace.listByOrganization(ctx.organizationId);
  // Draft identities don't reserve machines. Bound abandoned checkout drafts.
  if (rows.filter((row) => !row.namespace && row.planTierId === "free").length >= 10)
    throw new AppError(
      "Finish setup or remove an unused server before adding another",
      409,
      "CLOUD_WORKSPACE_DRAFT_LIMIT",
    );
  return summary(
    await repos.cloudWorkspace.create({
      organizationId: ctx.organizationId,
      name: input.name.trim(),
    }),
  );
}
export async function rename(ctx: ExecutionContext, id: string, input: { name: string }) {
  if (!env.CLOUD_MODE) {
    await linkedServerRequest(ctx.organizationId, id, "", { method: "PATCH", body: JSON.stringify(input) });
    const row = await repos.cloudWorkspace.rename(id, ctx.organizationId, input.name.trim());
    if (!row) throw new AppError("Managed server not found", 404, "CLOUD_WORKSPACE_NOT_FOUND");
    return summary(row);
  }
  requireSaas();
  const row = await repos.cloudWorkspace.rename(id, ctx.organizationId, input.name.trim());
  if (!row) throw new AppError("Managed server not found", 404, "CLOUD_WORKSPACE_NOT_FOUND");
  return summary(row);
}
export async function getUsage(ctx: ExecutionContext, id: string) {
  let usage;
  try {
    usage = await measureCloudWorkspace(ctx.organizationId, id);
  } catch (error) {
    if (error instanceof AppError && [403, 404].includes(error.statusCode)) throw error;
    usage = unavailableWorkspaceUsage(safeErrorMessage(error));
  }
  if (!usage.projects.length)
    usage.projects = (await repos.project.listByWorkspace(id, ctx.organizationId)).map(
      (project) => ({ id: project.id, name: project.name, diskMb: null }),
    );
  const projects = [];
  for (const project of usage.projects)
    if (
      await authorization.checkPermissionOnResource(ctx, {
        resourceType: "project",
        resourceId: project.id,
        action: "read",
      })
    )
      projects.push(project);
  return { ...usage, projects };
}

function operation(
  kind: CloudWorkspaceOperation["kind"],
  id: string = randomUUID(),
): CloudWorkspaceOperation {
  return {
    id,
    kind,
    status: "queued",
    requestedAt: new Date().toISOString(),
    attempts: 0,
    nextAttemptAt: null,
    error: null,
    logs: ["Waiting for the server to finish its current operation…"],
  };
}
function dispatch(id: string) {
  void trackBackgroundWork(processWorkspaceOperation(id)).catch((error) =>
    console.warn(`[cloud-workspace] ${id}: ${safeErrorMessage(error)}`),
  );
}
export async function ensure(ctx: ExecutionContext, id: string) {
  if (!env.CLOUD_MODE) return linkedSummaryOperation(ctx, id, "/ensure");
  requireSaas();
  const row = await requireCloudWorkspace(ctx.organizationId, id);
  await assertCloudCanSpend(ctx.organizationId, id);
  const requested = await repos.cloudWorkspace.requestOperation(
    id,
    ctx.organizationId,
    operation("ensure"),
  );
  dispatch(id);
  return summary(requested);
}

/** Called only after a provider entitlement read; the worker checks it again.
 * The persisted intent survives lost webhook responses and process restarts. */
export async function requestPaidWorkspaceProvisioning(organizationId: string, id: string) {
  requireSaas();
  const row = await requireCloudWorkspace(organizationId, id);
  if (
    row.deletionInProgress ||
    (row.operation && row.operation.status !== "succeeded") ||
    row.planTierId === "free" ||
    row.subscriptionStatus !== "active"
  )
    return;
  const binding = await repos.cloudDockerWorkspace.find({ ownerWorkspaceId: id }, organizationId);
  if (binding?.state === "ready") return;
  await repos.cloudWorkspace.requestOperation(id, organizationId, operation("ensure"));
  dispatch(id);
}

export async function previewResize(
  ctx: ExecutionContext,
  id: string,
): Promise<CloudWorkspaceResizePreview> {
  if (!env.CLOUD_MODE) {
    const { remoteRevision: _remoteRevision, ...preview } = await linkedResizePreview(ctx, id);
    return preview;
  }
  requireSaas();
  const host = await readCloudWorkspaceHost(ctx.organizationId, id);
  if (!host.provider || !host.binding?.workspaceId)
    throw new AppError(
      "Start this managed server before resizing it",
      409,
      "CLOUD_WORKSPACE_NOT_READY",
    );
  const pending = host.owner.operation;
  if (
    pending &&
    pending.status !== "succeeded" &&
    (pending.status !== "failed" || pending.restartWorkloads !== undefined)
  ) {
    throw new AppError(
      "Finish or retry the current server operation first",
      409,
      "CLOUD_WORKSPACE_BUSY",
    );
  }
  const before = host.provider.allocation;
  const after = await cloudSubscriptionWorkspaceResources(ctx.organizationId, id);
  if (after.diskMb < before.diskMb)
    throw new AppError(
      "A server disk cannot be shrunk in place. Move its data to a smaller server before changing to that plan.",
      409,
      "CLOUD_WORKSPACE_DISK_SHRINK",
    );
  const projects = await repos.project.listByWorkspace(id, ctx.organizationId);
  const restartProjects = [];
  for (const project of projects) {
    await authorization.authorize(ctx, {
      resourceType: "project",
      resourceId: project.id,
      action: "write",
    });
    restartProjects.push({ id: project.id, name: project.name });
  }
  restartProjects.push(...host.owner.linkedProjects.flatMap(link => link.projects));
  return {
    revision: digest({
      id,
      before,
      after,
      projects: projects.map((project) => [project.id, project.updatedAt]),
      linkedProjects: host.owner.linkedProjects,
    }),
    before,
    after,
    restartProjects,
  };
}
export async function resize(
  ctx: ExecutionContext,
  id: string,
  input: ResizeManagedServerInput,
) {
  if (!env.CLOUD_MODE) return resizeLinked(ctx, id, input);
  requireSaas();
  const owner = await requireCloudWorkspace(ctx.organizationId, id);
  if (owner.operation?.id === input.idempotencyKey) {
    if (owner.operation.kind !== "resize" || owner.operation.revision !== input.revision) {
      throw new AppError(
        "This request key belongs to a different server operation",
        409,
        "IDEMPOTENCY_KEY_CONFLICT",
      );
    }
    return summary(owner);
  }
  const requested = await withCloudWorkspaceActivity(id, async () => {
    await assertCloudCanSpend(ctx.organizationId, id);
    const plan = await previewResize(ctx, id);
    if (plan.revision !== input.revision)
      throw new AppError(
        "The server changed. Review its resize again.",
        409,
        "CLOUD_WORKSPACE_CHANGED",
      );
    const row = await repos.cloudWorkspace.requestOperation(id, ctx.organizationId, {
      ...operation("resize", input.idempotencyKey),
      revision: input.revision,
      resources: plan.after,
      restartProjectIds: plan.restartProjects.map((project) => project.id),
    });
    return row;
  }, undefined, { lifecycle: true, scope: "lifecycle" });
  // Start detached work after releasing the caller's activity/advisory locks.
  dispatch(id);
  return summary(requested);
}
export async function remove(
  ctx: ExecutionContext,
  id: string,
  input: RemoveManagedServerInput,
) {
  if (!env.CLOUD_MODE) {
    await authorization.authorize(ctx, { resourceType: "billing", resourceId: "*", action: "admin" });
    return createProvisionLock(`cloud:workspace-activity:${id}`).run(async () => {
      await requireLinkedCloudServer(ctx.organizationId, id);
      await repos.cloudWorkspace.requestOperation(id, ctx.organizationId, operation("delete", input.idempotencyKey));
      try {
        return await linkedSummaryOperation(ctx, id, "/managed", "DELETE", input);
      } catch (error) {
        if (error instanceof AppError && error.statusCode < 500 && error.statusCode !== 404) {
          await repos.cloudWorkspace.rejectLinkedOperation(id, ctx.organizationId, input.idempotencyKey, error.message);
        }
        throw error;
      }
    });
  }
  requireSaas();
  await authorization.authorize(ctx, { resourceType: "billing", resourceId: "*", action: "admin" });
  const requested = await withCloudBillingLock(
    ctx.organizationId,
    async (sync) => {
      const row = await requireCloudWorkspace(ctx.organizationId, id);
      await assertWorkspaceCheckoutsSettled(row);
      if (row.namespace) assertSubscriptionEnded(await sync({ syncResourceLimits: false }));
      await hostForDeletion(row);
      return repos.cloudWorkspace.requestOperation(
        id,
        ctx.organizationId,
        operation("delete", input.idempotencyKey),
      );
    },
    id,
  );
  dispatch(id);
  return summary(requested);
}

async function hostForDeletion(row: CloudWorkspace) {
  const owner = { ownerWorkspaceId: row.id };
  const binding = await repos.cloudDockerWorkspace.find(owner, row.organizationId);
  if (!binding || binding.workspaceId) return binding;
  if (binding.namespace !== row.namespace) throw new Error("Cloud workspace namespace changed");
  const recovered = await findOwnedDockerWorkspace(getOblienClient(), row.id, binding.namespace);
  if (!recovered)
    throw new AppError(
      "Server setup has not been confirmed. Retry setup before deleting it so its disk can be located safely.",
      409,
      "CLOUD_WORKSPACE_PROVISIONING_UNCONFIRMED",
    );
  await repos.cloudDockerWorkspace.attach(
    owner,
    row.organizationId,
    binding.namespace,
    recovered.id,
    true,
  );
  return { ...binding, workspaceId: recovered.id };
}

function assertSubscriptionEnded(state: Awaited<ReturnType<typeof syncOblienEntitlement>>) {
  if (state.grant || (state.subscription && state.subscription.status !== "canceled")) {
    throw new AppError(
      "Cancel this server's subscription and wait for its paid period to end before deleting it. Projects and data are retained meanwhile.",
      409,
      "CLOUD_WORKSPACE_SUBSCRIPTION_ACTIVE",
    );
  }
}

async function withMemberRuntimeLocks<T>(row: CloudWorkspace, work: () => Promise<T>): Promise<T> {
  const ids = (await repos.project.listByWorkspace(row.id, row.organizationId))
    .map((project) => project.id)
    .sort();
  if (
    row.operation?.kind === "resize" &&
    ids.some((id) => !row.operation?.restartProjectIds?.includes(id))
  ) {
    throw new AppError(
      "The projects on this server changed. Review the resize again.",
      409,
      "CLOUD_WORKSPACE_CHANGED",
    );
  }
  const acquire = (index: number): Promise<T> =>
    index === ids.length ? work() : withProjectRuntimeLock(ids[index]!, () => acquire(index + 1));
  return acquire(0);
}

/** Replays only the persisted request key. Cloud owns the provider worker;
 * this installation reconciles its local barrier after network/process loss. */
async function reconcileLinkedOperation(id: string): Promise<void> {
  return createProvisionLock(`cloud:workspace-worker:${id}`).run(async () => {
    const row = await repos.cloudWorkspace.findById(id);
    const op = row?.operation;
    if (!row?.remote || !op || !["queued", "running"].includes(op.status)) return;
    await requireLinkedCloudServer(row.organizationId, id);
    if (op.kind === "delete" && await confirmLinkedServerDeletion(row)) return;
    const server = await linkedServerRequest<ServerDetail>(row.organizationId, id, "");
    if (!server.managed) throw new AppError("Managed server not found", 404, "SERVER_NOT_FOUND");
    if (server.managed.operation?.id === op.id) {
      await localizeCloudSummary(row, server.managed);
      return;
    }
    try {
      if (op.kind === "resize") {
        if (!op.remoteRevision) throw new Error("The server resize has no Cloud revision");
        await linkedSummaryOperation(row, id, "/resize", "POST", {
          revision: op.remoteRevision, confirmRestart: true, idempotencyKey: op.id,
        });
      } else if (op.kind === "delete") {
        await linkedSummaryOperation(row, id, "/managed", "DELETE", {
          confirmDelete: true, idempotencyKey: op.id,
        });
      }
    } catch (error) {
      if (error instanceof AppError && error.statusCode < 500 && error.statusCode !== 404)
        await repos.cloudWorkspace.rejectLinkedOperation(id, row.organizationId, op.id, error.message);
      throw error;
    }
  });
}

/** One durable worker for HTTP, signed billing events and scheduled recovery. */
export async function processWorkspaceOperation(id: string): Promise<void> {
  if (!env.CLOUD_MODE) return reconcileLinkedOperation(id);
  return createProvisionLock(`cloud:workspace-worker:${id}`).run(async () => {
    const pending = await repos.cloudWorkspace.findById(id);
    // Provisioning never stops/replaces a host and is independently idempotent.
    // It can prepare the host while a linked deployment holds activity admission.
    return withCloudWorkspaceActivity(pending?.operation?.kind === "ensure" ? null : id, async () => {
      const row = await repos.cloudWorkspace.findById(id);
      if (
        !row?.operation ||
        !["queued", "running"].includes(row.operation.status) ||
        (row.operation.nextAttemptAt && Date.parse(row.operation.nextAttemptAt) > Date.now())
      )
        return;
      let op: CloudWorkspaceOperation = {
        ...row.operation,
        status: "running",
        attempts: row.operation.attempts + 1,
        nextAttemptAt: null,
        error: null,
      };
      const save = async (message?: string) => {
        if (message) op.logs = [...op.logs, message.trim()].slice(-40);
        await repos.cloudWorkspace.updateOperation(id, op, op.id);
      };
      await save("Checking the server and its current subscription…");
      try {
        if (op.kind === "ensure") {
          await save("Preparing the subscribed Docker host…");
          await ensureCloudWorkspaceHost({
            ownerWorkspaceId: id,
            organizationId: row.organizationId,
          });
        } else if (op.kind === "resize") {
          await assertCloudCanSpend(row.organizationId, id);
          const { binding, provider } = await readCloudWorkspaceHost(row.organizationId, id);
          if (!binding?.workspaceId || !provider || !op.resources)
            throw new Error("The server resize target is unavailable");
          const allowed = await cloudSubscriptionWorkspaceResources(row.organizationId, id);
          if (
            Object.entries(op.resources).some(
              ([key, value]) => value > allowed[key as keyof typeof allowed]!,
            )
          )
            throw new Error(
              "The server plan changed. Review its capacity before retrying the resize.",
            );
          const { client, namespace } = await getNamespaceClient(row.organizationId, id);
          await save("Resizing the server; running projects will briefly restart…");
          await withMemberRuntimeLocks(row, () =>
            createProvisionLock(`cloud:server:${binding.workspaceId}`).run(() =>
              resizeDockerWorkspace({
                client,
                namespace,
                workspaceId: binding.workspaceId!,
                resources: op.resources!,
                restartCheckpoint: {
                  workloads: op.restartWorkloads,
                  save: async (ids) => {
                    op.restartWorkloads = ids;
                    await save("Saved the running applications for recovery.");
                  },
                },
              }),
            ),
          );
          await repos.cloudDockerWorkspace.updateResources(
            { ownerWorkspaceId: id },
            row.organizationId,
            binding.workspaceId,
            op.resources,
          );
        } else {
          await withCloudBillingLock(
            row.organizationId,
            async (sync) => {
              await assertWorkspaceCheckoutsSettled(
                await requireCloudWorkspace(row.organizationId, id),
              );
              if (row.namespace) assertSubscriptionEnded(await sync({ syncResourceLimits: false }));
              if ((await repos.project.listByWorkspace(id, row.organizationId)).length)
                throw new AppError(
                  "The server still has projects",
                  409,
                  "CLOUD_WORKSPACE_NOT_EMPTY",
                );
              if ((await requireCloudWorkspace(row.organizationId, id)).linkedProjects.some(link => link.projects.length))
                throw new AppError("The server still has projects on a connected installation", 409, "CLOUD_WORKSPACE_NOT_EMPTY");
              await save("Confirming provider cleanup before removing this empty server…");
              const binding = await hostForDeletion(row);
              if (binding?.workspaceId) {
                const client = getOblienClient();
                const namespace = row.namespace;
                if (!namespace || namespace !== binding.namespace)
                  throw new Error("Cloud workspace namespace changed");
                const ws = client.workspace(binding.workspaceId);
                try {
                  const current = await ws.get();
                  if (current.namespace !== namespace)
                    throw new Error("Provider workspace ownership changed");
                } catch (error) {
                  if ((error as { status?: number }).status !== 404) throw error;
                }
                await deleteCloudWorkspace(ws);
              }
              await repos.cloudWorkspace.finishDeletion(id, row.organizationId);
            },
            id,
          );
          return;
        }
        op = {
          ...op,
          status: "succeeded",
          completedAt: new Date().toISOString(),
          error: null,
          nextAttemptAt: null,
        };
        await save(
          op.kind === "resize"
            ? "Server capacity applied; previously running services restored."
            : "Server is ready for projects.",
        );
      } catch (error) {
        const terminal = op.attempts >= 3 || (error instanceof AppError && error.statusCode < 500);
        op = {
          ...op,
          status: terminal ? "failed" : "queued",
          error: safeErrorMessage(error),
          nextAttemptAt: terminal
            ? null
            : new Date(Date.now() + op.attempts * 60_000).toISOString(),
        };
        await save(op.error!);
      }
    }, undefined, { lifecycle: true, scope: "lifecycle" });
  });
}

export async function retry(ctx: ExecutionContext, id: string) {
  if (!env.CLOUD_MODE) return linkedSummaryOperation(ctx, id, "/retry");
  requireSaas();
  const row = await requireCloudWorkspace(ctx.organizationId, id);
  if (!row.operation || row.operation.status !== "failed") return summary(row);
  if (row.operation.kind === "delete")
    await authorization.authorize(ctx, {
      resourceType: "billing",
      resourceId: "*",
      action: "admin",
    });
  if (row.operation.kind === "resize") {
    for (const project of await repos.project.listByWorkspace(id, ctx.organizationId)) {
      await authorization.authorize(ctx, {
        resourceType: "project",
        resourceId: project.id,
        action: "write",
      });
    }
  }
  const op: CloudWorkspaceOperation = {
    ...row.operation,
    status: "queued",
    attempts: 0,
    nextAttemptAt: null,
    error: null,
  };
  const updated = await repos.cloudWorkspace.requestOperation(id, ctx.organizationId, op);
  dispatch(id);
  return summary(updated);
}

export async function runCloudWorkspaceRecovery() {
  for (const row of await repos.cloudWorkspace.listSettledLinkedActivities()) {
    await reconcileSettledCloudActivity(row).catch(error =>
      console.warn(`[cloud-activity] ${row.id}: ${safeErrorMessage(error)}`));
  }
  const rows = await repos.cloudWorkspace.listPendingOperations();
  for (const row of rows) await processWorkspaceOperation(row.id).catch(error =>
    console.warn(`[cloud-workspace] ${row.id}: ${safeErrorMessage(error)}`));
  return { attempted: rows.length };
}
