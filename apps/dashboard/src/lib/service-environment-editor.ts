import { ENV_MASK, looksLikeSecretKey } from "@repo/core";
import type { MergeServiceEnvVarsInput, ServiceEnvironment } from "@repo/contracts";
import type { EnvironmentVariableRow } from "@/components/import-project/EnvironmentVariables";
import type { Dictionary } from "@/i18n";

type Labels = Dictionary["projectDetail"]["services"]["detail"]["environmentState"];

export type ServiceEnvironmentDraft = {
  environment: ServiceEnvironment["environment"];
  /** Server-derived runtime defaults, never inferred by the browser. */
  generated?: Record<string, string>;
  baseline: EnvironmentVariableRow[];
  rows: EnvironmentVariableRow[];
};

export function serviceEnvironmentRows(
  value: ServiceEnvironment,
  labels: Labels,
): EnvironmentVariableRow[] {
  return value.variables.map((row) => ({
    key: row.key,
    value: row.value,
    isSecret: row.isSecret,
    visible: !row.isSecret,
    sourceId: row.sourceId,
    originLabel: labels.sources[row.source],
    keyReadOnly: row.source !== "service",
    removalDisabled: row.source !== "service",
    removalLabel: row.source === "service" ? labels.removeOverride : labels.removeAtSource,
  }));
}

export const comparableServiceEnvironment = (rows: EnvironmentVariableRow[]) =>
  rows
    .filter((row) => row.key.trim())
    .map((row) => ({
      key: row.key.trim(),
      value: row.preserveValue ? ENV_MASK : row.value,
      isSecret: row.isSecret ?? looksLikeSecretKey(row.key),
      sourceId: row.sourceId ?? null,
    }))
    .sort((a, b) => a.key.localeCompare(b.key));

/** Effective rows are a view; only deliberately changed overrides are written. */
export function serviceEnvironmentChanges(
  baseline: EnvironmentVariableRow[],
  rows: EnvironmentVariableRow[],
): Pick<MergeServiceEnvVarsInput, "upserts" | "deletes"> {
  const before = comparableServiceEnvironment(baseline);
  const after = comparableServiceEnvironment(rows);
  return {
    deletes: before
      .filter((row) => row.sourceId && !after.some((next) => next.sourceId === row.sourceId))
      .map((row) => ({ key: row.key, sourceId: row.sourceId! })),
    upserts: after.filter((row) => {
      const old = row.sourceId
        ? before.find((item) => item.sourceId === row.sourceId)
        : before.find((item) => item.key === row.key);
      return (
        !old || old.key !== row.key || old.value !== row.value || old.isSecret !== row.isSecret
      );
    }),
  };
}

export function draftServiceOverrides(draft: ServiceEnvironmentDraft): Record<string, string> {
  const values = Object.fromEntries(
    draft.baseline.filter((row) => !row.removalDisabled).map((row) => [row.key, row.value]),
  );
  const changes = serviceEnvironmentChanges(draft.baseline, draft.rows);
  for (const row of changes.deletes ?? []) delete values[row.key];
  for (const row of changes.upserts ?? []) values[row.key] = row.value;
  return values;
}
