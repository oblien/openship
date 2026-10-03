/** Shared revision so project create/delete can refresh Sidebar Projects/Apps counts. */

/** Both lists use the same project records; catalog apps have their own navigation. */
export function countProjectCollections(rows: ReadonlyArray<{ id: string; isApp?: boolean | null }>) {
  const ids = new Set<string>();
  const appIds = new Set<string>();
  for (const row of rows) {
    if (ids.has(row.id)) continue;
    ids.add(row.id);
    if (row.isApp) appIds.add(row.id);
  }
  return { projects: ids.size - appIds.size, apps: appIds.size, appIds };
}

let revision = 0;
const listeners = new Set<() => void>();

export function getSidebarNavCountsRevision(): number {
  return revision;
}

export function invalidateSidebarNavCounts(): void {
  revision += 1;
  listeners.forEach((cb) => cb());
}

export function subscribeSidebarNavCounts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
