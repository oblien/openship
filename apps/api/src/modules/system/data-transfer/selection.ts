import type { ExportHistoryCategory, ExportPreview, ExportSelection } from "./types";

export const EXPORT_HISTORY_CATEGORIES = [
  "analytics",
  "activity",
  "backups",
  "incidents",
  "migrations",
] as const satisfies readonly ExportHistoryCategory[];

/** Optional, high-volume history. Configuration has separate selection controls. */
export const HISTORY_TABLES: Record<ExportHistoryCategory, readonly string[]> = {
  analytics: ["server_analytics", "server_analytics_geo", "resource_usage"],
  // Kept together because notification_delivery.auditEventId references audit_event.
  activity: ["audit_event", "notification_delivery"],
  // Kept together because backup_restore.runId references backup_run.
  backups: ["backup_run", "backup_restore"],
  incidents: ["service_incident"],
  migrations: ["docker_migration_run"],
};

export class InvalidExportSelectionError extends Error {
  readonly code = "INVALID_EXPORT_SELECTION" as const;
  constructor(message: string) {
    super(message);
    this.name = "InvalidExportSelectionError";
  }
}

export function summarizeExportCounts(tableCounts: Record<string, number>): ExportPreview {
  const history = Object.fromEntries(
    Object.entries(HISTORY_TABLES).map(([category, tables]) => [
      category,
      tables.reduce((sum, table) => sum + (tableCounts[table] ?? 0), 0),
    ]),
  ) as ExportPreview["history"];
  const historyTables = new Set(Object.values(HISTORY_TABLES).flat());
  const core = Object.entries(tableCounts).reduce(
    (sum, [table, rows]) => sum + (historyTables.has(table) ? 0 : rows),
    0,
  );
  return {
    core,
    history,
    total: core + Object.values(history).reduce((sum, rows) => sum + rows, 0),
  };
}

/** Missing selection preserves the legacy full-instance export. */
export function resolveExportSelection(selection?: ExportSelection): {
  selection: ExportSelection;
  excludedTables: string[];
} {
  if (
    selection !== undefined &&
    (!selection || typeof selection !== "object" || Array.isArray(selection))
  ) {
    throw new InvalidExportSelectionError("Export selection must be an object.");
  }
  const raw = selection?.history;
  if (raw !== undefined && !Array.isArray(raw)) {
    throw new InvalidExportSelectionError("Export history must be a list of categories.");
  }
  const requested = raw ?? [...EXPORT_HISTORY_CATEGORIES];
  const allowed = new Set<string>(EXPORT_HISTORY_CATEGORIES);
  for (const category of requested) {
    if (!allowed.has(category))
      throw new InvalidExportSelectionError(`Unknown export history category: ${category}`);
  }

  const history = [...new Set(requested)] as ExportHistoryCategory[];
  const included = new Set(history);
  const excludedTables = EXPORT_HISTORY_CATEGORIES.filter(
    (category) => !included.has(category),
  ).flatMap((category) => [...HISTORY_TABLES[category]]);

  if (
    selection?.scope !== undefined &&
    selection.scope !== "instance" &&
    selection.scope !== "projects"
  ) {
    throw new InvalidExportSelectionError("Choose an instance or project export.");
  }
  for (const key of [
    "includeEnvironments",
    "includeLinkedProjects",
    "includeServers",
    "includeSecrets",
    "includeDomains",
    "includeBackups",
    "includeIntegrations",
  ] as const) {
    if (selection?.[key] !== undefined && typeof selection[key] !== "boolean") {
      throw new InvalidExportSelectionError(`${key} must be a boolean.`);
    }
  }
  if (selection?.scope === "projects") {
    if (
      !Array.isArray(selection.projectIds) ||
      selection.projectIds.length === 0 ||
      selection.projectIds.length > 10_000 ||
      selection.projectIds.some((id) => typeof id !== "string" || !id.trim())
    ) {
      throw new InvalidExportSelectionError("Select at least one project to export.");
    }
  } else if (selection?.projectIds !== undefined) {
    throw new InvalidExportSelectionError("Project selection requires project scope.");
  }
  if (selection?.includeDomains === false)
    excludedTables.push("domain", "route_rule", "edge_target_verification");
  if (selection?.includeBackups === false)
    excludedTables.push("backup_policy", "backup_destination", "backup_run", "backup_restore");
  if (selection?.includeIntegrations === false)
    excludedTables.push(
      "git_source",
      "git_installation",
      "credential",
      "dns_credential",
      "cloud_webhook_binding",
    );
  return { selection: { ...selection, history }, excludedTables: [...new Set(excludedTables)] };
}
