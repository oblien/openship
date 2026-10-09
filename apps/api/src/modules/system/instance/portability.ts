import { db, eq, schema } from "@repo/db";
import { AppError, isLoopbackHost } from "@repo/core";
import { createExecutor } from "@repo/adapters";
import { buildSshConfig } from "@repo/platform/engine/lib/ssh-manager";
import { withServerExecution } from "@repo/platform/engine/lib/server-execution";
import { inspectHostIssuedIdentity } from "@repo/platform/engine/lib/host-port-target";
import { prepareInstanceExport } from "../data-transfer/export.service";

export interface HostMapping {
  sourceServerId: string;
  connectionServerId: string;
}

export function needsHostMapping(
  server: Pick<typeof schema.servers.$inferSelect, "isLocal" | "sshHost" | "sshJumpHost">,
): boolean {
  return server.isLocal || isLoopbackHost(server.sshHost) || isLoopbackHost(server.sshJumpHost);
}

export async function assertHandoffAccount(userId: string): Promise<void> {
  const [owner] = await db.select().from(schema.user).where(eq(schema.user.id, userId));
  if (!owner || owner.role !== "admin")
    throw new AppError("Only the instance administrator can move it.", 403);
  if (owner.autoProvisioned)
    throw new AppError(
      "Set your account email and password in Settings → Instance before moving. You will use this account to sign in on the server.",
      409,
      "INSTANCE_ACCOUNT_REQUIRED",
    );
}

/** Preserve the host's identity: only its execution connection changes. Runtime
 * ids, ports, service ownership, volumes and retained releases remain untouched. */
export async function assertPortableInstance(mapping?: HostMapping): Promise<void> {
  await (await import("@repo/platform/engine/modules/actions/lifecycle")).assertActionsTransferReady();
  const servers = await db.select().from(schema.servers);
  if (
    mapping &&
    !servers.some((server) => server.id === mapping.sourceServerId && needsHostMapping(server))
  )
    throw new AppError("The source host connection changed. Check it and retry.", 409);
  const projects = await db.select().from(schema.project);
  const blockers: string[] = [];
  for (const server of servers) {
    if (!server.workspaceId && !server.isLocal && server.sshAuthMethod === "agent") {
      blockers.push(
        `“${server.name}” uses this computer’s SSH agent. Save a private key or password in its connection settings before moving.`,
      );
    }
    if (!needsHostMapping(server)) continue;
    const replacement =
      mapping?.sourceServerId === server.id
        ? servers.find((item) => item.id === mapping.connectionServerId)
        : undefined;
    if (
      !replacement ||
      replacement.isLocal ||
      isLoopbackHost(replacement.sshHost) ||
      isLoopbackHost(replacement.sshJumpHost) ||
      !replacement.sshHost ||
      replacement.workspaceId ||
      replacement.purpose !== "deployment" ||
      replacement.organizationId !== server.organizationId
    ) {
      blockers.push(
        `Connect the source host “${server.name}” over SSH and select it as the source connection. Its apps will keep running there.`,
      );
    } else if (server.organizationId) {
      // Force the proposed transport through its saved SSH adapter. The normal
      // local-host shortcut would make a broken SSH connection look healthy.
      const config = await buildSshConfig(replacement);
      if (!config || config.useSystemSsh)
        throw new AppError(
          "Save a portable private key or password for the source host connection.",
          409,
        );
      const remote = createExecutor(config);
      try {
        const [sourceIdentity, remoteIdentity] = await Promise.all([
          withServerExecution(server.organizationId, server.id, inspectHostIssuedIdentity),
          inspectHostIssuedIdentity(remote),
        ]);
        if (!sourceIdentity || sourceIdentity !== remoteIdentity)
          blockers.push(
            `The SSH connection for “${server.name}” does not identify the same host. Select that host’s own SSH connection.`,
          );
      } finally {
        await remote.dispose();
      }
    }
  }
  for (const project of projects.filter((row) => !row.deletedAt)) {
    if (project.localPath)
      blockers.push(
        `“${project.name}” uses a local source folder. Connect a Git repository before moving the controller.`,
      );
    if (project.activeDeploymentId && !project.serverId && !project.workspaceId)
      blockers.push(
        `“${project.name}” runs on this computer without a server binding. Move it to a connected server first.`,
      );
  }
  const destinations = await db.select().from(schema.backupDestination);
  if (destinations.some((row) => row.kind === "local"))
    blockers.push(
      "A backup destination uses a local folder. Connect that folder through SFTP before moving, so its backups stay accessible.",
    );
  if (blockers.length)
    throw new AppError(blockers.join("\n"), 409, "INSTANCE_MOVE_NEEDS_ATTENTION");
}

export async function prepareHandoffSnapshot(
  payload: Awaited<ReturnType<typeof prepareInstanceExport>>,
  mapping?: HostMapping,
  sourceProjectId?: string | null,
): Promise<void> {
  // The source's API keeps running as a fenced receiver/client, but is no
  // longer the incoming instance's self-app. Preserve its runtime records;
  // only relinquish the control-plane marker. Legacy CLI installs use the
  // reserved openship slug, while provisioned instances have an exact binding.
  for (const project of payload.file.dump.tables.project ?? []) {
    if (
      project.appTemplateId === "openship" &&
      (sourceProjectId ? project.id === sourceProjectId : project.slug === "openship")
    )
      project.appTemplateId = null;
  }
  if (mapping) {
    const servers = payload.file.dump.tables.servers ?? [];
    const source = servers.find((row) => row.id === mapping.sourceServerId);
    const connection = servers.find((row) => row.id === mapping.connectionServerId);
    if (!source || !connection)
      throw new AppError("The source host connection changed. Check it and retry.", 409);
    for (const key of Object.keys(connection).filter((key) => key.startsWith("ssh")))
      source[key] = connection[key];
    source.isLocal = false;
    const entries = payload.secrets?.entries ?? [];
    for (const entry of entries.filter(
      (entry) => entry.table === "servers" && entry.id === connection.id,
    )) {
      const index = entries.findIndex(
        (old) => old.table === entry.table && old.id === source.id && old.column === entry.column,
      );
      if (index !== -1) entries.splice(index, 1);
      entries.push({ ...entry, id: String(source.id) });
    }
  }
  for (const settings of payload.file.dump.tables.instance_settings ?? []) {
    settings.teamMode = "single_user";
    settings.migrationTargetUrl = null;
    settings.migrationServerId = null;
    settings.migrationInProgress = false;
    settings.migrationStartedAt = null;
    // Existing destinations remain controlled through their original adapters.
    // Do not invent a second "This Server" target when the API moves.
    settings.hostControlEnabled = false;
    settings.authMode = "local";
  }
}
