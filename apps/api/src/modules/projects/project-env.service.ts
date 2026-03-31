/**
 * Project environment variables service — list & set encrypted env vars.
 */

import { repos } from "@repo/db";
import { NotFoundError, ValidationError, SYSTEM } from "@repo/core";
import { encrypt, decrypt } from "../../lib/encryption";
import type { TSetEnvVarsBody } from "./project.schema";

// ─── List env vars ───────────────────────────────────────────────────────────

export async function listEnvVars(projectId: string, userId: string, environment?: string) {
  const p = await repos.project.findById(projectId);
  if (!p || p.userId !== userId) throw new NotFoundError("Project", projectId);

  const vars = await repos.project.listEnvVars(projectId, environment);

  return vars.map((v) => {
    let plainValue: string;
    try {
      plainValue = decrypt(v.value);
    } catch {
      plainValue = v.value;
    }
    return {
      id: v.id,
      key: v.key,
      value: v.isSecret ? "••••••••" : plainValue,
      environment: v.environment,
      isSecret: v.isSecret,
      createdAt: v.createdAt,
      updatedAt: v.updatedAt,
    };
  });
}

// ─── Set env vars ────────────────────────────────────────────────────────────

export async function setEnvVars(projectId: string, userId: string, data: TSetEnvVarsBody) {
  const p = await repos.project.findById(projectId);
  if (!p || p.userId !== userId) throw new NotFoundError("Project", projectId);

  const keys = data.vars.map((v) => v.key);
  const unique = new Set(keys);
  if (unique.size !== keys.length) {
    throw new ValidationError("Duplicate environment variable keys");
  }

  if (data.vars.length > SYSTEM.ENV_VARS.MAX_PER_PROJECT) {
    throw new ValidationError(
      `Maximum ${SYSTEM.ENV_VARS.MAX_PER_PROJECT} variables per project`,
    );
  }

  const encrypted = data.vars.map((v) => ({
    key: v.key,
    value: encrypt(v.value),
    isSecret: v.isSecret,
  }));

  await repos.project.bulkSetEnvVars(projectId, data.environment, encrypted);
  return { count: data.vars.length };
}
