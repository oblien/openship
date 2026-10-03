import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { AppError, safeErrorMessage } from "@repo/core";
import { repos, type CloudWorkspace, type CloudWorkspaceActivity } from "@repo/db";
import { withManagedCommandTracking } from "@repo/adapters";
import { createProvisionLock, tryWithProvisionLock } from "./provision-lock";
import { remoteCloudRequest, requireLinkedCloudServer } from "./cloud/server-link";

const held = new AsyncLocalStorage<ReadonlyMap<string, { active: boolean; owner: CloudWorkspace; activity: CloudWorkspaceActivity }>>();

async function recoverCommands(row: CloudWorkspace) {
  if (!row.activity?.commands?.length) return;
  // Lazy import avoids making transport acquisition depend on admission setup.
  const { openCloudWorkspaceExecutor } = await import("./cloud-workspace-host");
  const executor = await openCloudWorkspaceExecutor(row.organizationId, row.id);
  try {
    for (const command of row.activity.commands) {
      await executor.recoverCommand(command);
      await repos.cloudWorkspace.completeActivityCommand(row.id, row.activity.id, command.marker);
    }
  } finally {
    await executor.dispose();
  }
}

/** Interactive sessions retain the same admission until their final close. */
export async function holdCloudWorkspaceActivity(workspaceId: string | null, scope: string) {
  if (!workspaceId) return { run: <T>(work: () => Promise<T>) => work(), release: async () => {} };
  let ready!: (run: ReturnType<typeof AsyncLocalStorage.snapshot>) => void;
  let failed!: (error: unknown) => void;
  let finish!: () => void;
  const admitted = new Promise<ReturnType<typeof AsyncLocalStorage.snapshot>>((resolve, reject) => { ready = resolve; failed = reject; });
  const lifetime = new Promise<void>(resolve => { finish = resolve; });
  const completion = withCloudWorkspaceActivity(workspaceId, async () => {
    ready(AsyncLocalStorage.snapshot());
    await lifetime;
  }, undefined, { scope });
  void completion.catch(failed);
  const run = await admitted;
  return { run: <T>(work: () => Promise<T>) => run(work), release: async () => { finish(); await completion; } };
}

async function remoteActivity(row: CloudWorkspace, activity: CloudWorkspaceActivity, release: boolean) {
  const { remote } = await requireLinkedCloudServer(row.organizationId, row.id);
  const projects = (await repos.project.listByWorkspace(row.id, row.organizationId)).map(project => ({ id: project.id, name: project.name }));
  const result = await remoteCloudRequest<{ id: string; released?: boolean }>(row.organizationId,
    `/api/cloud/servers/${encodeURIComponent(remote.serverId)}/activity${release ? "/release" : ""}`, {
      method: "POST", body: JSON.stringify({ id: activity.id, controllerId: activity.controllerId, scope: activity.scope, projects }),
    }, remote);
  if (result.id !== activity.id || (release && result.released !== true))
    throw new AppError("Cloud returned a different server operation", 502, "CLOUD_SERVER_IDENTITY_MISMATCH");
}

/** Only completed work can be released after a lost HTTP acknowledgement. An
 * interrupted critical section stays reserved for its original scope to resume. */
export async function reconcileSettledCloudActivity(row: CloudWorkspace) {
  const activity = row.activity;
  if (!row.remote || !activity?.settled) return;
  await remoteActivity(row, activity, true);
  await repos.cloudWorkspace.releaseActivity(row.id, row.organizationId, activity.id, activity.controllerId);
}

/** Local advisory locking plus a durable Cloud admission claim coordinates the
 * same host across independent control planes. No timeout releases running work.
 * Order: workspace admission, then project locks, then short adapter locks. */
export async function withCloudWorkspaceActivity<T>(
  workspaceId: string | null | undefined,
  work: () => Promise<T>,
  signal?: AbortSignal,
  options: { scope?: string; lifecycle?: boolean } = {},
): Promise<T> {
  if (!workspaceId || held.getStore()?.get(workspaceId)?.active) return work();
  return createProvisionLock(`cloud:workspace-activity:${workspaceId}`).run(
    () => runCloudWorkspaceActivity(workspaceId, work, signal, options), signal,
  );
}

/** An idle host lock proves that the original controller is no longer in its
 * critical section. Recorded remote commands still have to be recovered. */
