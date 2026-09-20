"use client";

import { useMemo } from "react";
import { servicesApi } from "@/lib/api/services";

/** Shared saved-value lookup for every service environment editor. */
export function useServiceEnvReveal(
  projectId?: string | number,
  serviceId?: string,
  environment?: "production" | "preview" | "development",
) {
  return useMemo(() => {
    if (!projectId || !serviceId) return undefined;
    return async (keys: string[]) =>
      (await servicesApi.revealEnv(projectId, serviceId, keys, environment)).environment;
  }, [projectId, serviceId, environment]);
}
