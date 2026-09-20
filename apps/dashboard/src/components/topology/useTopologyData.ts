"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getApiErrorMessage } from "@/lib/api/client";
import { servicesApi, type ServiceContainer } from "@/lib/api/services";
import { CONNECTIONS_CHANGED, connectionsApi, type ProjectConnection } from "@/lib/api/connections";

/** Status and bindings are refreshed separately from the shared service definitions. */
export function useTopologyData(
  projectId: string,
  refreshServices: () => Promise<unknown>,
  deployed: boolean,
) {
  const [containers, setContainers] = useState<ServiceContainer[] | null>(null);
  const [connections, setConnections] = useState<ProjectConnection[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(false);
  const request = useRef(0);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    const revision = ++request.current;
    inFlight.current = true;
    setLoading(true);
    const results = await Promise.allSettled([
      deployed
        ? servicesApi.containers(projectId)
        : Promise.resolve({ success: true, containers: [] as ServiceContainer[] }),
      connectionsApi.list(projectId),
      refreshServices(),
    ]);
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
    setErrors(problems);
    setLoading(false);
    setReady(true);
    inFlight.current = false;
  }, [projectId, refreshServices, deployed]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible" && !inFlight.current) void refresh();
    }, 15_000);
    const changed = () => {
      void refresh();
    };
    window.addEventListener(CONNECTIONS_CHANGED, changed);
    return () => {
      request.current += 1;
      window.clearInterval(timer);
      window.removeEventListener(CONNECTIONS_CHANGED, changed);
    };
  }, [refresh]);
  return { containers, connections, errors, loading, ready, refresh };
}
