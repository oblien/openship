import { isMaskedValue } from "@repo/core";
import type { EnvironmentVariable } from "@/components/import-project/types";
import {
  computeProjectEnvDiff,
  serializeNewProjectEnv,
  type PersistedProjectEnv,
  type ProjectEnvEditState,
  type ProjectEnvDiff,
} from "@/lib/project-env-diff";

function sourceEnvRows(env?: Record<string, string>): EnvironmentVariable[] {
  return Object.entries(env ?? {}).map(([key, value]) => ({
    key,
    value,
    visible: true,
    // Metadata-only scans can still contain masks. Preserve those sentinels so
    // deploy can recover values from its trusted source read.
    preserveValue: isMaskedValue(value) || undefined,
  }));
}

/**
 * Partition a prepare response's source env by ownership. Values explicitly
 * declared in openship.json are active deploy defaults; unrelated `.env` rows
 * stay behind the Import action. Existing operator rows always win by key.
 */
export function mergePreparedSourceEnv(
  current: EnvironmentVariable[],
  rootEnv?: Record<string, string>,
  openshipEnvKeys: string[] = [],
): { envVars: EnvironmentVariable[]; rootEnvVars: EnvironmentVariable[] } {
  const rows = sourceEnvRows(rootEnv);
  const declaredKeys = new Set(openshipEnvKeys);
  const declared = rows.filter((row) => declaredKeys.has(row.key));
  const owned = new Set(current.map((row) => row.key).filter(Boolean));

  return {
    envVars: [...current, ...declared.filter((row) => row.key && !owned.has(row.key))],
    rootEnvVars: rows.filter((row) => !declaredKeys.has(row.key)),
  };
}

export type DeploymentEnvPersistencePlan =
  | { ok: false; error: string }
  | {
      ok: true;
      /** Existing projects apply this partial merge before save/deploy. */
      merge: ProjectEnvDiff | null;
      /** Only a new project sends env through build/access. */
      buildAccessEnvVars: Record<string, string> | undefined;
      /** Masked source rows explicitly selected for server-side import. */
      sourceEnvKeys?: string[];
    };

function selectedSourceEnvKeys(
  rows: readonly EnvironmentVariable[],
  baseline: readonly PersistedProjectEnv[],
): string[] {
  const baselineKeys = new Set(baseline.map((row) => row.key));
  const selected = new Set<string>();

  for (const row of rows) {
    const key = row.key.trim();
    const tracksSavedValue = row.originalKey !== undefined && baselineKeys.has(row.originalKey);
    if (key && !tracksSavedValue && (row.preserveValue || isMaskedValue(row.value))) {
      selected.add(key);
    }
  }

  return [...selected];
}

/**
 * Decide which persistence path owns deployment-wizard env changes.
 *
 * A new project has no env store yet, so build/access receives its values and
 * persists them. An existing project is patched through the same partial merge
 * contract as the dedicated env editor, then build/access reads that store.
 * Requiring a loaded baseline for existing projects prevents a failed env read
 * from being mistaken for an empty environment and deleting data.
 */
export function planDeploymentEnvPersistence({
  projectId,
  envVars,
  baseline,
}: {
  projectId?: string;
  envVars: readonly EnvironmentVariable[];
  baseline: readonly PersistedProjectEnv[] | null;
}): DeploymentEnvPersistencePlan {
  if (!projectId) {
    const serialized = serializeNewProjectEnv(envVars);
    return serialized.ok
      ? { ok: true, merge: null, buildAccessEnvVars: serialized.envVars }
      : serialized;
  }

  if (baseline === null) {
    return {
      ok: false,
      error: "Project environment was not loaded. Reload the page and try again.",
    };
  }

  const result = computeProjectEnvDiff(envVars, baseline, {
    // openship.json values are owned and resolved by the server-side source
    // scan. They intentionally have no originalKey/project-env baseline row.
    ignoreUntrackedPreserved: true,
  });
  if (!result.ok) return result;

  const sourceEnvKeys = selectedSourceEnvKeys(envVars, baseline);
  return {
    ok: true,
    merge: result.diff,
    buildAccessEnvVars: undefined,
    ...(sourceEnvKeys.length > 0 ? { sourceEnvKeys } : {}),
  };
}

/**
 * `projects/ensure` can resolve a nominally new wizard to an existing project
 * (for example, when the same repository/branch is opened from the library).
 * Those wizard rows were never loaded from that project's env store, so their
 * absence cannot mean "delete". Adopt matching keys, retain every unseen saved
 * row, and then use the ordinary diff engine. This keeps the merge semantics in
 * one place while preventing ensure's name-based de-duplication from turning a
 * first-deploy payload into a destructive replacement.
 */
export function planMatchedExistingProjectEnvPersistence({
  envVars,
  persisted,
}: {
  envVars: readonly EnvironmentVariable[];
  persisted: ProjectEnvEditState;
}): DeploymentEnvPersistencePlan {
  const baselineByKey = new Map(persisted.baseline.map((row) => [row.key, row]));
  const submittedKeys = new Set<string>();

  const adoptedRows = envVars.map((row) => {
    const key = row.key.trim();
    if (key) submittedKeys.add(key);
    const original = baselineByKey.get(key);

    return {
      ...row,
      // Do not trust an originalKey carried by stale wizard state. The env
      // snapshot fetched for the project ensure actually returned is the only
      // baseline this merge is allowed to address.
      originalKey: original?.key,
      isSecret: row.isSecret ?? original?.isSecret,
    };
  });

  const retainedRows = persisted.rows.filter((row) => !submittedKeys.has(row.key));
  const reconciledRows = [...adoptedRows, ...retainedRows];
  const result = computeProjectEnvDiff(reconciledRows, persisted.baseline, {
    ignoreUntrackedPreserved: true,
  });
  if (!result.ok) return result;

  const sourceEnvKeys = selectedSourceEnvKeys(reconciledRows, persisted.baseline);
  return {
    ok: true,
    merge: result.diff,
    buildAccessEnvVars: undefined,
    ...(sourceEnvKeys.length > 0 ? { sourceEnvKeys } : {}),
  };
}
