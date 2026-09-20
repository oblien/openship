import {
  db,
  inArray,
  linkedProjectIds,
  schema,
  selectProjectTransfer,
  assertActiveDeploymentOwnership,
  snapshotTransferReader,
  topoOrderedTables,
  transferProject,
  transferReferences,
  transferUniqueKeys,
  type DatabaseDump,
  type DatabaseTransaction,
} from "@repo/db";
import { isLoopbackHost } from "@repo/core";
import { getCloudConnectionStatusForOrg } from "@repo/platform/engine/lib/cloud/session";
import { needsExplicitServerMapping, transferServer } from "./export.service";
import { resolveExportSelection, summarizeExportCounts } from "./selection";
import type {
  DataTransferFile,
  ImportPreview,
  ImportSelection,
  SecretBundle,
  TransferServer,
} from "./types";

type Row = Record<string, unknown>;
export interface ImportContext {
  organizationId: string;
  userId: string;
}
type Reader = Pick<DatabaseTransaction, "select">;

export class ProjectImportError extends Error {
  readonly code = "PROJECT_IMPORT_REQUIRES_REVIEW";
}

export function validateImportSelection(selection?: ImportSelection): void {
  if (!selection) return;
  if (selection.scope !== "instance" && selection.scope !== "projects")
    throw new ProjectImportError("Choose an instance or project import.");
  if (
    selection.projectIds !== undefined &&
    (!Array.isArray(selection.projectIds) ||
      !selection.projectIds.length ||
      selection.projectIds.length > 10_000 ||
      selection.projectIds.some((id) => typeof id !== "string" || !id.trim()))
  ) {
    throw new ProjectImportError("Select at least one project to import.");
  }
  if (selection.scope === "instance" && selection.projectIds !== undefined)
    throw new ProjectImportError("Select project scope to import a subset of projects.");
  if (
    selection.conflictPolicy !== undefined &&
    !["skip", "overwrite"].includes(selection.conflictPolicy)
  )
    throw new ProjectImportError("Choose whether to skip or overwrite existing projects.");
  for (const key of [
    "includeSecrets",
    "includeDomains",
    "includeBackups",
    "includeIntegrations",
    "overwriteDependencies",
  ] as const) {
    if (selection[key] !== undefined && typeof selection[key] !== "boolean")
      throw new ProjectImportError(`${key} must be a boolean.`);
  }
  for (const key of ["serverMappings", "projectActions"] as const) {
    const value = selection[key];
    if (
      value !== undefined &&
      (!value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.entries(value).some(
          ([id, action]) =>
            !id ||
            typeof action !== "string" ||
            !action ||
            (key === "projectActions" && action !== "skip" && action !== "overwrite"),
        ))
    ) {
      throw new ProjectImportError(`Invalid ${key}.`);
    }
  }
  if (selection.history !== undefined) resolveExportSelection({ history: selection.history });
}

