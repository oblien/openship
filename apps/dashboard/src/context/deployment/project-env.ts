import { isMaskedValue, looksLikeSecretKey } from "@repo/core";
import type { EnvironmentVariable } from "@/components/import-project/types";

export interface PersistedProjectEnvVar {
  id: string;
  key: string;
  value: string;
  isSecret: boolean;
}

export interface ProjectEnvMerge {
  upserts: Array<{ key: string; value: string; isSecret: boolean }>;
  deletes: string[];
}

export type ProjectEnvPersistencePlan =
  | { ok: false; error: string }
  | {
      ok: true;
      /** Existing projects persist this diff before save/deploy. */
      merge: ProjectEnvMerge | null;
      /** Only a brand-new project sends env through build/access. */
      deployEnvVars: Record<string, string> | undefined;
    };

/**
 * Plan project-level env persistence for the deployment wizard.
 *
 * Existing projects use PATCH /env and omit envVars from build/access. That
 * keeps the stored env authoritative and, crucially, means an untouched masked
 * secret can never be serialized as dots or an empty placeholder. New projects
 * have no stored env to merge into, so their entered values still travel in the
 * initial build/access request.
 */
export function planProjectEnvPersistence(
  rows: EnvironmentVariable[],
  persisted: PersistedProjectEnvVar[],
  existingProject: boolean,
): ProjectEnvPersistencePlan {
  const normalized = rows.map((row) => ({ ...row, key: row.key.trim() }));
  const seenKeys = new Set<string>();

  for (const row of normalized) {
    if (!row.key && !row.value && !row.sourceId) continue;
    if (!row.key) return { ok: false, error: "Every environment variable needs a name" };
    if (seenKeys.has(row.key)) {
      return { ok: false, error: `Duplicate environment variable "${row.key}"` };
    }
    seenKeys.add(row.key);
  }

  if (!existingProject) {
    const deployEnvVars: Record<string, string> = {};
    for (const row of normalized) {
      if (!row.key && !row.value && !row.sourceId) continue;
      if (isMaskedValue(row.value)) {
        return { ok: false, error: `Enter a value for "${row.key}"` };
      }
      deployEnvVars[row.key] = row.value;
    }
    return {
      ok: true,
      merge: null,
      deployEnvVars: Object.keys(deployEnvVars).length > 0 ? deployEnvVars : undefined,
    };
  }

  const persistedById = new Map(persisted.map((row) => [row.id, row]));
  const keptIds = new Set<string>();
  const upserts: ProjectEnvMerge["upserts"] = [];

  for (const row of normalized) {
    if (!row.key && !row.value && !row.sourceId) continue;

    const original = row.sourceId ? persistedById.get(row.sourceId) : undefined;
    if (row.sourceId && !original) {
      return { ok: false, error: `Reload the page before changing "${row.key}"` };
    }

    if (!original) {
      if (isMaskedValue(row.value)) {
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
    if (!renamed) keptIds.add(original.id);

    if (original.isSecret && isMaskedValue(row.value)) {
      if (renamed || isSecret !== original.isSecret) {
        return {
          ok: false,
          error: `Enter a new value for "${original.key}" before renaming it`,
        };
      }
      continue;
    }

    if (renamed || row.value !== original.value || isSecret !== original.isSecret) {
      upserts.push({ key: row.key, value: row.value, isSecret });
    }
  }

  const upsertKeys = new Set(upserts.map((row) => row.key));
  const deletes = persisted
    .filter((row) => !keptIds.has(row.id))
    .map((row) => row.key)
    // Removing and re-adding the same key is represented by its upsert only;
    // the merge endpoint deliberately rejects a key in both arrays.
    .filter((key) => !upsertKeys.has(key));

  return { ok: true, merge: { upserts, deletes }, deployEnvVars: undefined };
}
