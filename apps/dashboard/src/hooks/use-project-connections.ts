"use client";

import { useCallback, useEffect, useState } from "react";
import { CONNECTIONS_CHANGED, connectionsApi, type ProjectConnection, type ConnectionConsumer } from "@/lib/api/connections";

/** Keep the owner and consumer cards in sync after either connection entry point. */
export function useProjectConnections(projectId: string): ProjectConnection[] | null;
export function useProjectConnections(projectId: string, direction: "consumers"): ConnectionConsumer[] | null;
export function useProjectConnections(projectId: string, direction: "connections" | "consumers" = "connections") {
  const [result, setResult] = useState<{ projectId: string; rows: ProjectConnection[] | ConnectionConsumer[] } | null>(null);
  const load = useCallback(() => direction === "consumers" ? connectionsApi.consumers(projectId) : connectionsApi.list(projectId), [projectId, direction]);
  useEffect(() => {
    let active = true;
    let revision = 0;
    const refresh = () => {
      const current = ++revision;
      load().then(response => {
        if (active && current === revision) setResult({ projectId, rows: response.data ?? [] });
      }).catch(() => { if (active && current === revision) setResult({ projectId, rows: [] }); });
    };
    refresh();
    window.addEventListener(CONNECTIONS_CHANGED, refresh);
    return () => { active = false; window.removeEventListener(CONNECTIONS_CHANGED, refresh); };
  }, [projectId, load]);
  return result?.projectId === projectId ? result.rows : null;
}
