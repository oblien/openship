import { ApiError, getApiErrorMessage } from "@/lib/api/client";
import {
  carryServiceIds,
  normalizeComposeService,
  type ComposeServiceInfo,
  type RawComposeService,
} from "./types";

/**
 * Failure-mode separation for the build page (#604).
 *
 * `loadBuildSession` used to collapse every failure into
 * `{ success: false }`, and the page rendered its one branch for that —
 * `ResourceNotFound` — for ALL of them. So a client-side exception while
 * hydrating a SUCCESSFUL response (the reporter's 3-service `services` deploy
 * hydrating an empty `composeServices`, or any other throw in the ~200-line
 * restore) presented an existing, ready deployment as "not found".
 *
 * That undoes an invariant the backend deliberately establishes
 * (deployment.controller.ts): a genuine miss is a 404, and everything else is
 * surfaced as a 500 precisely so it can't be swallowed as a UI "not found".
 * These helpers restore the distinction on the client.
 */
export interface BuildSessionLoadResult {
  success: boolean;
  /** `true` ONLY when the server itself said the deployment isn't there — a
   *  soft-failed status response or an HTTP 404. Never set for a client-side
   *  hydration exception, a 5xx, or a network failure: those mean "couldn't
   *  load", not "doesn't exist", and a retry can succeed. */
  notFound?: boolean;
  error?: string;
}

export const BUILD_SESSION_ERROR_FALLBACK = "Failed to load build session";

/**
 * Classify a thrown failure from `loadBuildSession`'s catch: only an HTTP 404
 * from the API counts as "the deployment does not exist".
 */
export function classifyBuildSessionFailure(err: unknown): {
  notFound: boolean;
  error: string;
} {
  return {
    notFound: err instanceof ApiError && err.status === 404,
    error: getApiErrorMessage(err, BUILD_SESSION_ERROR_FALLBACK),
  };
}

/**
 * Hydrate `config.services` from the deployment snapshot's `composeServices`.
 *
 * An EMPTY array must not blank an already-populated list: the API ships
 * `composeServices: []` for `projectType: "services"` deployments that report
 * their services through `services`/`serviceStatuses` instead (#604), and the
 * old `Array.isArray(...)` guard happily replaced a 3-service list with `[]`.
 * Empty or absent falls back to what's already loaded — same as the non-array
 * case always did.
 */
export function hydrateSnapshotServices(
  composeServices: unknown,
  prevServices: ComposeServiceInfo[],
): ComposeServiceInfo[] {
  if (!Array.isArray(composeServices) || composeServices.length === 0) {
    return prevServices;
  }
  return carryServiceIds(
    (composeServices as RawComposeService[]).map(normalizeComposeService),
    prevServices,
  );
}
