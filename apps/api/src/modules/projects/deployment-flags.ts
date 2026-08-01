/**
 * Pure predicates over a deployment row: "does this project need someone's
 * attention, and why?".
 *
 * A LEAF module by design — no repos, no services, no imports beyond the row
 * type. Two very different consumers need the same answers (the project read
 * payload that drives the status badge, and the pending-actions aggregator that
 * lists what to do about it), and they must not be allowed to disagree. They
 * briefly did: two copies of the routing test differed on an empty-string
 * `deployWarning` — `typeof x === "string"` is true for `""` while a truthiness
 * check is not — so a project could show "Action Required" alongside an empty
 * list of actions.
 *
 * Keeping this dependency-free is what makes sharing practical: the predicates
 * used to live in `project-crud.service`, whose import graph reaches auth and the
 * DB schema, so importing one function from it pulled all of that along.
 */

import type { Deployment } from "@repo/db";

/**
 * Is this deploy still moving?
 *
 * Mirrors the codebase's one settled status vocabulary — `["queued", "building",
 * "deploying"]` — which the DB's one-in-flight-per-project unique index
 * (`schema/deployment.ts`), three repo queries, and the delete/cancel guards all
 * spell out inline. This is a NAMED mirror of that, not a new definition.
 *
 * Deliberately expressed as "in flight" rather than as its complement: the
 * various "terminal"/"settled" lists across the codebase genuinely differ by
 * purpose (the SSE layer knows only ready/failed/cancelled; the migration waiter
 * omits `rejected`; the install wizards treat `ready` separately), so there is no
 * single settled set to share, and inventing one would add a fourth notion of
 * terminal rather than reconciling the existing three.
 */
export const IN_FLIGHT_DEPLOY_STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "building",
  "deploying",
]);

export function deploymentIsInFlight(dep: Deployment | null | undefined): boolean {
  return dep != null && IN_FLIGHT_DEPLOY_STATUSES.has(dep.status);
}

/**
 * Is this deployment blocked on a named, clearable cause? `action_required` is
 * written only for such a failure — see the deployments module's
 * `blocking-errors`.
 *
 * Callers pass the LATEST deployment, not the active one: a blocked deploy never
 * advances `activeDeploymentId`, so anything derived from the active deployment
 * is structurally unable to see it.
 */
export function deploymentIsBlocked(dep: Deployment | null | undefined): boolean {
  return dep?.status === "action_required";
}

/**
 * Did this release deploy, but fail to sync its edge route? The app may be
 * running while its public URL doesn't resolve.
 *
 * `deployWarning` being a string AT ALL counts, empty included — that is the
 * existing contract the project card has always used, and the retry affordance it
 * drives is harmless when the warning text is blank.
 */
export function deploymentRoutingUnsynced(dep: Deployment | null | undefined): boolean {
  const meta = (dep?.meta ?? null) as { edgeUnsynced?: boolean; deployWarning?: string } | null;
  return meta?.edgeUnsynced === true || typeof meta?.deployWarning === "string";
}
