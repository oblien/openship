/**
 * Scoped control-plane export. Collects the selected records, lifts each secret's
 * plaintext into a passphrase-sealed bundle, and strips the ciphertext from the
 * payload so the file carries secrets ONLY inside the sealed bundle.
 */

import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { isLoopbackHost } from "@repo/core";
import {
  countInstanceSubgraphTables,
  db,
  dumpProjectTransfer,
  dumpSubgraph,
  eq,
  inArray,
  readTransferRows,
  schema,
  transferProject,
  type DatabaseDump,
} from "@repo/db";

import { env } from "@repo/platform/engine/config/env";
import { CloudInstanceNotTransferableError } from "./errors";
import { sealSecretBundle } from "./passphrase-crypto";
import { extractPlaintext } from "./secret-codec";
import { SECRET_COLUMNS, stripTransferSecrets } from "./secret-registry";
import {
  InvalidExportSelectionError,
  resolveExportSelection,
  summarizeExportCounts,
} from "./selection";
import { getCloudConnectionStatusForOrg } from "@repo/platform/engine/lib/cloud/session";
import type {
  DataTransferFile,
  ExportPreview,
  ExportSelection,
  SecretBundle,
  SecretEntry,
  TransferManifest,
  TransferServer,
} from "./types";

export function transferServer(row: Record<string, unknown>, included = true): TransferServer {
  return {
    id: String(row.id),
    name: String(row.name ?? row.sshHost ?? row.id),
    host: String(row.sshHost ?? ""),
    port: Number(row.sshPort ?? 22),
    isLocal: row.isLocal === true,
    jumpHost: typeof row.sshJumpHost === "string" ? row.sshJumpHost : null,
    included,
    hasCredentials: !!(row.sshPassword || row.sshPrivateKey || row.sshKeyPath),
  };
}

/** Source-relative SSH addresses cannot identify a host on another control plane. */
export function needsExplicitServerMapping(server: TransferServer): boolean {
  return (
    server.isLocal ||
    isLoopbackHost(server.jumpHost) ||
    (!server.jumpHost && isLoopbackHost(server.host))
  );
}

async function buildManifest(
  dump: DatabaseDump,
  serverIds: string[],
  warnings: string[],
): Promise<TransferManifest> {
  const projects = (dump.tables.project ?? []).map(transferProject);
  const includedServers = new Set((dump.tables.servers ?? []).map((row) => row.id));
  const servers = (await readTransferRows("servers", "id", serverIds)).map((row) =>
    transferServer(row, includedServers.has(row.id)),
  );
  const cloudOrgs = [
    ...new Set(
      projects
        .filter((project) => project.cloudWorkspaceId)
        .map((project) => project.organizationId),
    ),
  ];
  const cloudAccounts = await Promise.all(
    cloudOrgs.map(async (organizationId) => {
      const connection = await getCloudConnectionStatusForOrg(organizationId);
      return {
        organizationId,
        email: connection.connected ? (connection.user?.email ?? null) : null,
      };
    }),
  );
  if (cloudAccounts.length)
    warnings.push(
      "Cloud projects will work only when the destination workspace is connected to the same Openship Cloud account. A cloud server cannot be transferred in this file.",
    );
  if (servers.some((server) => !server.included))
    warnings.push(
      "Related self-hosted servers are not included. Map each server to an existing destination server during import, or include the servers in this export.",
    );
  if (
    servers.some(needsExplicitServerMapping) ||
    projects.some((project) => !project.serverId && !project.cloudWorkspaceId)
  ) {
    warnings.push(
      "Projects on the source control-plane host need an explicit server mapping at the destination.",
    );
  }
  if (
    (dump.tables.backup_destination ?? []).some(
      (row) =>
        row.kind === "local" || (row.kind === "sftp" && isLoopbackHost(String(row.sshHost ?? ""))),
    )
  ) {
    warnings.push(
      "Backup folders on the source control-plane host are not embedded. Reconnect or copy those folders on the destination; their imported backup schedules stay disabled until you verify the storage.",
    );
  }
  if (projects.some((project) => project.localPath))
    warnings.push(
      "Local source folders are not embedded. Reconnect the source folder or upload it on the destination before deploying.",
    );
  if (dump.tables.git_source?.length)
    warnings.push(
      "Git provider app keys are included. Update the provider app's callback and webhook URLs to the destination control-plane URL after import.",
    );
  if (
    (dump.tables.project ?? []).some((row) => row.webhookId || row.webhookDomain) ||
    dump.tables.incoming_webhook?.length
  ) {
    warnings.push(
      "Webhook credentials are preserved. Update webhook sender URLs when the control-plane address changes.",
    );
  }
  warnings.push(
    "This archive contains control-plane metadata and credentials. Container volumes, database contents, local source files, and host TLS files stay on their server; moving to a different server requires migration or backup restore.",
  );
  return { projects, servers, cloudAccounts, warnings: [...new Set(warnings)] };
}

