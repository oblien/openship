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
 * Priority chain:
 *   1. Explicit per-deploy override (passed by the user at deploy time)
 *   2. User platform preference ("server" / "local" override)
 *   3. Stack default (STACKS[framework].defaultBuildStrategy)
 *   4. Fallback: "server"
 */
export async function resolveStrategy(
  userId: string,
  framework: string | undefined,
  explicit?: BuildStrategy,
): Promise<BuildStrategy> {
  // 1. Per-deploy explicit override
  if (explicit) return explicit;

  // 2. User platform preference
  const mode = await getBuildMode(userId);
  if (mode === "server" || mode === "local") return mode;

  // 3. Stack default → 4. Fallback
  const stackId = framework as StackId;
  const stackDef: StackDefinition | undefined =
    stackId && stackId in STACKS
      ? (STACKS[stackId] as StackDefinition)
      : undefined;
  return stackDef?.defaultBuildStrategy ?? "server";
}
