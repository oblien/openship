/**
 * Project environment variables service - list & set encrypted env vars.
 */

import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { repos } from "@repo/db";
import {
  ConflictError,
  ValidationError,
  SYSTEM,
  isValidEnvKey,
  looksLikeSecretKey,
} from "@repo/core";
import { encrypt, decrypt, decryptEnvMap } from "../../lib/encryption";
import { ENV_MASK } from "../../lib/secret-env";
import { assertResourceInOrg } from "../../lib/resource-access";
import type { TMergeEnvVarsBody } from "@repo/contracts";
import { mergeServiceDeployEnv } from "../deployments/compose/service-env-layers";

// ─── List env vars ───────────────────────────────────────────────────────────

export async function listEnvVars(projectId: string, organizationId: string, environment?: string) {
  const p = await repos.project.findById(projectId);
  assertResourceInOrg(p, "Project", organizationId, projectId);

  // Match project writes: service-scoped rows belong to the service env API.
  const vars = await repos.project.listEnvVars(projectId, environment, null);

  return vars.map((v) => {
    let plainValue: string;
    try {
      plainValue = decrypt(v.value);
    } catch (diagnosticFailure) {
      observeCaughtError(diagnosticFailure, "platform/engine/modules/projects/project-env.service");
      plainValue = v.value;
    }
    return {
      id: v.id,
      key: v.key,
      value: v.isSecret ? ENV_MASK : plainValue,
      environment: v.environment,
      isSecret: v.isSecret,
      createdAt: v.createdAt,
      updatedAt: v.updatedAt,
    };
  });
}

// ─── Set env vars ────────────────────────────────────────────────────────────

// ─── Merge env vars (partial — safe for masked secrets) ──────────────────────

/**
 * Apply a partial diff to a project's env vars: `upserts` are added/updated,
 * `deletes` are removed, everything else is left untouched. Used by the
 * per-variable editor so a secret the user didn't change (shown masked in the
 * UI) is never re-sent and never corrupted — only the keys it names are touched.
 */
export async function mergeEnvVars(
  projectId: string,
  organizationId: string,
  data: TMergeEnvVarsBody,
) {
  const p = await repos.project.findById(projectId);
  assertResourceInOrg(p, "Project", organizationId, projectId);

  // No key may appear in both upserts and deletes (ambiguous intent).
  const upsertKeys = data.upserts.map((v) => v.key);
  const dupInUpserts = new Set(upsertKeys);
  if (dupInUpserts.size !== upsertKeys.length) {
    throw new ValidationError("Duplicate environment variable keys in upserts");
  }
  const deleteSet = new Set(data.deletes);
  for (const key of upsertKeys) {
    if (deleteSet.has(key)) {
      throw new ValidationError(`Key "${key}" cannot be both upserted and deleted`);
    }
  }

  if (data.upserts.length > SYSTEM.ENV_VARS.MAX_PER_PROJECT) {
    throw new ValidationError(`Maximum ${SYSTEM.ENV_VARS.MAX_PER_PROJECT} variables per project`);
  }

  for (const key of [...upsertKeys, ...data.deletes]) {
    if (!isValidEnvKey(key)) {
      throw new ValidationError(`Invalid environment variable name "${key}"`);
    }
  }
  if (data.upserts.some((v) => v.value.includes("\0"))) {
    throw new ValidationError("Environment variable values cannot contain NUL bytes");
  }

  // Read diagnostics before committing: a failed diagnostic read must not make
  // a successful write look failed to a caller retrying a credential rotation.
  const changedKeys = new Set([...upsertKeys, ...data.deletes]);
  const [services, stored] = await Promise.all([
    repos.service.listByProject(projectId),
    repos.project.listEnvVars(projectId, data.environment),
  ]);
  const priorRows = new Map(
    stored.filter((row) => !row.serviceId).map((row) => [row.key, row] as const),
  );

  // Same rules as service env writes: a value sent back as the list mask keeps
  // the stored value, and an upsert that omits isSecret keeps the stored flag,
  // so a round trip through listEnvVars never exposes or overwrites a secret.
  const encrypted = data.upserts.map((v) => {
    const prior = priorRows.get(v.key);
    if (v.value === ENV_MASK && !prior) {
      throw new ValidationError(
        `No saved value exists for "${v.key}". Enter its value before saving.`,
      );
    }
    return {
      key: v.key,
      value: v.value === ENV_MASK ? prior!.value : encrypt(v.value),
      isSecret: v.isSecret ?? prior?.isSecret ?? looksLikeSecretKey(v.key),
    };
  });

  const projectValues = decryptEnvMap(
    Object.fromEntries([...priorRows].map(([key, row]) => [key, row.value])),
  );
  for (const row of data.upserts) {
    if (row.value !== ENV_MASK) projectValues[row.key] = row.value;
  }
  // Include deleted keys in the comparison: deleting the project copy does not
  // remove a service's pinned copy. No value is returned in the diagnostic.
  for (const key of data.deletes) projectValues[key] ??= "";
  const warnings: string[] = [];
  for (const service of services) {
    if (!service.enabled) continue;
    const serviceValues = decryptEnvMap(
      Object.fromEntries(
        stored.filter((row) => row.serviceId === service.id).map((row) => [row.key, row.value]),
      ),
    );
    const resolved = mergeServiceDeployEnv(
      {
        project: projectValues,
        frozen: {},
        inline: service.environment ?? {},
        templateKeys: service.advanced?.environmentTemplateKeys,
        service: serviceValues,
      },
      false,
    );
    const keys = resolved.overriddenProjectKeys.filter((key) => changedKeys.has(key));
    if (keys.length > 0) {
      warnings.push(
        `Service "${service.name}" overrides project environment for: ${keys.join(", ")}. Update or remove its service-level values for these changes to reach that service.`,
      );
    }
  }
  await repos.project.mergeEnvVarScopes(
    projectId,
    data.environment,
    [{ upserts: encrypted, deletes: data.deletes }],
    ({ vars }) => {
      // Resolve preservation against the same configuration lock as the write.
      // A masked form must never restore a secret rotated after the earlier read.
      const current = new Map(vars.filter((row) => !row.serviceId).map((row) => [row.key, row]));
      for (const row of data.upserts) {
        const prior = priorRows.get(row.key);
        const latest = current.get(row.key);
        if (
          (row.value === ENV_MASK && prior?.value !== latest?.value) ||
          (row.isSecret === undefined && prior?.isSecret !== latest?.isSecret)
        ) {
          throw new ConflictError(
            "Environment variables changed while saving. Reload and try again.",
          );
        }
      }
    },
  );
  return { upserted: data.upserts.length, deleted: data.deletes.length, warnings };
}
