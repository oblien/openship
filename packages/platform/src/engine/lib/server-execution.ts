import { AppError, NotFoundError } from "@repo/core";
import { repos, tryAcquireAdvisoryLock } from "@repo/db";
import type { CommandExecutor, ShellOptions } from "@repo/adapters";
import { assertServerExecution, assertSelfHosted, assertDeploymentServer } from "../modules/system/server-access";
import { openCloudWorkspaceExecutor } from "./cloud-workspace-host";
import { sshManager } from "./ssh-manager";
import { withCloudWorkspaceActivity, holdCloudWorkspaceActivity } from "./cloud-workspace-lock";

/** One connection boundary for host commands, monitoring and terminals. Callers
 * authorize serverId first; this also checks tenant ownership before connecting. */
export async function acquireServerExecution(organizationId: string, serverId: string, options?: { migration: true }) {
  const server = await repos.server.getInOrganization(serverId, organizationId);
  if (!server) throw new NotFoundError("Server", serverId);
  if (!options?.migration) assertDeploymentServer(server);
  let executor: CommandExecutor;
  let dispose: () => void | Promise<void>;
  if (server.workspaceId) {
    executor = await openCloudWorkspaceExecutor(organizationId, server.workspaceId);
    dispose = () => executor.dispose();
  } else {
    if (!(options?.migration && server.purpose === "migration_source")) {
      assertSelfHosted();
      await assertServerExecution(server);
    }
    sshManager.retain(serverId);
    try {
      executor = await sshManager.acquire(serverId);
    } catch (error) {
      sshManager.release(serverId);
      throw error;
    }
    dispose = () => sshManager.release(serverId);
  }
  let released = false;
  return {
    server,
    executor,
    run<T>(work: (executor: CommandExecutor) => Promise<T>): Promise<T> {
      return server.workspaceId ? work(executor) : sshManager.withExecutor(serverId, work);
    },
    async release() {
      if (released) return;
      released = true;
      await dispose();
    },
  };
}

export async function withServerExecution<T>(
  organizationId: string,
  serverId: string,
  work: (executor: CommandExecutor) => Promise<T>,
  options?: { mutation: true; scope?: string },
) {
  const run = async () => {
    const connection = await acquireServerExecution(organizationId, serverId);
    try {
      return await connection.run(work);
    } finally {
      await connection.release();
    }
  };
  if (!options?.mutation) return run();
  const server = await repos.server.getInOrganization(serverId, organizationId);
  if (!server) throw new NotFoundError("Server", serverId);
  return withCloudWorkspaceActivity(server.workspaceId, run, undefined, { scope: options.scope ?? "server" });
}

/** The terminal registry owns release until final close, including park/resume. */
const managedShells = new Set<string>();

export async function openServerShell(
  organizationId: string,
  serverId: string,
  options?: ShellOptions,
) {
  const connection = await acquireServerExecution(organizationId, serverId);
  let slot: Awaited<ReturnType<typeof tryAcquireAdvisoryLock>>;
  let ownsSlot = false;
  let released = false;
  let shell: Awaited<ReturnType<NonNullable<CommandExecutor["openShell"]>>> | undefined;
  let releaseActivity: (() => Promise<void>) | undefined;
  const release = async () => {
    if (released) return;
    released = true;
    try {
      try {
        await shell?.close();
      } finally {
        await connection.release();
      }
    } finally {
      try {
        await slot?.release();
      } finally {
        try { await releaseActivity?.(); }
        finally { if (ownsSlot) managedShells.delete(serverId); }
      }
    }
  };
  try {
    if (!connection.executor.openShell)
      throw new AppError(
        "This server connection does not support an interactive terminal",
        409,
        "SERVER_TERMINAL_UNAVAILABLE",
      );
    if (connection.server.workspaceId) {
      // The provider accepts one terminal socket per VM. Refuse a second host
      // session across replicas instead of disconnecting another user's terminal.
      const busy = () =>
        new AppError(
          "The managed server terminal is busy. Close its existing session and retry.",
          409,
          "SERVER_TERMINAL_BUSY",
        );
      if (managedShells.has(serverId)) throw busy();
      managedShells.add(serverId);
      ownsSlot = true;
      slot = await tryAcquireAdvisoryLock(`cloud:server-terminal:${serverId}`);
      if (!slot) throw busy();
      const activity = await holdCloudWorkspaceActivity(connection.server.workspaceId, "terminal");
      releaseActivity = activity.release;
      shell = await activity.run(() => connection.executor.openShell!(options));
    } else {
      shell = await connection.executor.openShell(options);
    }
    shell.onClose(() => {
      void release().catch(() => {});
    });
    return { shell, release };
  } catch (error) {
    await release();
    throw error;
  }
}