export async function previewInstanceExport(
  selectionInput?: ExportSelection,
): Promise<ExportPreview> {
  if (env.CLOUD_MODE) throw new CloudInstanceNotTransferableError();
  const projects = (
    await db
      .select({
        id: schema.project.id,
        groupId: schema.project.groupId,
        organizationId: schema.project.organizationId,
        name: schema.project.name,
        slug: schema.project.slug,
        environmentName: schema.project.environmentName,
        serverId: schema.project.serverId,
        cloudWorkspaceId: schema.project.cloudWorkspaceId,
        localPath: schema.project.localPath,
        deletedAt: schema.project.deletedAt,
      })
      .from(schema.project)
  )
    .filter((row) => !row.deletedAt)
    .map(transferProject);
  const { selection, excludedTables } = resolveExportSelection(selectionInput);
  if (selection.scope !== "projects")
    return { ...summarizeExportCounts(await countInstanceSubgraphTables()), projects };
  const graph = await projectDump(selection, excludedTables, true);
  return {
    ...summarizeExportCounts(
      Object.fromEntries(Object.entries(graph.tables).map(([table, rows]) => [table, rows.length])),
    ),
    projects,
    manifest: await buildManifest(graph.dump, graph.serverIds, graph.warnings),
  };
}

async function projectDump(
  selection: ExportSelection,
  excludedTables: string[],
  metadataOnly = false,
) {
  try {
    return await dumpProjectTransfer(selection, excludedTables, metadataOnly);
  } catch (error) {
    throw new InvalidExportSelectionError(
      error instanceof Error ? error.message : "The project selection could not be exported.",
    );
  }
}

/** Materialize durable inherited clone credentials without copying user/auth rows. */
async function inheritCloneCredentials(dump: DatabaseDump, warnings: string[]): Promise<void> {
  const projects = dump.tables.project ?? [];
  const orgIds = [...new Set(projects.map((row) => String(row.organizationId)))];
  const owners = orgIds.length
    ? await db.select().from(schema.member).where(inArray(schema.member.organizationId, orgIds))
    : [];
  const [instance] = await db.select().from(schema.instanceSettings).limit(1);
  for (const organizationId of orgIds) {
    const owner = owners.find(
      (row) => row.organizationId === organizationId && row.role === "owner",
    );
    if (!owner) continue;
    const [settings] = await db
      .select()
      .from(schema.userSettings)
      .where(eq(schema.userSettings.userId, owner.userId))
      .limit(1);
    for (const project of projects) {
      if (
        project.organizationId !== organizationId ||
        project.cloneTokenEncrypted ||
        !project.gitRepo
      )
        continue;
      const inherited =
        settings?.cloneTokenAsDefault && settings.cloneTokenEncrypted
          ? settings.cloneTokenEncrypted
          : project.gitProvider === "github"
            ? instance?.ghDeviceTokenEncrypted
            : null;
      if (inherited) {
        project.cloneTokenEncrypted = inherited;
        project.cloneTokenSetAt = new Date().toISOString();
        warnings.push(
          "An inherited clone token is included as a project credential so private repositories remain accessible after import.",
        );
      } else if (
        !(dump.tables.server_github_auth ?? []).some(
          (auth) => auth.serverId === project.serverId,
        ) &&
        !(dump.tables.git_installation ?? []).some(
          (install) => install.installationId === project.installationId && install.sourceId,
        )
      ) {
        warnings.push(
          "Some repositories use a host CLI, OAuth, or cloud Git connection. Reconnect that Git identity at the destination if no project clone credential is available.",
        );
      }
    }
  }
}

