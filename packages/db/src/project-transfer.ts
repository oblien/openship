import { getTableColumns, inArray, sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import type { ExportSelection, TransferProject } from "@repo/core";
import { db, getDriver, type DatabaseTransaction } from "./client";
import { DUMP_FORMAT_VERSION, topoOrderedTables, type DatabaseDump } from "./dump";

type Row = Record<string, unknown>;
export type TransferRowReader = (
  table: string,
  column: string,
  values: readonly unknown[],
) => Promise<Row[]>;

/** A separate catalogue from tenant/cloud promotion: this path is instance-admin only. */
export const PROJECT_TRANSFER_TABLES = new Set([
  "project_app",
  "project",
  "cloud_docker_workspace",
  "env_var",
  "deployment",
  "domain",
  "service",
  "service_deployment",
  "incoming_webhook",
  "route_rule",
  "project_connection",
  "backup_destination",
  "backup_policy",
  "backup_run",
  "backup_restore",
  "credential",
  "dns_credential",
  "git_source",
  "git_installation",
  "server_github_auth",
  "github_deploy_key",
  "servers",
  "cloud_webhook_binding",
  "custom_app_template",
  "service_incident",
  "docker_migration_run",
  "resource_usage",
  "server_analytics",
  "server_analytics_geo",
  "audit_event",
  "edge_target_verification",
]);

const specs = new Map(topoOrderedTables().map((spec) => [spec.sqlName, spec]));

/** Unconditional unique keys; partial/expression indexes need domain-specific matching. */
export function transferUniqueKeys(name: string): string[][] {
  const spec = specs.get(name);
  if (!spec) return [];
  const columns = getTableColumns(spec.table);
  const config = getTableConfig(spec.table);
  const keyFor = (column: { name: string }) =>
    Object.keys(columns).find((key) => columns[key]!.name === column.name);
  const keys: string[][] = Object.entries(columns)
    .filter(([, column]) => column.isUnique)
    .map(([key]) => [key]);
  for (const constraint of config.uniqueConstraints)
    keys.push(constraint.columns.map((column) => keyFor(column)!));
  for (const index of config.indexes) {
    if (!index.config.unique || index.config.where) continue;
    const fields = index.config.columns.map((column) =>
      "name" in column && typeof column.name === "string"
        ? keyFor({ name: column.name })
        : undefined,
    );
    if (fields.every((key): key is string => !!key)) keys.push(fields);
  }
  return keys;
}

export const transferReferences = topoOrderedTables().flatMap((spec) => {
  const columns = getTableColumns(spec.table);
  return getTableConfig(spec.table).foreignKeys.flatMap((fk) => {
    const ref = fk.reference();
    const parent = getTableConfig(ref.foreignTable).name;
    const parentColumns = getTableColumns(ref.foreignTable);
    return ref.columns.map((column, i) => ({
      table: spec.sqlName,
      column: Object.keys(columns).find((key) => columns[key] === column)!,
      parent,
      parentColumn: Object.keys(parentColumns).find(
        (key) => parentColumns[key] === ref.foreignColumns[i],
      )!,
      nullable: !column.notNull,
    }));
  });
});

/** Bounded parameter batches, shared by project exports and import preflight. */
function transferReader(
  reader: Pick<DatabaseTransaction, "select">,
  metadataOnly = false,
): TransferRowReader {
  return async (name, key, values) => {
    const spec = specs.get(name);
    const columns = spec && getTableColumns(spec.table);
    const column = columns?.[key];
    if (!spec || !column || values.length === 0) return [];
    const fields = new Set([
      "id",
      "organizationId",
      "name",
      "slug",
      "environmentName",
      "groupId",
      "deletedAt",
      "cloudWorkspaceId",
      "localPath",
      "gitOwner",
      "gitRepo",
      "appTemplateId",
      "appId",
      "installationId",
      "owner",
      "repo",
      "objectStorage",
      "compositeRoutes",
      "domain",
      "hostname",
      "resourceId",
      "kind",
      "sshHost",
      ...transferReferences.filter((ref) => ref.table === name).map((ref) => ref.column),
    ]);
    const projection = metadataOnly
      ? {
          ...Object.fromEntries(Object.entries(columns!).filter(([key]) => fields.has(key))),
          ...(name === "deployment"
            ? {
                meta: sql`jsonb_build_object('serverId', ${columns!.meta} -> 'serverId', 'deployTarget', ${columns!.meta} -> 'deployTarget')`,
              }
            : {}),
        }
      : undefined;
    const rows: Row[] = [];
    const unique = [...new Set(values)].filter((value) => value !== null && value !== undefined);
    for (let i = 0; i < unique.length; i += 5_000) {
      const query = projection
        ? reader.select(projection).from(spec.table)
        : reader.select().from(spec.table);
      rows.push(...((await query.where(inArray(column, unique.slice(i, i + 5_000)))) as Row[]));
    }
    return rows;
  };
}
export const readTransferRows: TransferRowReader = transferReader(db);

export function transferProject(row: Row): TransferProject {
  return {
    id: String(row.id),
    groupId: String(row.groupId),
    organizationId: String(row.organizationId),
    name: String(row.name ?? row.slug ?? row.id),
    slug: String(row.slug ?? row.id),
    environmentName: String(row.environmentName ?? "Production"),
    serverId: typeof row.serverId === "string" ? row.serverId : null,
    cloudWorkspaceId: typeof row.cloudWorkspaceId === "string" ? row.cloudWorkspaceId : null,
    localPath: typeof row.localPath === "string" ? row.localPath : null,
  };
}

function ids(rows: Row[], column = "id"): unknown[] {
  return rows.map((row) => row[column]).filter((value) => value !== null && value !== undefined);
}

/** Soft project references live in object-storage and composite-routing config. */
export function linkedProjectIds(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) =>
    (key === "sourceProjectId" || key === "projectId") && typeof child === "string"
      ? [child]
      : linkedProjectIds(child),
  );
}

