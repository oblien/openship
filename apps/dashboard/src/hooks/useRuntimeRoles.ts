"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { reportCaughtError } from "@repo/core/diagnostics";
import { useCloudResourceKey } from "@/context/CloudResourceContext";
import { getApiErrorMessage } from "@/lib/api/client";
import { loadRuntimeRoles } from "@/lib/api/project-runtime";
import type { ProjectRuntimeRoles } from "@/lib/runtime-roles";

/** One read-only poll per mounted view. Release/account switches invalidate in-flight reads. */
export function useRuntimeRoles(projectId: string, deploymentId?: string | null, enabled = true) {
  const scope = useCloudResourceKey();
  const key = JSON.stringify([scope, projectId, deploymentId, enabled]);
  const [state, setState] = useState<{
    key: string;
    data: ProjectRuntimeRoles | null;
    loading: boolean;
    error: string | null;
  }>({ key, data: null, loading: false, error: null });
  const revision = useRef(0);
  const inFlight = useRef(false);
  const refresh = useCallback(async () => {
    const request = ++revision.current;
    if (!enabled || !deploymentId) {
      inFlight.current = false;
      setState({ key, data: null, loading: false, error: null });
      return;
    }
    inFlight.current = true;
    setState((previous) => ({
      key,
      data: previous.key === key ? previous.data : null,
      loading: true,
      error: null,
    }));
    try {
      const { data } = await loadRuntimeRoles(projectId);
      if (request !== revision.current) return;
      if (data.deploymentId !== deploymentId)
        throw new Error("The active deployment changed. Refresh the project.");
      setState({ key, data, loading: false, error: data.error });
    } catch (error) {
      if (request !== revision.current) return;
      reportCaughtError(error, "dashboard/hooks/useRuntimeRoles");
      setState((previous) => ({
        key,
        loading: false,
        error: getApiErrorMessage(error, "Role status could not be loaded."),
        data:
          previous.key === key && previous.data
            ? {
                ...previous.data,
                roles: previous.data.roles.map((role) => ({
                  ...role,
                  containers: role.containers.map((replica) => ({
                    ...replica,
                    status: "unknown",
                    restartCount: null,
                  })),
                })),
              }
            : null,
      }));
    } finally {
      if (request === revision.current) inFlight.current = false;
    }
  }, [key, enabled, deploymentId, projectId]);
  useEffect(() => {
    void refresh();
    const timer =
      enabled && deploymentId
        ? window.setInterval(() => {
            if (document.visibilityState === "visible" && !inFlight.current) void refresh();
          }, 15_000)
        : null;
    return () => {
      revision.current += 1;
      if (timer !== null) window.clearInterval(timer);
    };
  }, [refresh, enabled, deploymentId]);
  const current = state.key === key ? state : null;
  return {
    data: current?.data ?? null,
    roles: current?.data?.roles ?? [],
    loading: current?.loading ?? Boolean(enabled && deploymentId),
    error: current?.error ?? null,
    deploymentId: current?.data?.deploymentId ?? null,
    refresh,
  };
}
