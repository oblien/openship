"use client";

import { observedAllSettled } from "@repo/core/diagnostics";
import { useCallback, useEffect, useRef, useState } from "react";
import { getApiErrorMessage } from "@/lib/api/client";
import { servicesApi, type ServiceContainer } from "@/lib/api/services";
import { CONNECTIONS_CHANGED, connectionsApi, type ProjectConnection } from "@/lib/api/connections";
import type { ProjectCluster } from "@repo/contracts";
import { projectClusterApi } from "@/lib/api/project-cluster";
import { useRuntimeRoles } from "@/hooks/useRuntimeRoles";

/** Status and bindings are refreshed separately from the shared service definitions. */
export function useTopologyData(
  projectId: string,
  refreshServices: () => Promise<unknown>,
  deployed: boolean,
  clusterTarget = false,
  activeDeploymentId?: string | null,
) {
  const roles = useRuntimeRoles(projectId, activeDeploymentId, deployed && !clusterTarget);
  const [containers, setContainers] = useState<ServiceContainer[] | null>(null);
  const [connections, setConnections] = useState<ProjectConnection[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(false);
  const [cluster, setCluster] = useState<ProjectCluster | null>(null);
  const request = useRef(0);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    const revision = ++request.current;
    inFlight.current = true;
    setLoading(true);
    const results = await observedAllSettled([
      deployed && !clusterTarget
        ? servicesApi.containers(projectId)
        : Promise.resolve({ success: true, containers: [] as ServiceContainer[] }),
      connectionsApi.list(projectId),
      refreshServices(),
      clusterTarget ? projectClusterApi.get(projectId) : Promise.resolve(null),
    ], "dashboard/components/topology/useTopologyData");
    if (revision !== request.current) return;
    const problems: string[] = [];
    const runtime = results[0];
    if (runtime.status === "fulfilled" && runtime.value.success !== false) {
      setContainers(runtime.value.containers);
    } else {
      setContainers(null);
      problems.push(
        getApiErrorMessage(
          runtime.status === "rejected" ? runtime.reason : undefined,
          "Runtime status could not be loaded.",
        ),
      );
    }
    const bindings = results[1];
    if (bindings.status === "fulfilled") setConnections(bindings.value.data);
    else problems.push(getApiErrorMessage(bindings.reason, "Connections could not be loaded."));
    if (results[2].status === "rejected")
      problems.push(getApiErrorMessage(results[2].reason, "Services could not be loaded."));
    const workload = results[3];
    if (workload.status === "fulfilled") {
      setCluster(workload.value);
      if (workload.value?.error) problems.push(workload.value.error);
    } else {
      setCluster(null);
      problems.push(getApiErrorMessage(workload.reason, "Cluster status could not be loaded."));
    }
    setErrors(problems);
    setLoading(false);
    setReady(true);
    inFlight.current = false;
  }, [projectId, refreshServices, deployed, clusterTarget, activeDeploymentId]);

  useEffect(() => {
    void refresh();
    const timer = clusterTarget
      ? null
      : window.setInterval(() => {
          if (document.visibilityState === "visible" && !inFlight.current) void refresh();
        }, 15_000);
    const changed = () => {
      void refresh();
    };
    window.addEventListener(CONNECTIONS_CHANGED, changed);
    return () => {
      request.current += 1;
      if (timer !== null) window.clearInterval(timer);
      window.removeEventListener(CONNECTIONS_CHANGED, changed);
    };
  }, [refresh, clusterTarget]);
  const refreshAll = useCallback(
    () => Promise.all([refresh(), roles.refresh()]),
    [refresh, roles.refresh],
  );
  return {
    containers,
    connections,
    errors: [...errors, ...(roles.error ? [roles.error] : [])],
    loading: loading || roles.loading,
    ready,
    refresh: refreshAll,
    cluster,
    setCluster,
    roles: roles.data,
  };
}