/**
 * The same selector reads the live database OR an uploaded snapshot. Children
 * are selected through project ownership; shared parents are followed only
 * upwards, so exporting a server never brings its other projects with it.
 */
export async function selectProjectTransfer(
  read: TransferRowReader,
  selection: ExportSelection,
  excludeTables: readonly string[] = [],
): Promise<{ tables: DatabaseDump["tables"]; serverIds: string[]; warnings: string[] }> {
  const tables: DatabaseDump["tables"] = {};
  const warnings: string[] = [];
  const excluded = new Set(excludeTables);
  const collected = new Map<string, Set<unknown>>();
  const add = (table: string, rows: Row[]) => {
    if (excluded.has(table)) return;
    const seen = collected.get(table) ?? new Set();
    collected.set(table, seen);
    const target = (tables[table] ??= []);
    for (const row of rows) {
      // All portability tables have an id; never collapse malformed rows into one.
      if (row.id === undefined || seen.has(row.id)) continue;
      seen.add(row.id);
      target.push(structuredClone(row));
    }
  };
  const fetch = async (table: string, column: string, values: readonly unknown[]) => {
    if (excluded.has(table) || !values.length) return [];
    const rows = await read(table, column, values);
    add(table, rows);
    return rows;
  };

  const requested = [...new Set(selection.projectIds ?? [])];
  await fetch("project", "id", requested);
  if (requested.some((id) => !collected.get("project")?.has(id))) {
    throw new Error("One or more selected projects are missing from the source.");
  }
  if (!requested.length) throw new Error("Select at least one project.");

  let previousSize = -1;
  while (previousSize !== (tables.project?.length ?? 0)) {
    previousSize = tables.project!.length;
    if (selection.includeEnvironments !== false) {
      add(
        "project",
        (await read("project", "groupId", ids(tables.project!, "groupId"))).filter(
          (row) => !row.deletedAt,
        ),
      );
    }
    const links = await read("project_connection", "targetProjectId", ids(tables.project!));
    if (selection.includeLinkedProjects !== false) {
      const parents = [
        ...ids(links, "sourceProjectId"),
        ...tables.project!.flatMap((row) =>
          linkedProjectIds(row.objectStorage).concat(linkedProjectIds(row.compositeRoutes)),
        ),
      ];
      await fetch("project", "id", parents);
    }
  }
  const projectIds = ids(tables.project!);
  const projectSet = new Set(projectIds);
  const organizations = [...new Set(ids(tables.project!, "organizationId"))];
  await fetch("project_app", "id", ids(tables.project!, "groupId"));
  const links = await read("project_connection", "targetProjectId", projectIds);
  add(
    "project_connection",
    links.filter((row) => projectSet.has(row.sourceProjectId)),
  );
  if (links.some((row) => !projectSet.has(row.sourceProjectId))) {
    warnings.push(
      "Some linked apps are outside the selection. Their connection values travel with environment variables; reconnect those apps after import.",
    );
  }

  // Every direct project child, followed by children of the owned records.
  // Shared infra/auth parents are deliberately not descendant traversal roots.
  const ownedParents = new Set([
    "project",
    "deployment",
    "service",
    "domain",
    "backup_policy",
    "backup_run",
  ]);
  for (const spec of topoOrderedTables()) {
    if (
      !PROJECT_TRANSFER_TABLES.has(spec.sqlName) ||
      ["project", "project_app", "project_connection"].includes(spec.sqlName)
    )
      continue;
    for (const ref of transferReferences.filter(
      (ref) => ref.table === spec.sqlName && ownedParents.has(ref.parent),
    )) {
      const rows = await read(
        spec.sqlName,
        ref.column,
        ids(tables[ref.parent] ?? [], ref.parentColumn),
      );
      add(
        spec.sqlName,
        rows.filter((row) => row.projectId == null || projectSet.has(row.projectId)),
      );
    }
  }

  if (selection.includeIntegrations !== false) {
    const installations = await read(
      "git_installation",
      "installationId",
      ids(tables.project!, "installationId"),
    );
    add(
      "git_installation",
      installations.filter((row) => organizations.includes(row.organizationId)),
    );
    // These providers are resolved at deploy time by workspace + registry/zone,
    // without a project FK. Carry their shared configuration explicitly.
    await fetch("credential", "organizationId", organizations);
    if (selection.includeDomains !== false && tables.domain?.length) {
      await fetch("dns_credential", "organizationId", organizations);
    }
    if (tables.credential?.length || tables.dns_credential?.length) {
      warnings.push(
        "Shared registry and DNS credentials from the selected workspaces are included. They may also be used by other projects.",
      );
    }
    await fetch("cloud_webhook_binding", "cloudProjectId", projectIds);
  }
  const templates = await read(
    "custom_app_template",
    "appId",
    ids(tables.project!, "appTemplateId"),
  );
  add(
    "custom_app_template",
    templates.filter((row) => organizations.includes(row.organizationId)),
  );

  const hostnames = ids(tables.domain ?? [], "hostname");
  await fetch("server_analytics", "domain", hostnames);
  await fetch("server_analytics_geo", "domain", hostnames);
  await fetch("audit_event", "resourceId", [
    ...projectIds,
    ...ids(tables.service ?? []),
    ...ids(tables.deployment ?? []),
  ]);

  // FK closure upwards. Identity rows are remapped to the importing workspace
  // and user; they are never copied into a project archive.
  let size = -1;
  while (size !== Object.values(tables).reduce((n, rows) => n + rows.length, 0)) {
    size = Object.values(tables).reduce((n, rows) => n + rows.length, 0);
    for (const ref of transferReferences) {
      if (
        !PROJECT_TRANSFER_TABLES.has(ref.parent) ||
        ref.parent === "project" ||
        ref.parent === "service"
      )
        continue;
      if (ref.parent === "servers" && selection.includeServers === false) continue;
      await fetch(ref.parent, ref.parentColumn, ids(tables[ref.table] ?? [], ref.column));
    }
  }
  const snapshotServerIds = (tables.deployment ?? []).flatMap((row) => {
    const meta = row.meta as Record<string, unknown> | null;
    return meta && typeof meta.serverId === "string" ? [meta.serverId] : [];
  });
  if (selection.includeServers !== false) await fetch("servers", "id", snapshotServerIds);
  const serverIds = [
    ...new Set([
      ...transferReferences
        .filter((ref) => ref.parent === "servers")
        .flatMap((ref) => ids(tables[ref.table] ?? [], ref.column)),
      ...snapshotServerIds,
    ]),
  ].filter((id): id is string => typeof id === "string");
  if (selection.includeServers !== false) {
    await fetch("server_github_auth", "serverId", serverIds);
    const keys = await read("github_deploy_key", "serverId", serverIds);
    add(
      "github_deploy_key",
      keys.filter((key) =>
        tables.project!.some(
          (project) =>
            project.gitOwner === key.owner &&
            project.gitRepo === key.repo &&
            project.serverId === key.serverId,
        ),
      ),
    );
  }
  if (selection.includeDomains !== false) {
    const hasLocalProjects = tables.project!.some((row) => !row.serverId && !row.cloudWorkspaceId);
    const verifications = await read("edge_target_verification", "organizationId", organizations);
    add(
      "edge_target_verification",
      verifications.filter((row) =>
        typeof row.serverId === "string" ? serverIds.includes(row.serverId) : hasLocalProjects,
      ),
    );
  }

  // Histories can point at a fork/mail target that was not selected. Optional
  // references are detached; required references must be satisfied by the graph.
  for (const ref of transferReferences) {
    if (["organization", "user", "servers"].includes(ref.parent)) continue;
    const parents = new Set(ids(tables[ref.parent] ?? [], ref.parentColumn));
    for (const row of tables[ref.table] ?? []) {
      if (row[ref.column] == null || parents.has(row[ref.column])) continue;
      if (ref.nullable) row[ref.column] = null;
      else
        throw new Error(
          `The selection is missing a required ${ref.parent} record for ${ref.table}.`,
        );
    }
  }
  return { tables, serverIds, warnings };
}

export async function dumpProjectTransfer(
  selection: ExportSelection,
  excludeTables: readonly string[] = [],
  metadataOnly = false,
) {
  const graph = await db.transaction(async (rawTx) => {
    const tx = rawTx as DatabaseTransaction;
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    return selectProjectTransfer(transferReader(tx, metadataOnly), selection, excludeTables);
  });
  return {
    ...graph,
    dump: {
      formatVersion: DUMP_FORMAT_VERSION,
      exportedAt: new Date().toISOString(),
      sourceDriver: getDriver(),
      // The envelope owns the bulk scope. This deliberately cannot be restored
      // by the old cloud-promotion path, whose project catalogue excludes infra.
      scope: { kind: "project" as const, projectId: selection.projectIds![0]! },
      tables: graph.tables,
    },
  };
}

export function snapshotTransferReader(tables: DatabaseDump["tables"]): TransferRowReader {
  return async (table, column, values) => {
    const selected = new Set(values);
    return (tables[table] ?? []).filter((row) => selected.has(row[column]));
  };
}
