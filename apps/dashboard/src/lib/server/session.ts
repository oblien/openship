import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { getFallbackDeploymentInfoFromHeaders } from "@/lib/api/urls";
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
  autoProvisioned?: boolean;
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
  authMode: "cloud" | "local" | "none";
  cloudAuthUrl: string;
  machineName?: string;
  hostDomain?: string;
};

let _deploymentInfo: DeploymentInfo | null = null;
let _deploymentInfoFetchedAt = 0;

/**
 * Deployment info is mostly static, but during desktop onboarding
 * authMode can change from "none" to "cloud" or vice versa.
 * Re-fetch every 30 seconds so changes take effect quickly.
 */
const DEPLOYMENT_INFO_TTL = 30_000;

export async function getDeploymentInfo(): Promise<DeploymentInfo> {
  if (_deploymentInfo && Date.now() - _deploymentInfoFetchedAt < DEPLOYMENT_INFO_TTL) {
    return _deploymentInfo;
  }

  const requestHeaders = await headers();

  try {
    _deploymentInfo = await serverApi.get<DeploymentInfo>("/api/health/env");
    _deploymentInfoFetchedAt = Date.now();
  } catch {
    if (_deploymentInfo) {
      return _deploymentInfo;
    }

    return getFallbackDeploymentInfoFromHeaders(requestHeaders);
  }
  return _deploymentInfo;
}
