/** Docker /system/df's writable layers and named volumes are application data.
 * Image layers, build cache and the OS are shared; never add them per project.
 * This consumes the sized disk-usage response, not an unsized container list. */
export interface DockerStorageSnapshot {
  Containers?: Array<{
    SizeRw?: number;
    Labels?: Record<string, string>;
    Mounts?: Array<{ Type?: string; Name?: string }>;
  }>;
  Volumes?: Array<{ Name: string; Labels?: Record<string, string>; UsageData?: { Size?: number } }>;
}

export function dockerProjectStorage(
  snapshot: DockerStorageSnapshot,
  projects: Array<{ id: string; slug?: string | null }>,
) {
  const bytes = new Map<string, number | null>(projects.map((project) => [project.id, 0]));
  const owners = new Map<string, Set<string>>();
  const add = (id: string, value: number | undefined) => {
    if (!bytes.has(id) || bytes.get(id) === null) return;
    bytes.set(
      id,
      typeof value === "number" && Number.isFinite(value) && value >= 0
        ? bytes.get(id)! + value
        : null,
    );
  };
  for (const container of snapshot.Containers ?? []) {
    const id = container.Labels?.["openship.project"];
    if (!id || !bytes.has(id)) continue;
    // Engines using an omitempty integer omit SizeRw for an empty writable
    // layer. /system/df still measured it; negative sizes remain unavailable.
    add(id, container.SizeRw === undefined ? 0 : container.SizeRw);
    for (const mount of container.Mounts ?? [])
      if (mount.Type === "volume" && mount.Name) {
        const set = owners.get(mount.Name) ?? new Set<string>();
        set.add(id);
        owners.set(mount.Name, set);
      }
  }
  for (const volume of snapshot.Volumes ?? []) {
    const attached = owners.get(volume.Name);
    // If users explicitly share a volume, account for it with shared storage.
    if (attached && attached.size > 1) continue;
    const id = attached?.values().next().value ?? volume.Labels?.["openship.project"];
    if (id) add(id, volume.UsageData?.Size);
  }
  return projects.map((project) => ({ id: project.id, bytes: bytes.get(project.id) ?? null }));
}