function normalizeHost(host: unknown): string {
  return String(host ?? "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
}
function sameServer(source: TransferServer, target: TransferServer): boolean {
  return (
    !needsExplicitServerMapping(source) &&
    normalizeHost(source.host) === normalizeHost(target.host) &&
    source.port === target.port &&
    normalizeHost(source.jumpHost) === normalizeHost(target.jumpHost)
  );
}
const specs = new Map(topoOrderedTables().map((spec) => [spec.sqlName, spec]));
const projectOwned = new Set([
  "project",
  "service",
  "env_var",
  "deployment",
  "service_deployment",
  "domain",
  "route_rule",
  "incoming_webhook",
  "backup_policy",
  "backup_run",
  "backup_restore",
  "project_connection",
  "service_incident",
  "resource_usage",
  "docker_migration_run",
  "audit_event",
  "cloud_webhook_binding",
  "server_analytics",
  "server_analytics_geo",
]);

// Identity keys used when a dependency or project already exists under a
// different id. Shared rows are reused by default; projects are never matched
// by display name alone, nor allowed to take a domain from another project.
const naturalKeys: Record<string, string[][]> = {
  project_app: [["organizationId", "slug"]],
  project: [["groupId", "environmentSlug"]],
  service: [["projectId", "name"]],
  env_var: [["projectId", "serviceId", "key", "environment"]],
  domain: [["hostname"]],
  backup_policy: [["projectId", "serviceId"]],
  backup_destination: [["organizationId", "name"]],
  credential: [["organizationId", "provider", "selector", "name"]],
  dns_credential: [["organizationId", "provider", "name"]],
  git_source: [["organizationId", "provider", "apiBaseUrl", "appId"]],
  git_installation: [["organizationId", "sourceId", "provider", "owner"]],
  server_github_auth: [["serverId"]],
  github_deploy_key: [["serverId", "owner", "repo"]],
  project_connection: [["targetProjectId", "envKey"]],
  edge_target_verification: [["organizationId", "target"]],
  custom_app_template: [["organizationId", "appId"]],
  cloud_webhook_binding: [["organizationId", "cloudProjectId"]],
};
function matchRows(table: string, row: Row, existing: Row[]): Row[] {
  const keys = [
    ...(naturalKeys[table] ?? []),
    ...transferUniqueKeys(table).filter((keys) => keys.every((key) => row[key] != null)),
  ];
  return existing.filter(
    (candidate) =>
      candidate.id === row.id ||
      keys.some((keys) => keys.every((key) => (candidate[key] ?? null) === (row[key] ?? null))),
  );
}

async function existingRows(
  reader: Reader,
  name: string,
  values: Row[],
  orgId: string,
  parentIds: Record<string, string[]>,
): Promise<Row[]> {
  const spec = specs.get(name);
  if (!spec || !values.length) return [];
  const table = spec.table as unknown as Record<string, Parameters<typeof inArray>[0]>;
  const result = new Map<unknown, Row>();
  const queries: Array<[string, unknown[]]> = [["id", values.map((row) => row.id)]];
  if (table.organizationId) queries.push(["organizationId", [orgId]]);
  const domainHistory = name === "server_analytics" || name === "server_analytics_geo";
  for (const ref of transferReferences.filter((ref) => ref.table === name)) {
    if (domainHistory && ref.parent === "servers") continue;
    if (parentIds[ref.parent]?.length) queries.push([ref.column, parentIds[ref.parent]!]);
  }
  if (name === "domain") queries.push(["hostname", values.map((row) => row.hostname)]);
  if (domainHistory) queries.push(["domain", values.map((row) => row.domain)]);
  for (const [column, ids] of queries) {
    if (!table[column]) continue;
    const unique = [...new Set(ids)].filter((id) => id != null);
    for (let i = 0; i < unique.length; i += 5_000) {
      const rows = await reader
        .select()
        .from(spec.table)
        .where(inArray(table[column]!, unique.slice(i, i + 5_000)));
      for (const row of rows as Row[]) result.set(row.id, row);
    }
  }
  return [...result.values()];
}

const SOFT_REFS: Record<string, string> = {
  organizationId: "organization",
  projectId: "project",
  sourceProjectId: "project",
  targetProjectId: "project",
  cloudProjectId: "project",
  serviceId: "service",
  rootServiceId: "service",
  forkServiceId: "service",
  deploymentId: "deployment",
  activeDeploymentId: "deployment",
  refreshAppDeploymentId: "deployment",
  serviceKey: "service",
  serverId: "servers",
  sourceServerId: "servers",
  targetServerId: "servers",
  buildServerId: "servers",
  domainId: "domain",
  credentialId: "credential",
  destinationId: "backup_destination",
};
const SERVICE_ID_ARRAYS = new Set([
  "serviceIds",
  "targetServiceIds",
  "recreateServiceIds",
  "portCheckSkipped",
]);
const OPAQUE_CONFIG_FIELDS = new Set([
  "environment",
  "env",
  "envVars",
  "buildArgs",
  "advanced",
  "importedSpec",
  "driftSpec",
  "files",
]);
function remapNested(value: unknown, maps: Map<string, Map<string, string>>): unknown {
  if (Array.isArray(value)) return value.map((item) => remapNested(item, maps));
  if (!value || typeof value !== "object" || value instanceof Date) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => {
      if (OPAQUE_CONFIG_FIELDS.has(key)) return [key, child];
      if (typeof child === "string" && SOFT_REFS[key])
        return [key, maps.get(SOFT_REFS[key]!)?.get(child) ?? child];
      if (Array.isArray(child) && SERVICE_ID_ARRAYS.has(key))
        return [
          key,
          child.map((id) => (typeof id === "string" ? (maps.get("service")?.get(id) ?? id) : id)),
        ];
      if (key === "composeServices" && Array.isArray(child))
        return [
          key,
          child.map((service) => {
            if (!service || typeof service !== "object") return service;
            return remapNested(
              { ...service, id: maps.get("service")?.get(service.id) ?? service.id },
              maps,
            );
          }),
        ];
      return [key, remapNested(child, maps)];
    }),
  );
}

