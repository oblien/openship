/**
 * Settings service — business logic for user platform preferences.
 *
 * Used by:
 *   - settings.controller.ts (HTTP layer)
 *   - build.service.ts (build strategy resolution)
 */

import { repos } from "@repo/db";
import { STACKS, type StackId, type StackDefinition } from "@repo/core";
import type { BuildStrategy } from "@repo/adapters";

export type BuildMode = "auto" | "server" | "local";

/** Get the user's build mode preference (defaults to "auto" if no row exists) */
export async function getBuildMode(userId: string): Promise<BuildMode> {
  const settings = await repos.settings.findByUser(userId);
  return (settings?.buildMode as BuildMode) ?? "auto";
}

/**
 * Resolve the effective build strategy for a deployment.
 *
 * The per-deploy value sent by the UI is the source of truth.
 * The global user preference is only used as an initial default
 * in the dashboard when preparing a new deploy — it should NOT
 * override an explicit per-deploy choice here.
 *
 * Priority chain:
 *   1. Explicit per-deploy value (always sent by the dashboard)
 *   2. Stack default (STACKS[framework].defaultBuildStrategy)
 *   3. Fallback: "server"
 */
export async function resolveStrategy(
  _userId: string,
  framework: string | undefined,
  explicit?: BuildStrategy,
): Promise<BuildStrategy> {
  const { env } = await import("../../config");
  // In SaaS/Cloud mode, never allow building locally on the API host
  if (env.CLOUD_MODE) return "server";

  // 1. Per-deploy explicit value (source of truth)
  if (explicit) return explicit;

  // 2. Stack default → 3. Fallback
  const stackId = framework as StackId;
  const stackDef: StackDefinition | undefined =
    stackId && stackId in STACKS
      ? (STACKS[stackId] as StackDefinition)
      : undefined;
  return stackDef?.defaultBuildStrategy ?? "server";
}
