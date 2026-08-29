import type { Service } from "@/lib/api";

export interface ServicesFetchState {
  services: Service[];
  isLoading: boolean;
  error: string | null;
}

/**
 * Whether a services read has anything on screen worth keeping cannot be read off
 * the list — it depends on whether that list belongs to the id being fetched.
 * `beginFetchState` owns the full reasoning (and the infinite-loop regression it
 * exists to prevent); this is the same rule for the services slice, whose shape is
 * `services`, not `data`.
 *
 * Same id is a REFRESH: keep the rows, report no loading — flipping it collapsed
 * the tab into its skeleton on every action and tab switch (#666).
 * Different id is a NAVIGATION: there is nothing of this project's to show, and
 * calling it loaded would render project A's services under project B.
 */
export function beginServicesFetch(
  prev: ServicesFetchState,
  loadedId: string | null,
  id: string,
): ServicesFetchState {
  return { ...prev, isLoading: loadedId !== id, error: null };
}

/** A failed REFRESH keeps its rows; a failed NAVIGATION must not leave the previous project's. */
export function failServicesFetch(
  prev: ServicesFetchState,
  loadedId: string | null,
  id: string,
): ServicesFetchState {
  return {
    services: loadedId === id ? prev.services : [],
    isLoading: false,
    error: "Failed to load services",
  };
}
