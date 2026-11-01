"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ClusterVolume, ClusterVolumeBackup, ClusterVolumeSnapshot } from "@repo/core";
import { useRunEvents } from "@/hooks/useRunEvents";
import { clusterVolumesApi } from "@/lib/api/cluster-storage";

export function useClusterVolumes(projectId: string, enabled: boolean) {
  const [volumes, setVolumes] = useState<ClusterVolume[]>([]);
  const [backups, setBackups] = useState<ClusterVolumeBackup[]>([]);
  const identity = `${projectId}:${enabled}`;
  const current = useRef(identity);
  current.current = identity;
  const receive = useCallback((snapshot: ClusterVolumeSnapshot) => {
    if (
      !Array.isArray(snapshot.volumes) ||
      !Array.isArray(snapshot.backups) ||
      snapshot.volumes.some((row) => !row.name || !row.resourceVersion)
    )
      throw new Error("Invalid shared storage snapshot");
    setVolumes(snapshot.volumes);
    setBackups(snapshot.backups);
  }, []);
  useEffect(() => {
    setVolumes([]);
    setBackups([]);
  }, [projectId, enabled]);
  const stream = useRunEvents<ClusterVolumeSnapshot>(
    enabled ? `projects/${encodeURIComponent(projectId)}/cluster/volumes/stream` : null,
    receive,
  );
  const refresh = useCallback(async () => {
    if (enabled) {
      const [volumes, backups] = await Promise.all([
        clusterVolumesApi.list(projectId),
        clusterVolumesApi.backups(projectId),
      ]);
      if (current.current === identity) receive({ volumes, backups });
    }
  }, [enabled, projectId, identity, receive]);
  const update = useCallback(
    (volume: ClusterVolume) =>
      setVolumes((rows) => [...rows.filter((row) => row.name !== volume.name), volume]),
    [],
  );
  return { volumes, backups, update, refresh, stream };
}
