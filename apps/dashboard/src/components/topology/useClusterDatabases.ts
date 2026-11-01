"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ClusterDatabase } from "@repo/contracts";
import { useRunEvents } from "@/hooks/useRunEvents";
import { clusterDatabasesApi } from "@/lib/api/cluster-databases";
export function useClusterDatabases(projectId: string, enabled: boolean) {
  const [databases, setDatabases] = useState<ClusterDatabase[]>([]);
  const identity = `${projectId}:${enabled}`;
  const current = useRef(identity);
  current.current = identity;
  const receive = useCallback(
    (rows: ClusterDatabase[]) => {
      if (current.current !== identity || !enabled) return;
      if (!Array.isArray(rows) || rows.some((row) => row.projectId !== projectId))
        throw new Error("Invalid project database snapshot");
      setDatabases((old) =>
        rows.map((row) => {
          const previous = old.find((item) => item.id === row.id);
          return previous && previous.sequence > row.sequence ? previous : row;
        }),
      );
    },
    [projectId, identity, enabled],
  );
  const update = useCallback(
    (row: ClusterDatabase) => {
      if (current.current !== identity || !enabled || row.projectId !== projectId) return;
      setDatabases((old) => {
        const previous = old.find((item) => item.id === row.id);
        if (previous && previous.sequence > row.sequence) return old;
        const next = old.filter((item) => item.id !== row.id);
        if (row.status !== "deleted") next.push(row);
        return next;
      });
    },
    [projectId, identity, enabled],
  );
  useEffect(() => {
    setDatabases([]);
  }, [projectId, enabled]);
  const stream = useRunEvents<ClusterDatabase[]>(
    enabled ? `projects/${encodeURIComponent(projectId)}/cluster/databases/stream` : null,
    receive,
  );
  const refresh = useCallback(async () => {
    if (enabled) receive(await clusterDatabasesApi.list(projectId));
  }, [enabled, projectId, receive]);
  return { databases, update, refresh, stream };
}
