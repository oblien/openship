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
import { isOblienConfigured } from "./platform-mode";

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
 * CLOUD_MODE (SaaS hosting) and DEPLOY_MODE=cloud (Oblien runtime) both
 * need the cloud platform adapter, so either triggers the cloud config.
 * Auth/billing concerns are gated separately by CLOUD_MODE alone.
 *
 * Priority:
 *   1. CLOUD_MODE=true or DEPLOY_MODE=cloud → "cloud" (Oblien runtime)
 *   2. DEPLOY_MODE=desktop → "desktop"
 *   3. Default → "selfhosted" with docker or bare runtime
 */
function resolveConfig(): PlatformConfig {
  if (isOblienConfigured()) {
    return {
      target: "cloud",
      cloudClientId: env.OBLIEN_CLIENT_ID,
      cloudClientSecret: env.OBLIEN_CLIENT_SECRET,
    };
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

// ─── Project access ──────────────────────────────────────────────────────────

import { repos, type Project } from "@repo/db";

/**
 * Verify the project exists and belongs to the user.
 * Throws a descriptive string ("project-not-found") on failure — callers
 * catch and map to the appropriate HTTP status.
 */
export async function assertProjectAccess(projectId: string, userId: string): Promise<Project> {
  const project = await repos.project.findById(projectId);
  if (!project || project.userId !== userId) {
    throw new Error("project-not-found");
  }
  return project;
}