/** Build a scrubbed snapshot plus its in-memory plaintext credential bundle. */
export async function prepareInstanceExport(
  selectionInput?: ExportSelection,
): Promise<{ file: DataTransferFile; secrets: SecretBundle | null }> {
  if (env.CLOUD_MODE) throw new CloudInstanceNotTransferableError();

  const { selection, excludedTables } = resolveExportSelection(selectionInput);
  const graph =
    selection.scope === "projects" ? await projectDump(selection, excludedTables) : null;
  const dump =
    graph?.dump ?? (await dumpSubgraph({ kind: "instance" }, { excludeTables: excludedTables }));
  const warnings = graph?.warnings ?? [];
  if (graph && selection.includeSecrets !== false) await inheritCloneCredentials(dump, warnings);
  const serverIds = graph?.serverIds ?? (dump.tables.servers ?? []).map((row) => String(row.id));
  const manifest = await buildManifest(dump, serverIds, warnings);

  const entries: SecretEntry[] = [];
  for (const spec of selection.includeSecrets === false ? [] : SECRET_COLUMNS) {
    const rows = dump.tables[spec.sqlName];
    if (!rows) continue;
    for (const row of rows) {
      const id = row.id;
      if (typeof id !== "string") continue;
      const entry = extractPlaintext(spec, id, row[spec.column]);
      if (entry) entries.push(entry);
    }
  }

  if (selection.includeSecrets !== false) {
    for (const server of dump.tables.servers ?? []) {
      if (server.isLocal || server.sshPrivateKey || !server.sshKeyPath) continue;
      const keyPath = String(server.sshKeyPath);
      const path = keyPath.startsWith("~/") ? resolve(homedir(), keyPath.slice(2)) : keyPath;
      try {
        const info = await stat(path);
        if (!info.isFile() || info.size > 1_048_576) throw new Error("Invalid SSH key file");
        const value = await readFile(path, "utf8");
        entries.push({
          table: "servers",
          id: String(server.id),
          column: "sshPrivateKey",
          scheme: "enc1",
          value,
        });
        server.sshKeyPath = null;
      } catch {
        throw new InvalidExportSelectionError(
          `The SSH key file for ${String(server.name ?? server.sshHost)} could not be read. Add its private key in server settings or export without credentials.`,
        );
      }
    }
  }
  stripTransferSecrets(dump.tables);

  return {
    file: {
      kind: graph ? "openship-project-export" : "openship-instance-export",
      envelopeVersion: 2,
      createdAt: new Date().toISOString(),
      sourceDriver: dump.sourceDriver,
      selection,
      manifest,
      summary: {
        rows: Object.values(dump.tables).reduce((count, rows) => count + rows.length, 0),
        tables: Object.keys(dump.tables).length,
      },
      dump,
      secrets: null,
    },
    secrets: entries.length > 0 ? { version: 1, entries } : null,
  };
}

export async function exportInstance(opts: {
  passphrase?: string;
  selection?: ExportSelection;
}): Promise<DataTransferFile> {
  if (env.CLOUD_MODE) throw new CloudInstanceNotTransferableError();
  if (opts.selection?.includeSecrets === true && !opts.passphrase) {
    throw new InvalidExportSelectionError(
      "Set a transfer password to include environment values, keys, and credentials.",
    );
  }
  const prepared = await prepareInstanceExport(opts.selection);
  return {
    ...prepared.file,
    secrets:
      opts.passphrase && prepared.secrets
        ? sealSecretBundle(prepared.secrets, opts.passphrase)
        : null,
  };
}
