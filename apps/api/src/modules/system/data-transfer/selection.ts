import type { ExportHistoryCategory, ExportPreview, ExportSelection } from "./types";

export const EXPORT_HISTORY_CATEGORIES = [
  "analytics",
  "activity",
  "backups",
  "incidents",
  "migrations",
] as const satisfies readonly ExportHistoryCategory[];

/** Optional, high-volume history. Durable configuration is always exported. */
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
  constructor(category: string) {
    super(`Unknown export history category: ${category}`);
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
  const raw = selection?.history;
  if (raw !== undefined && !Array.isArray(raw)) {
    throw new InvalidExportSelectionError(String(raw));
  }
  const requested = raw ?? [...EXPORT_HISTORY_CATEGORIES];
  const allowed = new Set<string>(EXPORT_HISTORY_CATEGORIES);
  for (const category of requested) {
    if (!allowed.has(category)) throw new InvalidExportSelectionError(String(category));
  }

  const history = [...new Set(requested)] as ExportHistoryCategory[];
  const included = new Set(history);
  const excludedTables = EXPORT_HISTORY_CATEGORIES
    .filter((category) => !included.has(category))
    .flatMap((category) => [...HISTORY_TABLES[category]]);

  return { selection: { history }, excludedTables };
}
