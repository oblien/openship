import { DockerRuntime, type CommandExecutor } from "@repo/adapters";
import { createServerDockerRuntime } from "../../lib/deployment-runtime";
import { acquireServerExecution } from "../../lib/server-execution";
import { openCloudWorkspaceDockerRuntime } from "../../lib/cloud-workspace-host";
import { buildSshConfig } from "../../lib/ssh-manager";
import { registryAuthResolver } from "../credentials/registry-auth";
import { requireMigrationServer, assertMigrationEndpoints } from "./migration-access";
import type { ServerConn } from "./direct-transfer";
import { withCloudWorkspaceActivity } from "../../lib/cloud-workspace-lock";

/** Migration has server-level authority, unlike a single project's runtime.
 * It still uses the same Docker runtime and owned SSH/provider transports. */
export async function createMigrationDockerRuntime(serverId: string, organizationId: string): Promise<DockerRuntime> {
  const server = await requireMigrationServer(organizationId, serverId);
  if (server.workspaceId) return openCloudWorkspaceDockerRuntime(organizationId, server.workspaceId);
  if (server.purpose !== "migration_source") return createServerDockerRuntime(serverId, organizationId);
  const connection = await acquireServerExecution(organizationId, serverId, { migration: true });
  try {
    const config = await buildSshConfig(server);
    if (!config) throw new Error("Migration source connection is incomplete");
    const runtime = await DockerRuntime.create({
      ...config, transport: "ssh", executor: connection.executor,
      resolveRegistryAuth: registryAuthResolver(organizationId),
    });
    const dispose = runtime.dispose.bind(runtime);
    runtime.dispose = async () => {
      try { await dispose(); } finally { await connection.release(); }
    };
    return runtime;
  } catch (error) {
    await connection.release();
    throw error;
  }
}

/** No SSH address on managed servers: the direct transfer chooses pull/push
 * through the reachable peer instead of exposing a VM's SSH port. */
export async function createMigrationCommandExecutor(serverId: string, organizationId: string) {
  const server = await requireMigrationServer(organizationId, serverId);
  const connection = await acquireServerExecution(organizationId, serverId, { migration: true });
  try {
    let conn: ServerConn | null = null;
    if (!server.workspaceId && !server.isLocal) {
      const config = await buildSshConfig(server);
      if (!config) throw new Error("Migration source connection is incomplete");
      conn = { host: config.host, port: config.port ?? 22, user: config.username ?? "root", hostKey: server.sshHostKey ?? undefined };
    }
    return { executor: connection.executor, conn, isLocal: server.isLocal, release: connection.release };
  } catch (error) {
    await connection.release();
    throw error;
  }
}

/** Validate both owners first; release the source if opening the target fails. */
export async function openMigrationTransferEndpoints(sourceId: string, targetId: string, organizationId: string) {
  await assertMigrationEndpoints(organizationId, sourceId, targetId);
  const source = await createMigrationCommandExecutor(sourceId, organizationId);
  try {
    const target = await createMigrationCommandExecutor(targetId, organizationId);
    return { source, target, release: async () => {
      try { await target.release(); } finally { await source.release(); }
    } };
  } catch (error) {
    await source.release();
    throw error;
  }
}

export async function withMigrationExecution<T>(serverId: string, organizationId: string, work: (executor: CommandExecutor) => Promise<T>) {
  const connection = await createMigrationCommandExecutor(serverId, organizationId);
  try { return await work(connection.executor); }
  finally { await connection.release(); }
}

/** Docker reports 304 when a retry has already reached the requested state. */
export async function setMigrationContainerState(runtime: DockerRuntime, id: string, running: boolean) {
  try { await (running ? runtime.start(id) : runtime.stop(id)); }
  catch (error) { if ((error as { statusCode?: number }).statusCode !== 304) throw error; }
}

/** Acquire both managed hosts in a stable order. Release before queuing a
 * deployment: its worker takes this same admission independently. */
export async function withMigrationActivity<T>(organizationId: string, sourceId: string, targetId: string, runId: string, work: () => Promise<T>) {
  const { source, target } = await assertMigrationEndpoints(organizationId, sourceId, targetId);
  const workspaces = [...new Set([source.workspaceId, target.workspaceId].filter((id): id is string => !!id))].sort();
  const acquire = (index: number): Promise<T> => index === workspaces.length ? work()
    : withCloudWorkspaceActivity(workspaces[index], () => acquire(index + 1), undefined, { scope: `migration:${runId}` });
  return acquire(0);
}
