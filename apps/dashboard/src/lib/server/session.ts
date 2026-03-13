import "server-only";
import { cache } from "react";
import { serverApi, ServerApiError } from "./api";

/**
 * Session and user types returned by Better Auth's `/api/auth/get-session`.
 */
export type Session = {
  id: string;
  userId: string;
  expiresAt: string;
  token: string;
  createdAt: string;
  updatedAt: string;
  ipAddress?: string;
  userAgent?: string;
};

export type User = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image?: string | null;
  createdAt: string;
  updatedAt: string;
  role: string;
};

export type SessionData = { session: Session; user: User };

/**
 * Get the current session from the API.
 *
 * Wrapped with `React.cache()` so multiple server components
 * calling `getSession()` in the same request share one fetch.
 *
 * Returns the session data or `null` if unauthenticated.
 */
export const getSession = cache(async (): Promise<SessionData | null> => {
  const MAX_RETRIES = 3;
  const RETRY_DELAY = 1000; // ms

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const data = await serverApi.get<SessionData>("/api/auth/get-session", {
        cache: "no-store",
      });
      return data;
    } catch (err) {
      // 401 = genuinely unauthenticated — no point retrying
      if (err instanceof ServerApiError && err.status === 401) {
        return null;
      }
      // Network / timeout error — API may be restarting, retry
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY));
        continue;
      }
      // Exhausted retries — return null so the page shows login
      return null;
    }
  }
  return null;
});

/* ------------------------------------------------------------------ */
/*  Deployment info (fetched once, cached in module memory forever)    */
/* ------------------------------------------------------------------ */

export type DeploymentInfo = {
  selfHosted: boolean;
  deployMode: string;
};

let _deploymentInfo: DeploymentInfo | null = null;

/**
 * Deployment info is static per instance — fetch once from
 * GET /api/health/env and cache in module memory.
 * Zero per-request cost after the first call.
 */
export async function getDeploymentInfo(): Promise<DeploymentInfo> {
  if (_deploymentInfo) return _deploymentInfo;
  try {
    _deploymentInfo = await serverApi.get<DeploymentInfo>("/api/health/env");
  } catch {
    _deploymentInfo = { selfHosted: true, deployMode: "docker" };
  }
  return _deploymentInfo;
}
