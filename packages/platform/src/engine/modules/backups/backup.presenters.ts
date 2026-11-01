import { PRESERVED_ARTIFACT_METADATA_KEYS } from "@repo/adapters";
import type { BackupRun, BackupRestore } from "@repo/db";
import { ENV_MASK } from "../../lib/secret-env";

/** Commands remain intact in storage for restore execution, but are not read-model secrets. */
export function presentBackupArtifacts(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(presentBackupArtifacts);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key, PRESERVED_ARTIFACT_METADATA_KEYS.has(key) ? ENV_MASK : presentBackupArtifacts(item),
  ]));
}
export function presentBackupRun(row: BackupRun) {
  return { ...row, artifacts: presentBackupArtifacts(row.artifacts) };
}
export function presentBackupRestore(row: BackupRestore) {
  // Preparation returns the in-force token only to an authorized restore caller.
  return { ...row, confirmationToken: null };
}