export async function tryWithCloudWorkspaceActivity<T>(
  workspaceId: string,
  work: () => Promise<T>,
  scope: string,
): Promise<T | undefined> {
  if (held.getStore()?.get(workspaceId)?.active) return undefined;
  return tryWithProvisionLock(`cloud:workspace-activity:${workspaceId}`,
    () => runCloudWorkspaceActivity(workspaceId, work, undefined, { scope }));
}

async function runCloudWorkspaceActivity<T>(
  workspaceId: string,
  work: () => Promise<T>,
  signal: AbortSignal | undefined,
  options: { scope?: string; lifecycle?: boolean },
): Promise<T> {
  let row = await repos.cloudWorkspace.findById(workspaceId);
  if (!row) throw new AppError("Managed server not found", 404, "CLOUD_WORKSPACE_NOT_FOUND");
  if (row.remote && options.lifecycle) throw new Error("Linked server lifecycle belongs to Cloud");
  if (row.activity?.settled && row.remote) {
    await reconcileSettledCloudActivity(row);
    row = (await repos.cloudWorkspace.findById(workspaceId))!;
  }
  const controllerId = row.remote ? `installation:${row.id}` : "saas";
  const scope = options.scope ?? "server";
  const previous = row.activity;
  // The advisory lock fences local callers, not remote children. Recover any
  // recorded commands before the interrupted scope can resume after a crash.
  const activity = await repos.cloudWorkspace.claimActivity(row.id, row.organizationId,
    previous?.controllerId === controllerId && previous.scope === scope ? previous : {
      id: randomUUID(), controllerId, scope, startedAt: new Date().toISOString(),
    }, options.lifecycle);
  let admitted = !row.remote;
  const state = { active: true, owner: row, activity };
  const next = new Map(held.getStore());
  next.set(workspaceId, state);
  const commandOwners = new Map<string, typeof state>();
  try {
    if (row.remote) {
      await remoteActivity(row, activity, false);
      admitted = true;
    }
    await recoverCommands(row);
    signal?.throwIfAborted();
    return await held.run(next, () => withManagedCommandTracking({
      async record(command) {
        if (!state.active) throw new AppError("The server operation has finished", 409, "CLOUD_WORKSPACE_ACTIVITY_CHANGED");
        // A migration/connection may hold two servers. Dispatch by the verified
        // provider binding; nested admission must never attribute A's command to B.
        for (const entry of next.values()) {
          if (!entry.active) continue;
          const binding = await repos.cloudDockerWorkspace.find({ ownerWorkspaceId: entry.owner.id }, entry.owner.organizationId);
          if (binding?.workspaceId !== command.workspaceId) continue;
          await repos.cloudWorkspace.recordActivityCommand(entry.owner.id, entry.activity.id, command);
          commandOwners.set(command.marker, entry);
          return;
        }
        throw new AppError("The command belongs to a different managed server", 409, "CLOUD_SERVER_IDENTITY_MISMATCH");
      },
      async complete(marker) {
        if (!state.active) throw new AppError("The server operation has finished", 409, "CLOUD_WORKSPACE_ACTIVITY_CHANGED");
        const entry = commandOwners.get(marker);
        if (!entry) throw new AppError("The command has no admitted server", 409, "CLOUD_SERVER_IDENTITY_MISMATCH");
        await repos.cloudWorkspace.completeActivityCommand(entry.owner.id, entry.activity.id, marker);
        commandOwners.delete(marker);
      },
    }, work));
  } catch (error) {
    // A definitive refusal happened before any work. A lost response may
    // have acquired remotely, so retain the local outbox for release recovery.
    if (!admitted && error instanceof AppError && error.statusCode < 500)
      await repos.cloudWorkspace.releaseActivity(row.id, row.organizationId, activity.id, controllerId);
    throw error;
  } finally {
    state.active = false;
    const remaining = (await repos.cloudWorkspace.findById(row.id))?.activity;
    if (remaining?.id === activity.id && remaining.commands?.length)
      throw new AppError("A server command has not confirmed its exit. Retry this operation to recover it before changing the server.",
        503, "CLOUD_COMMAND_EXIT_UNCONFIRMED");
    try {
      await repos.cloudWorkspace.settleActivity(row.id, activity.id);
      if (row.remote) await remoteActivity(row, activity, true);
      await repos.cloudWorkspace.releaseActivity(row.id, row.organizationId, activity.id, controllerId);
    } catch (error) {
      // Persisted completion is retried by recovery; it never unlocks another
      // activity or turns a successful deployment into a failed one.
      console.warn(`[cloud-activity] release pending for ${row.id}: ${safeErrorMessage(error)}`);
    }
  }
}
