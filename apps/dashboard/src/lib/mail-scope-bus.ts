/**
 * Shared revision so the /emails page can tell the mail rail its registry
 * changed — an install finishing, a server adopted, a server forgotten.
 *
 * Same shape as sidebar-nav-counts. Without it the rail would keep showing
 * "Set up mail" after an install completed until the next full page load, which
 * reads as the install having failed.
 */

let revision = 0;
const listeners = new Set<() => void>();

export function getMailScopeRevision(): number {
  return revision;
}

export function invalidateMailScope(): void {
  revision += 1;
  listeners.forEach((cb) => cb());
}

export function subscribeMailScope(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
