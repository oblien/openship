"use client";

/**
 * Client-side deployment info for routes that live OUTSIDE the dashboard's
 * PlatformProvider (e.g. the top-level /mcp/authorize consent page), where
 * `usePlatform()` isn't available.
 *
 * Deployment info is static for the life of the app, so the fetch is cached at
 * module scope and the promise is shared: N consumers → one `health/env`
 * request. Non-fail-loud — returns `null` until resolved, and clears the cache
 * on failure so a later mount can retry. Callers pick a safe default while
 * pending. (The dashboard proper should use `usePlatform()` instead.)
 */

import { useEffect, useState } from "react";
import { api } from "@/lib/api/client";

export type ClientDeploymentInfo = {
  selfHosted: boolean;
  deployMode: string;
  authMode: "cloud" | "local" | "none";
  /** Experimental Docker Swarm capability, resolved by the API. */
  swarmSupportEnabled?: boolean;
  /** Running server release (self-hosted). Absent on older servers. */
  version?: string;
};

let cached: Promise<ClientDeploymentInfo> | null = null;

function loadDeploymentInfo(): Promise<ClientDeploymentInfo> {
  cached ??= api.get<ClientDeploymentInfo>("health/env").catch((err) => {
    cached = null; // rejected promise shouldn't latch — allow a retry
    throw err;
  });
  return cached;
}

export function useDeploymentInfo(): ClientDeploymentInfo | null {
  const [info, setInfo] = useState<ClientDeploymentInfo | null>(null);
  useEffect(() => {
    let alive = true;
    loadDeploymentInfo()
      .then((d) => alive && setInfo(d))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return info;
}
