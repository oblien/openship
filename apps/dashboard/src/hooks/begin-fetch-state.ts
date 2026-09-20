/**
 * The state a project endpoint enters when a fetch STARTS.
 *
 * One line of `useEndpoint`, extracted because getting it wrong cost an infinite render loop
 * and it is the kind of decision no typecheck can hold.
 *
 * `invalidateProjectCaches(id)` drops the cached entry and bumps a revision counter, which
 * re-runs the fetch effect for every mounted consumer. The documented purpose of that mechanism
 * is to refresh a mounted view IN PLACE. Reporting `isLoading: true` while doing it defeats
 * exactly that, because the project page renders a full-page skeleton whenever its info read is
 * loading — so every invalidation unmounted the page's whole subtree and remounted it when the
 * response landed.
 *
 * That made any "refresh after something changed" a remount, and for a component whose own mount
 * triggers such a refresh (the migration panel, publishing its run's phase) an infinite loop:
 * invalidate → skeleton → unmount → remount → invalidate. Every guard against it lived in state
 * the unmount destroyed.
 *
 * So: a fetch reports loading only when there is nothing on screen to keep. Which of the two it
 * is cannot be read off the data — it depends on whether the data belongs to the id being
 * fetched. Same id is a REFRESH (keep showing it); a different one is a NAVIGATION, and calling
 * that "loaded" would render project A's page under project B's URL.
 */
export type FetchState<T> = { data: T | null; isLoading: boolean; error: string | null };

export function beginFetchState<T>(
  prev: FetchState<T>,
  /** The id whose data `prev` holds, or null if it holds none. */
  loadedId: string | null,
  /** The id now being fetched. */
  id: string,
): FetchState<T> {
  const revalidating = loadedId === id;
  // The error clears either way: a fetch is in flight, so the previous failure is no longer
  // the current state of things.
  return revalidating ? { ...prev, error: null } : { ...prev, isLoading: true, error: null };
}
