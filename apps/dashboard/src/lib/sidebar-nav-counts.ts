/** Shared revision so project create/delete can refresh Sidebar Projects/Apps counts. */

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
