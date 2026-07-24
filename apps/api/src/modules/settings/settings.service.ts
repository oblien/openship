/**
 * Settings service - business logic for user platform preferences.
 *
 * Used by:
 *   - settings.controller.ts (HTTP layer)
 *   - build.service.ts (build strategy resolution)
 */

import { repos } from "@repo/db";
import { STACKS, type StackId, type StackDefinition } from "@repo/core";
import type { BuildStrategy, TransferMode, TransferCompression } from "@repo/adapters";
import { env } from "../../config";

export type BuildMode = "auto" | "server" | "local";
export type DefaultDeployTarget = "local" | "server" | "cloud";

const VALID_DEPLOY_TARGETS: DefaultDeployTarget[] = ["local", "server", "cloud"];

export function isValidDefaultDeployTarget(value: unknown): value is DefaultDeployTarget {
  return typeof value === "string" && (VALID_DEPLOY_TARGETS as string[]).includes(value);
}

/**
 * Get the user's build mode preference (defaults to "auto" if no row exists)
 * @scope user
 */
export async function getBuildMode(userId: string): Promise<BuildMode> {
  const settings = await repos.settings.findByUser(userId);
  return (settings?.buildMode as BuildMode) ?? "auto";
}

// ── Route strategy (edge → app upstream addressing) ──────────────────────────

/** How the edge reaches a deployed app's upstream.
 *   - "auto"          → resolved to loopback-port (the safe self-host default)
 *   - "loopback-port" → publish + route via a pinned `127.0.0.1:<hostPort>`
 *   - "container-ip"  → route via the container's bridge IP (advanced; zero-
 *                       downtime swaps, needs the edge on the docker bridge,
 *                       unsupported on Docker Desktop) */
export type RouteStrategyPref = "auto" | "loopback-port" | "container-ip";

const VALID_ROUTE_STRATEGIES: RouteStrategyPref[] = ["auto", "loopback-port", "container-ip"];

export function isValidRouteStrategy(value: unknown): value is RouteStrategyPref {
  return typeof value === "string" && (VALID_ROUTE_STRATEGIES as string[]).includes(value);
}

/**
 * The user's default route strategy (seeds new projects + the deploy wizard).
 * Unset/invalid → "auto". A per-project value still wins over this; the pure
 * `resolveRouteStrategy` in lib/upstream-url coerces the effective value to a
 * concrete strategy at each upstream-resolution site.
 * @scope user
 */
export async function getRouteStrategy(userId: string): Promise<RouteStrategyPref> {
  const settings = await repos.settings.findByUser(userId);
  return isValidRouteStrategy(settings?.routeStrategy) ? settings.routeStrategy : "auto";
}

/**
 * Has the user explicitly opted out of the gh-CLI fallback?
 * Used by github.auth.getUserStatus to honor a disconnect from cli mode.
 * @scope user
 */
export async function isGithubCliDisabled(userId: string): Promise<boolean> {
  const settings = await repos.settings.findByUser(userId);
  return settings?.githubCliDisabled ?? false;
}

/**
 * Flip the gh-CLI suppression flag. Inserts a row if the user has none yet.
 * @scope user
 */
export async function setGithubCliDisabled(userId: string, disabled: boolean): Promise<void> {
  const existing = await repos.settings.findByUser(userId);
  if (existing) {
    await repos.settings.update(userId, { githubCliDisabled: disabled });
    return;
  }
  const { randomBytes } = await import("node:crypto");
  await repos.settings.upsert({
    id: "us_" + randomBytes(12).toString("base64url"),
    userId,
    buildMode: "auto",
    githubCliDisabled: disabled,
  });
}

/**
 * Resolve the user's default deploy target + server id.
 *
 * Returns nulls when the user has no preference yet. Callers in the dashboard
 * use this to seed the deploy picker; an explicit per-deploy choice still
 * wins and is never written back unless the user opts in.
 *
 * Note: server id is returned verbatim. The dashboard verifies it against the
 * current server list before honoring it - if the server has been deleted,
 * the stale default is silently ignored on the next deploy.
 * @scope user
 */
export async function getDeployDefaults(userId: string): Promise<{
  defaultDeployTarget: DefaultDeployTarget | null;
  defaultServerId: string | null;
}> {
  const settings = await repos.settings.findByUser(userId);
  const raw = settings?.defaultDeployTarget ?? null;
  return {
    defaultDeployTarget: isValidDefaultDeployTarget(raw) ? raw : null,
    defaultServerId: settings?.defaultServerId ?? null,
  };
}

/**
 * Resolve the effective build strategy for a deployment.
 *
 * The per-deploy value sent by the UI is the source of truth.
 * The global user preference is only used as an initial default
 * in the dashboard when preparing a new deploy - it should NOT
 * override an explicit per-deploy choice here.
 *
 * Priority chain:
 *   1. Explicit per-deploy value (always sent by the dashboard)
 *   2. deployTarget==="cloud" default → "server" (cloud builds belong
 *      in the cloud runtime so they get the right toolchain and don't
 *      burn host resources)
 *   3. Stack default (STACKS[framework].defaultBuildStrategy)
 *   4. Fallback: "server"
 */
export async function resolveStrategy(
  framework: string | undefined,
  explicit?: BuildStrategy,
  opts?: { deployTarget?: "local" | "server" | "cloud" },
): Promise<BuildStrategy> {
  // In SaaS/Cloud mode, never allow building locally on the API host
  if (env.CLOUD_MODE) return "server";

  // 1. Per-deploy explicit value (source of truth)
  if (explicit) return explicit;

  // 2. Cloud deploy target with no explicit choice → build in the cloud
  //    workspace, not on the API host. Aligns the backend default with
  //    the dashboard's auto-flip behavior so non-UI callers (CI, API)
  //    get the same answer as the UI's first-deploy hint.
  if (opts?.deployTarget === "cloud") return "server";

  // 3. Stack default → 4. Fallback
  const stackId = framework as StackId;
  const stackDef: StackDefinition | undefined =
    stackId && stackId in STACKS
      ? (STACKS[stackId] as StackDefinition)
      : undefined;
  return stackDef?.defaultBuildStrategy ?? "server";
}

// ── Volume-transfer preference (migrations / server-to-server moves) ─────────

const VALID_TRANSFER_MODES: TransferMode[] = ["auto", "stream", "direct", "rsync"];
const VALID_TRANSFER_COMPRESSION: TransferCompression[] = ["auto", "zstd", "gzip", "none"];

export function isValidTransferMode(value: unknown): value is TransferMode {
  return typeof value === "string" && (VALID_TRANSFER_MODES as string[]).includes(value);
}
export function isValidTransferCompression(value: unknown): value is TransferCompression {
  return typeof value === "string" && (VALID_TRANSFER_COMPRESSION as string[]).includes(value);
}

/**
 * The user's default volume-transfer preference. Unset/invalid → "auto"
 * (topology-aware). A per-migration override still wins over this.
 * @scope user
 */
export async function getTransferPrefs(
  userId: string,
): Promise<{ transferMode: TransferMode; transferCompression: TransferCompression }> {
  const settings = await repos.settings.findByUser(userId);
  return {
    transferMode: isValidTransferMode(settings?.transferMode) ? settings.transferMode : "auto",
    transferCompression: isValidTransferCompression(settings?.transferCompression)
      ? settings.transferCompression
      : "auto",
  };
}
