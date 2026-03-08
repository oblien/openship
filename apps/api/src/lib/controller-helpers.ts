/**
 * Shared controller helpers — used across all Hono route handlers.
 *
 * Eliminates duplication of getUserId / param / platform() across controllers.
 */

import type { Context } from "hono";
import {
  initPlatform,
  getPlatform,
  type Platform,
  type PlatformTarget,
  type PlatformConfig,
} from "@repo/adapters";
import { env } from "../config/env";

// ─── Auth helpers ────────────────────────────────────────────────────────────

/** Extract the authenticated user ID from Hono context */
export function getUserId(c: Context): string {
  const user = c.get("user");
  if (!user?.id) throw new Error("Unauthorized: no user in context");
  return user.id;
}

/** Extract and validate a required route parameter */
export function param(c: Context, name: string): string {
  const val = c.req.param(name);
  if (!val) throw new Error(`Missing route param: ${name}`);
  return val;
}

// ─── Platform resolution ─────────────────────────────────────────────────────

/**
 * Resolve the deployment target from environment config.
 *
 * Priority:
 *   1. CLOUD_MODE=true → "cloud" (overrides DEPLOY_MODE)
 *   2. DEPLOY_MODE env → "docker" | "bare" | "cloud" | "desktop"
 *   3. Default → "docker" (self-hosted with Docker runtime)
 */
function resolveConfig(): PlatformConfig {
  // Cloud mode override
  if (env.CLOUD_MODE || env.DEPLOY_MODE === "cloud") {
    return { target: "cloud" };
  }

  if (env.DEPLOY_MODE === "desktop") {
    return { target: "desktop" };
  }

  // Self-hosted: docker or bare
  return {
    target: "selfhosted",
    runtime: env.DEPLOY_MODE === "bare" ? "bare" : "docker",
  };
}

/**
 * Initialize the platform at server startup.
 *
 * Call this ONCE before the server starts handling requests.
 * After this, `platform()` returns the cached instance synchronously.
 */
export async function bootstrapPlatform(): Promise<Platform> {
  return initPlatform(resolveConfig());
}

/**
 * Get the platform — the single entry point for all service code.
 *
 * Returns: { runtime, routing, ssl, system }
 *   - runtime: build/deploy/stop/start lifecycle
 *   - routing: register/remove reverse-proxy routes
 *   - ssl: provision/renew TLS certificates
 *   - system: prerequisite validation (self-hosted only, null otherwise)
 *
 * All service code uses this. Nothing constructs adapters directly.
 */
export function platform(): Platform {
  return getPlatform();
}
