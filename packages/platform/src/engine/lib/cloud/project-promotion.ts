import { createHash } from "node:crypto";
import { sortJsonKeys } from "@repo/core";
import type { DatabaseDump, Project } from "@repo/db";

export type ProjectPromotion = NonNullable<Project["cloudPromotion"]>;

export function isProjectPromotion(value: unknown): value is ProjectPromotion {
  if (!value || typeof value !== "object") return false;
  const state = value as ProjectPromotion;
  return (
    typeof state.id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(state.id) &&
    typeof state.target?.apiUrl === "string" &&
    !!state.target.apiUrl &&
    typeof state.target.userId === "string" &&
    !!state.target.userId &&
    typeof state.target.organizationId === "string" &&
    !!state.target.organizationId &&
    typeof state.sourceDigest === "string" &&
    /^[0-9a-f]{64}$/.test(state.sourceDigest) &&
    (state.cleanupInProgress === undefined || typeof state.cleanupInProgress === "boolean") &&
    (state.imported === null ||
      (typeof state.imported === "object" &&
        !Array.isArray(state.imported) &&
        state.imported.project === 1 &&
        Object.values(state.imported).every((count) => Number.isSafeInteger(count) && count >= 0)))
  );
}

// A restart under another locale must not change the transfer checksum.
function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Include encrypted configuration in the local checksum without exporting it.
 * Export timestamps, query row order and the journal itself are not source edits. */
export function projectPromotionDigest(dump: DatabaseDump): string {
  const tables = JSON.parse(JSON.stringify(dump.tables)) as DatabaseDump["tables"];
  // Monitoring can append samples while an otherwise unchanged project moves.
  delete tables.resource_usage;
  for (const row of tables.project ?? []) {
    delete row.cloudPromotion;
    // A failed teardown clears its admission flag and touches this timestamp.
    // Neither changes the project's configuration or the imported source.
    delete row.deletionInProgress;
    delete row.lifecycleOperation;
    delete row.updatedAt;
    delete row.favicon;
    delete row.faviconCheckedAt;
  }
  for (const [name, rows] of Object.entries(tables)) {
    tables[name] = rows
      .map((row) => sortJsonKeys(row) as Record<string, unknown>)
      .sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)));
  }
  return createHash("sha256")
    .update(JSON.stringify(sortJsonKeys({ scope: dump.scope, tables })))
    .digest("hex");
}
