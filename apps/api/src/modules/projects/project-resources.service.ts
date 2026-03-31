/**
 * Project resources service — CPU/memory/disk config + sleep mode.
 */

import { repos } from "@repo/db";
import { NotFoundError, ValidationError } from "@repo/core";
import type { ResourceConfig } from "@repo/adapters";
import { encodeResources, decodeResources } from "../../lib/resources";
import type { TUpdateResourcesBody } from "./project.schema";

// ─── Get resources ───────────────────────────────────────────────────────────

export async function getResources(projectId: string, userId: string) {
  const p = await repos.project.findById(projectId);
  if (!p || p.userId !== userId) throw new NotFoundError("Project", projectId);

  const production = p.resources as ResourceConfig | null;
  const build = p.buildResources as ResourceConfig | null;
  return encodeResources(production, build, p.sleepMode ?? "auto_sleep", p.port ?? 3000);
}

// ─── Update resources ────────────────────────────────────────────────────────

export async function updateResources(projectId: string, userId: string, data: TUpdateResourcesBody) {
  const p = await repos.project.findById(projectId);
  if (!p || p.userId !== userId) throw new NotFoundError("Project", projectId);

  const update: Record<string, unknown> = {};

  if (data.production) {
    update.resources = decodeResources(data.production);
  }
  if (data.build) {
    update.buildResources = decodeResources(data.build);
  }
  if (data.sleepMode) {
    update.sleepMode = data.sleepMode;
  }
  if (data.port) {
    update.port = data.port;
  }

  await repos.project.update(projectId, update);
  return getResources(projectId, userId);
}

// ─── Sleep mode ──────────────────────────────────────────────────────────────

export async function setSleepMode(projectId: string, userId: string, sleepMode: string) {
  const p = await repos.project.findById(projectId);
  if (!p || p.userId !== userId) throw new NotFoundError("Project", projectId);

  if (!["auto_sleep", "always_on"].includes(sleepMode)) {
    throw new ValidationError("Invalid sleep mode. Must be 'auto_sleep' or 'always_on'");
  }

  await repos.project.update(projectId, { sleepMode });
  return { success: true, sleepMode };
}
