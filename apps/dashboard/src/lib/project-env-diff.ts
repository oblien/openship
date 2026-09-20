import { ENV_MASK, isMaskedValue, looksLikeSecretKey } from "@repo/core";

export interface EditableProjectEnvRow {
  key: string;
  value: string;
  visible: boolean;
  /** Persisted key this editable row came from. Absent for new/source rows. */
  originalKey?: string;
  /** The value is intentionally unavailable and must not be overwritten. */
  preserveValue?: boolean;
  /** Explicit secret classification; absent rows use the shared name heuristic. */
  isSecret?: boolean;
}

export interface PersistedProjectEnv {
  key: string;
  /** Plaintext for readable rows; ENV_MASK for secrets. */
  value: string;
  isSecret: boolean;
}

export interface ProjectEnvDiff {
  upserts: Array<{ key: string; value: string; isSecret: boolean }>;
  deletes: string[];
}

export type ProjectEnvDiffResult =
  | { ok: true; diff: ProjectEnvDiff }
  | { ok: false; error: string };

export interface ProjectEnvEditState {
  rows: EditableProjectEnvRow[];
  baseline: PersistedProjectEnv[];
}

type EnvApiRow = {
  key: string;
  value: string;
  isSecret: boolean;
  environment: string;
};

type NormalizedProjectEnvRow = EditableProjectEnvRow & { key: string };

type NormalizedRowsResult =
  | { ok: true; rows: NormalizedProjectEnvRow[] }
  | { ok: false; error: string };

/**
 * Build the editable rows and their immutable comparison snapshot together so
 * no caller can accidentally load one without the other. Secret plaintext
 * never enters browser state: the row is blank + preserved and the baseline
 * carries only the shared mask sentinel.
 */
export function createProjectEnvEditState(
  apiRows: readonly EnvApiRow[],
  environment = "production",
): ProjectEnvEditState {
  const baseline = apiRows
    .filter((row) => row.environment === environment)
    .map((row) => ({
      key: row.key,
      value: row.isSecret ? ENV_MASK : row.value,
      isSecret: row.isSecret,
    }));

  return {
    baseline,
    rows: baseline.map((row) => ({
      key: row.key,
      originalKey: row.key,
      value: row.isSecret ? "" : row.value,
      visible: true,
      preserveValue: row.isSecret || undefined,
      isSecret: row.isSecret,
    })),
  };
}

/** Validate and trim the editable key column once for every persistence path. */
function normalizeProjectEnvRows(rows: readonly EditableProjectEnvRow[]): NormalizedRowsResult {
  const normalized: NormalizedProjectEnvRow[] = [];
  const seenKeys = new Set<string>();

  for (const row of rows) {
    const key = row.key.trim();
    const completelyBlank =
      !key && !row.value && row.originalKey === undefined && !row.preserveValue;
    if (completelyBlank) continue;

    if (!key) return { ok: false, error: "Every environment variable needs a name" };
    if (seenKeys.has(key)) {
      return { ok: false, error: `Duplicate environment variable "${key}"` };
    }
    seenKeys.add(key);
    normalized.push({ ...row, key });
  }

  return { ok: true, rows: normalized };
}

/**
 * Serialize env for a brand-new project. There is no persisted store to diff
 * yet, so values travel through build/access. A preserved source row is sent as
 * the mask sentinel; the API resolves it from the trusted source checkout.
 */
export function serializeNewProjectEnv(
  rows: readonly EditableProjectEnvRow[],
): { ok: true; envVars: Record<string, string> | undefined } | { ok: false; error: string } {
  const normalized = normalizeProjectEnvRows(rows);
  if (!normalized.ok) return normalized;

  const envVars = Object.fromEntries(
    normalized.rows.map((row) => [
      row.key,
      row.preserveValue || isMaskedValue(row.value) ? ENV_MASK : row.value,
    ]),
  );
  return {
    ok: true,
    envVars: Object.keys(envVars).length > 0 ? envVars : undefined,
  };
}

/**
 * Compute a partial project-env merge from editable rows and the snapshot they
 * were loaded with. Untouched masked values never leave the browser, while an
 * explicit edit to an empty string remains a real upsert.
 *
 * Source-owned rows discovered from openship.json have no `originalKey` and
 * may also be preserved. The deployment wizard can ignore those rows because
 * build/access resolves them from source; ordinary editors reject them instead
 * of pretending they were persisted.
 */
export function computeProjectEnvDiff(
  rows: readonly EditableProjectEnvRow[],
  baseline: readonly PersistedProjectEnv[],
  options: { ignoreUntrackedPreserved?: boolean } = {},
): ProjectEnvDiffResult {
  const normalized = normalizeProjectEnvRows(rows);
  if (!normalized.ok) return normalized;

  const baselineByKey = new Map<string, PersistedProjectEnv>();
  for (const saved of baseline) {
    if (baselineByKey.has(saved.key)) {
      return { ok: false, error: "Reload the page before changing environment variables" };
    }
    baselineByKey.set(saved.key, saved);
  }

  const claimedOriginalKeys = new Set<string>();
  const keptOriginalKeys = new Set<string>();
  const upserts: ProjectEnvDiff["upserts"] = [];

  for (const row of normalized.rows) {
    const originalKey = row.originalKey;
    const original = originalKey ? baselineByKey.get(originalKey) : undefined;

    if (originalKey && !original) {
      return {
        ok: false,
        error: `Reload the page before changing "${originalKey}"`,
      };
    }
    if (originalKey && claimedOriginalKeys.has(originalKey)) {
      return {
        ok: false,
        error: `Reload the page before changing "${originalKey}"`,
      };
    }
    if (originalKey) claimedOriginalKeys.add(originalKey);

    const preserved = Boolean(row.preserveValue) || isMaskedValue(row.value);
    if (!original) {
      if (preserved) {
        if (options.ignoreUntrackedPreserved) continue;
        return { ok: false, error: `Enter a value for "${row.key}"` };
      }
      upserts.push({
        key: row.key,
        value: row.value,
        isSecret: row.isSecret ?? looksLikeSecretKey(row.key),
      });
      continue;
    }

    const isSecret = row.isSecret ?? original.isSecret;
    const renamed = row.key !== original.key;
    if (!renamed) keptOriginalKeys.add(original.key);

    if (preserved) {
      if (renamed || isSecret !== original.isSecret) {
        return {
          ok: false,
          error: `Re-enter the value for "${original.key}" before changing it`,
        };
      }
      continue;
    }

    if (renamed || row.value !== original.value || isSecret !== original.isSecret) {
      upserts.push({ key: row.key, value: row.value, isSecret });
    }
  }

  const upsertKeys = new Set(upserts.map((row) => row.key));
  const deletes = baseline
    .map((row) => row.key)
    .filter((key) => !keptOriginalKeys.has(key) && !upsertKeys.has(key));

  return { ok: true, diff: { upserts, deletes } };
}