export interface ProjectImportPlan {
  preview: ImportPreview;
  dump: DatabaseDump;
  maps: Map<string, Map<string, string>>;
  updateTables: string[];
  selectedSourceIds: Map<string, Set<string>>;
  retargetedProjects: Set<string>;
  retargetedDeployments: Set<string>;
}

/** Read-only preflight, run again inside the restore transaction at apply time. */
export async function planProjectImport(
  file: DataTransferFile,
  selection: ImportSelection,
  context: ImportContext,
  reader: Reader = db,
  cloud?: Awaited<ReturnType<typeof getCloudConnectionStatusForOrg>>,
): Promise<ProjectImportPlan> {
  validateImportSelection(selection);
  const allProjects = file.dump.tables.project ?? [];
  const requested = selection.projectIds ?? allProjects.map((row) => String(row.id));
  if (!requested.length)
    throw new ProjectImportError("This file has no selected projects to import.");
  if (requested.some((id) => !allProjects.some((row) => row.id === id)))
    throw new ProjectImportError("A selected project is not present in this file.");
  if (
    Object.keys(selection.projectActions ?? {}).some(
      (id) => !allProjects.some((row) => row.id === id),
    )
  )
    throw new ProjectImportError(
      "A project override refers to a project that is not in this file.",
    );
  const requestedGroups = new Set(
    allProjects.filter((row) => requested.includes(String(row.id))).map((row) => row.groupId),
  );
  const destinationProjects = await reader.select().from(schema.project);
  const destinationGroups = await reader.select().from(schema.projectGroup);
  const destinationServers = (await reader.select().from(schema.servers)).filter(
    (server) => server.organizationId === context.organizationId || server.organizationId === null,
  );
  const availableServers = destinationServers.map((server) => transferServer(server));
  const maps = new Map<string, Map<string, string>>();
  const mapId = (table: string, source: string, target: string) => {
    const map = maps.get(table) ?? new Map();
    map.set(source, target);
    maps.set(table, map);
  };
  const blockers: string[] = [];
  const warnings = [...(file.manifest?.warnings ?? [])];
  for (const project of allProjects)
    mapId("organization", String(project.organizationId), context.organizationId);

  for (const group of file.dump.tables.project_app ?? []) {
    const matches = destinationGroups.filter(
      (row) =>
        row.id === group.id ||
        (row.organizationId === context.organizationId &&
          row.slug === group.slug &&
          !row.deletedAt),
    );
    if (requestedGroups.has(group.id) && matches.length > 1)
      blockers.push(
        `Multiple destination projects use the group slug ${String(group.slug)}. Resolve the duplicate before importing.`,
      );
    const match = matches[0];
    if (requestedGroups.has(group.id) && match && match.organizationId !== context.organizationId)
      blockers.push(
        `Project group ${String(group.name)} belongs to a different destination workspace.`,
      );
    mapId("project_app", String(group.id), match?.id ?? String(group.id));
  }
  const previewProjects: ImportPreview["projects"] = allProjects.map((project) => {
    const groupId = maps.get("project_app")?.get(String(project.groupId));
    const matches = destinationProjects.filter(
      (row) =>
        row.id === project.id ||
        (row.organizationId === context.organizationId &&
          !row.deletedAt &&
          ((row.groupId === groupId && row.environmentSlug === project.environmentSlug) ||
            (!!project.cloudWorkspaceId && row.cloudWorkspaceId === project.cloudWorkspaceId))),
    );
    const match = matches[0];
    const selected = requested.includes(String(project.id));
    const action = !selected
      ? "skip"
      : (selection.projectActions?.[String(project.id)] ??
        (match ? (selection.conflictPolicy ?? "skip") : "create"));
    if (selected && matches.length > 1)
      blockers.push(`Project ${String(project.name)} matches more than one destination project.`);
    if (
      selected &&
      match?.organizationId !== undefined &&
      match.organizationId !== context.organizationId
    ) {
      blockers.push(
        `Project ${String(project.name)} already belongs to a different destination workspace.`,
      );
    }
    mapId("project", String(project.id), match?.id ?? String(project.id));
    return {
      ...transferProject(project),
      existingProjectId: match?.id,
      action: action === "overwrite" && !match ? "create" : action,
    };
  });
  const activeIds = previewProjects.filter((row) => row.action !== "skip").map((row) => row.id);
  const { selection: exportSelection, excludedTables } = resolveExportSelection({
    scope: "projects",
    projectIds: activeIds.length ? activeIds : requested,
    history: selection.history ??
      file.selection?.history ?? ["analytics", "activity", "backups", "incidents", "migrations"],
    includeEnvironments: false,
    includeLinkedProjects: false,
    includeServers: true,
    includeDomains: selection.includeDomains,
    includeBackups: selection.includeBackups,
    includeIntegrations: selection.includeIntegrations,
  });
  let graph: Awaited<ReturnType<typeof selectProjectTransfer>>;
  try {
    graph = activeIds.length
      ? await selectProjectTransfer(
          snapshotTransferReader(file.dump.tables),
          exportSelection,
          excludedTables,
        )
      : { tables: {}, serverIds: [], warnings: [] };
    assertActiveDeploymentOwnership(graph.tables);
  } catch (error) {
    throw new ProjectImportError(
      error instanceof Error ? error.message : "The selected project snapshot is incomplete.",
    );
  }
  warnings.push(...graph.warnings);

  // A selected consumer can retain a link to an app already on the destination.
  for (const link of file.dump.tables.project_connection ?? []) {
    if (
      !activeIds.includes(String(link.targetProjectId)) ||
      activeIds.includes(String(link.sourceProjectId))
    )
      continue;
    const targetSourceId =
      maps.get("project")?.get(String(link.sourceProjectId)) ?? String(link.sourceProjectId);
    const existing = destinationProjects.find(
      (row) =>
        row.id === targetSourceId &&
        row.organizationId === context.organizationId &&
        !row.deletedAt,
    );
    if (existing) (graph.tables.project_connection ??= []).push(structuredClone(link));
    else
      blockers.push(
        `A selected project requires linked app ${String(link.sourceProjectId)}. Include that app in the import selection.`,
      );
  }
  for (const project of graph.tables.project ?? []) {
    const refs = linkedProjectIds(project.objectStorage).concat(
      linkedProjectIds(project.compositeRoutes),
    );
    for (const sourceId of refs) {
      if (activeIds.includes(sourceId)) continue;
      const id = maps.get("project")?.get(sourceId) ?? sourceId;
      if (
        !destinationProjects.some(
          (row) => row.id === id && row.organizationId === context.organizationId && !row.deletedAt,
        )
      ) {
        blockers.push(
          `${String(project.name)} requires linked project ${sourceId}. Include it in the export and import selection.`,
        );
      }
    }
  }

  const sourceServers = new Map(
    (file.manifest?.servers ?? []).map((server) => [server.id, server]),
  );
  for (const row of file.dump.tables.servers ?? []) {
    if (!sourceServers.has(String(row.id))) sourceServers.set(String(row.id), transferServer(row));
  }
  const neededServerIds = new Set(graph.serverIds);
  if ((graph.tables.project ?? []).some((row) => !row.serverId && !row.cloudWorkspaceId))
    neededServerIds.add("local");
  if (
    (graph.tables.deployment ?? []).some(
      (row) => (row.meta as Row | null)?.deployTarget === "local",
    )
  )
    neededServerIds.add("local");
  const servers: ImportPreview["servers"] = [];
  const retargetedServerIds = new Set<string>();
  for (const id of neededServerIds) {
    const source = sourceServers.get(id) ?? {
      id,
      name: id === "local" ? "Source control-plane host" : id,
      host: "",
      port: 22,
      isLocal: id === "local",
      included: false,
      hasCredentials: false,
    };
    const mappedId = selection.serverMappings?.[id];
    const matches = availableServers.filter((target) =>
      mappedId ? target.id === mappedId : sameServer(source, target),
    );
    const exact = matches.find((target) => target.id === id);
    const target = exact ?? (matches.length === 1 ? matches[0] : undefined);
    const row = (file.dump.tables.servers ?? []).find((row) => row.id === id);
    if (mappedId && !target)
      blockers.push(
        `The selected destination server for ${source.name} is unavailable in this workspace.`,
      );
    if (
      !target &&
      (needsExplicitServerMapping(source) || !row || !source.host || matches.length > 1 || mappedId)
    ) {
      blockers.push(`Choose an existing destination server for ${source.name}.`);
      servers.push({ ...source, action: "map" });
      continue;
    }
    if (target) {
      mapId("servers", id, target.id);
      servers.push({ ...source, targetId: target.id, action: "reuse" });
      if (!sameServer(source, target)) retargetedServerIds.add(id);
    } else {
      const collision = await reader
        .select()
        .from(schema.servers)
        .where(inArray(schema.servers.id, [id]));
      if (collision.length)
        blockers.push(
          `Server ${source.name} has an id conflict. Map it to the correct destination server.`,
        );
      mapId("servers", id, id);
      servers.push({ ...source, targetId: id, action: "create" });
      if (!source.hasCredentials || !file.secrets || selection.includeSecrets === false)
        warnings.push(
          `Add or verify SSH credentials for ${source.name} before using it on this control plane.`,
        );
    }
  }

  // A proof belongs to a specific routing host. Reusing it for another host
  // would falsely retain that host's verification and challenge credentials.
  graph.tables.edge_target_verification = (graph.tables.edge_target_verification ?? []).filter(
    (row) => !retargetedServerIds.has(typeof row.serverId === "string" ? row.serverId : "local"),
  );

  const cloudProjects = (graph.tables.project ?? []).filter((row) => row.cloudWorkspaceId);
  if (cloudProjects.length) {
    const connection = cloud ?? (await getCloudConnectionStatusForOrg(context.organizationId));
    const expected = new Set(
      cloudProjects
        .map((project) =>
          file.manifest?.cloudAccounts
            .find((account) => account.organizationId === project.organizationId)
            ?.email?.toLowerCase(),
        )
        .filter(Boolean),
    );
    if (!connection.connected || !connection.user?.email)
      blockers.push(
        "Connect this destination workspace to the source Openship Cloud account before importing cloud projects. Cloud servers will not work with a different account.",
      );
    else if ([...expected].some((email) => email !== connection.user!.email.toLowerCase()))
      blockers.push(
        `Cloud account mismatch. Connect this workspace to ${[...expected].join(", ")} before importing these cloud projects.`,
      );
    else if (expected.size === 0)
      warnings.push(
        "The source cloud identity is unavailable in this archive. Verify that the connected account owns these cloud workspaces.",
      );
  }
  if (!file.secrets || selection.includeSecrets === false)
    warnings.push(
      "Environment values and credentials will not be restored. Existing destination secrets are kept when overwriting; add missing values before deploying new projects.",
    );
  if (selection.overwriteDependencies)
    warnings.push(
      "Matching shared integration and backup settings will be overwritten. Other projects using those settings will see the changes.",
    );

  const selectedSourceIds = new Map<string, Set<string>>();
  const restored: DatabaseDump["tables"] = {};
  const updateTables = new Set<string>();
  const backupDestinationsToVerify = new Set<string>();
  const installationIds = new Map<number, number>();
  const parentIds: Record<string, string[]> = {
    project: [...maps.get("project")!.values()],
    servers: [...(maps.get("servers")?.values() ?? [])],
  };
  for (const spec of topoOrderedTables()) {
    const name = spec.sqlName;
    const sourceRows = graph.tables[name] ?? [];
    if (!sourceRows.length) continue;
    const incoming = sourceRows.map((source) => {
      const row = structuredClone(source);
      // Some legacy catalogue entries (servers, git_installation) did not mark
      // hasOrganizationId; actual row columns are authoritative here.
      if ("organizationId" in row) row.organizationId = context.organizationId;
      for (const ref of transferReferences.filter((ref) => ref.table === name)) {
        if (row[ref.column] == null) continue;
        if (ref.parent === "organization") row[ref.column] = context.organizationId;
        else if (ref.parent === "user") row[ref.column] = ref.nullable ? null : context.userId;
        else
          row[ref.column] = maps.get(ref.parent)?.get(String(row[ref.column])) ?? row[ref.column];
      }
      row.id = maps.get(name)?.get(String(source.id)) ?? source.id;
      if (name === "servers") {
        row.isLocal = false;
        row.sshKeyPath = null;
      }
      if (name === "project") {
        row.deletionInProgress = false;
        if (!source.serverId && !source.cloudWorkspaceId)
          row.serverId = maps.get("servers")?.get("local") ?? null;
      }
      return row;
    });
    const existing = await existingRows(reader, name, incoming, context.organizationId, parentIds);
    const admitted: Row[] = [];
    for (let i = 0; i < incoming.length; i++) {
      const row = incoming[i]!;
      const source = sourceRows[i]!;
      // Several source hosts may deliberately converge on one existing target.
      // Their connections are never written; all child references already use
      // the explicit server map, so this is not a duplicate-record conflict.
      if (
        name === "servers" &&
        servers.some((server) => server.id === source.id && server.action === "reuse")
      )
        continue;
      if (matchRows(name, row, admitted).length) {
        blockers.push(
          `The selection maps multiple ${name} records to the same destination identity. Import these projects separately or exclude that shared configuration.`,
        );
        continue;
      }
      admitted.push(row);
      const matches = matchRows(name, row, existing);
      const match = matches[0];
      if (name === "git_source") {
        row.isDefault =
          match?.isDefault ??
          (row.isDefault === true &&
            !existing
              .concat(admitted.filter((other) => other !== row))
              .some((other) => other.provider === row.provider && other.isDefault === true));
      }
      if (name === "git_installation" && typeof source.installationId === "number") {
        installationIds.set(
          source.installationId,
          Number(
            match && !selection.overwriteDependencies
              ? match.installationId
              : source.installationId,
          ),
        );
      }
      if (matches.length > 1)
        blockers.push(`Multiple destination records match ${name} ${String(row.name ?? row.id)}.`);
      if (
        match &&
        typeof match.organizationId === "string" &&
        match.organizationId !== context.organizationId
      ) {
        blockers.push(`A matching ${name} record belongs to another workspace.`);
        continue;
      }
      if (match && name === "domain" && match.projectId !== row.projectId) {
        blockers.push(
          `Domain ${String(row.hostname)} already belongs to another project. Exclude domains or resolve that conflict before importing.`,
        );
        continue;
      }
      if (
        match &&
        name !== "project" &&
        typeof match.projectId === "string" &&
        match.projectId !== row.projectId
      ) {
        blockers.push(`A matching ${name} record belongs to a different project.`);
        continue;
      }
      const targetId = String(match?.id ?? row.id);
      mapId(name, String(source.id), targetId);
      row.id = targetId;
      (parentIds[name] ??= []).push(targetId);
      // Reusing servers means keeping the destination's connection settings and
      // keys; a project import must not replace the operator's working SSH config.
      const mayUpdate =
        name !== "servers" &&
        name !== "project_app" &&
        (projectOwned.has(name) || selection.overwriteDependencies);
      if (match && !mayUpdate) continue;
      if (
        name === "backup_destination" &&
        (source.kind === "local" ||
          (source.kind === "sftp" && isLoopbackHost(String(source.sshHost ?? ""))) ||
          retargetedServerIds.has(String(source.serverId)))
      ) {
        backupDestinationsToVerify.add(targetId);
        row.lastVerifiedAt = null;
        row.lastVerifyError = "Verify the backup location after importing onto this control plane.";
        warnings.push(
          `Verify backup destination ${String(row.name)} and reconnect or copy its stored files before re-enabling its imported backup policies.`,
        );
      }
      (restored[name] ??= []).push(row);
      const selected = selectedSourceIds.get(name) ?? new Set();
      selected.add(String(source.id));
      selectedSourceIds.set(name, selected);
      if (match && mayUpdate) updateTables.add(name);
    }
  }

  // Finish soft/nested references after all table identities have been resolved.
  const retargetedProjects = new Set<string>();
  for (const project of graph.tables.project ?? []) {
    const serverId = typeof project.serverId === "string" ? project.serverId : "local";
    if (!project.cloudWorkspaceId && retargetedServerIds.has(serverId)) {
      retargetedProjects.add(maps.get("project")?.get(String(project.id)) ?? String(project.id));
    }
  }
  const retargetedDeployments = new Set<string>();
  for (const deployment of graph.tables.deployment ?? []) {
    const meta = deployment.meta as Row | null;
    const sourceServerId =
      typeof meta?.serverId === "string"
        ? meta.serverId
        : meta?.deployTarget === "local"
          ? "local"
          : undefined;
    const projectId =
      maps.get("project")?.get(String(deployment.projectId)) ?? String(deployment.projectId);
    if (
      retargetedProjects.has(projectId) ||
      (sourceServerId && retargetedServerIds.has(sourceServerId))
    ) {
      retargetedDeployments.add(
        maps.get("deployment")?.get(String(deployment.id)) ?? String(deployment.id),
      );
    }
  }
  for (const project of restored.project ?? []) {
    const activeId =
      maps.get("deployment")?.get(String(project.activeDeploymentId)) ??
      String(project.activeDeploymentId);
    if (retargetedDeployments.has(activeId)) retargetedProjects.add(String(project.id));
  }
  for (const [name, rows] of Object.entries(restored)) {
    restored[name] = rows.map((row) => {
      const next = { ...row };
      // A transferred hook must be explicitly delegated by a user in this
      // installation. Imported JSON must never forge an execution identity.
      if (name === "incoming_webhook") next.executionAuthority = null;
      for (const [key, value] of Object.entries(next)) {
        if (typeof value === "string" && SOFT_REFS[key])
          next[key] = maps.get(SOFT_REFS[key]!)?.get(value) ?? value;
      }
      // Only metadata with typed resource references is rewritten. Environment
      // variables, build arguments and mounted files are opaque user content.
      const metadataColumns: Record<string, string[]> = {
        project: ["objectStorage", "compositeRoutes", "releaseSource"],
        deployment: ["meta"],
        incoming_webhook: ["actionConfig"],
        backup_restore: ["meta"],
        docker_migration_run: ["inputSnapshot"],
      };
      for (const key of metadataColumns[name] ?? []) {
        if (key in next) next[key] = remapNested(next[key], maps);
      }
      if (
        (name === "project" || name === "project_app") &&
        typeof next.installationId === "number"
      ) {
        next.installationId = installationIds.get(next.installationId) ?? next.installationId;
      }
      if (name === "project" && retargetedProjects.has(String(next.id))) {
        next.activeDeploymentId = null;
        next.autoDeploy = false;
        next.disabledAt = new Date().toISOString();
      }
      if (
        name === "backup_policy" &&
        (retargetedProjects.has(String(next.projectId)) ||
          backupDestinationsToVerify.has(String(next.destinationId)))
      )
        next.enabled = false;
      if (
        (name === "deployment" && retargetedDeployments.has(String(next.id))) ||
        (name === "service_deployment" && retargetedDeployments.has(String(next.deploymentId)))
      ) {
        next.containerId = null;
        if (name === "deployment") {
          next.meta = null;
          next.status = "cancelled";
        } else {
          next.hostPorts = null;
          next.status = "stopped";
        }
      }
      if (name === "domain" && retargetedProjects.has(String(next.projectId))) {
        next.status = "pending";
        next.verified = false;
        next.verifiedAt = null;
        next.sslStatus = "none";
        next.sslExpiresAt = null;
      }
      return next;
    });
  }
  if (retargetedProjects.size)
    warnings.push(
      "Projects mapped to a different host are imported disabled, with live container bindings cleared. Migrate or restore their volumes, then deploy and verify domains before enabling them.",
    );
  const preview: ImportPreview = {
    scope: "projects",
    projects: previewProjects,
    servers,
    availableServers,
    history: summarizeExportCounts(
      Object.fromEntries(Object.entries(graph.tables).map(([name, rows]) => [name, rows.length])),
    ).history,
    rows: Object.values(restored).reduce((sum, rows) => sum + rows.length, 0),
    hasSecrets: !!file.secrets,
    warnings: [...new Set(warnings)],
    blockers: [...new Set(blockers)],
  };
  return {
    preview,
    dump: { ...file.dump, scope: { kind: "instance" }, tables: restored },
    maps,
    updateTables: [...updateTables],
    selectedSourceIds,
    retargetedProjects,
    retargetedDeployments,
  };
}

export function remapProjectSecrets(
  bundle: SecretBundle | null,
  plan: ProjectImportPlan,
): SecretBundle | null {
  if (!bundle) return null;
  return {
    version: 1,
    entries: bundle.entries
      .filter(
        (entry) =>
          plan.selectedSourceIds.get(entry.table)?.has(entry.id) &&
          !(
            entry.table === "deployment" &&
            entry.column === "meta" &&
            plan.retargetedDeployments.has(plan.maps.get("deployment")?.get(entry.id) ?? entry.id)
          ),
      )
      .map((entry) => ({
        ...entry,
        id: plan.maps.get(entry.table)?.get(entry.id) ?? entry.id,
        ...(entry.scheme === "json" && entry.table === "deployment" && entry.column === "meta"
          ? { json: remapNested(entry.json, plan.maps) }
          : {}),
      })),
  };
}
