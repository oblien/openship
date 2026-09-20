/**
 * The one place a project's vercel.json is compiled into the fields a `registerRoute`
 * call must carry.
 *
 * It exists because `registerRoute` REPLACES the whole vhost file: a caller that omits
 * these does not leave them alone, it DELETES them. That is what made the feature
 * invisible in practice — the fields were built inline in only two places (the per-domain
 * live path and the composite monorepo path), so a plain deploy neither applied a
 * project's `cleanUrls`/`redirects`/`headers` nor preserved them, and an unrelated
 * redeploy silently wiped whatever a "Retry routing" had installed.
 *
 * Deliberately a PURE module with no platform/runtime imports: `route-apply.service` is
 * routinely `vi.mock`ed to keep side effects out of tests, and a pure compile step living
 * there would be mocked away with it.
 */

import { compileVercelRouting } from "@repo/adapters";
import type { RoutingConfig } from "@repo/core";

import type { RouteRegister } from "./route-apply.service";

/** The compiled vercel.json fields a `RouteRegister` carries, and nothing else. */
export type CompiledRoutingFields = Pick<
  RouteRegister,
  "proxyLocations" | "redirects" | "headerRules" | "cleanUrls" | "trailingSlash"
>;

/**
 * Compile a project's routing config into spreadable `RouteRegister` fields.
 *
 * Deliberately NO `backendTargetUrl`: which upstream a path rewrite (`/api/(.*)` →
 * `/api/index.js`, a function on Vercel) belongs to is a TOPOLOGY question a single
 * register site cannot answer — passing the domain's own upstream would, on a composite
 * monorepo, point `/api/` at the FRONTEND. The composite path compiles its own with the
 * backend it resolved; everything else gets the topology-free subset, which is why a
 * full-URL rewrite still works here and a path rewrite is reported as skipped.
 *
 * `onSkipped` reports the rules that did NOT make it into the returned fields, so a
 * refused rule is visible instead of vanishing. Wire it ONLY where no topology-aware
 * pass follows: because we compile with no backend, the list includes "no backend to
 * proxy to" for every path rewrite, which is a FALSE report anywhere the composite
 * planner runs afterwards and resolves those same rewrites against a real backend
 * (`buildCompositeRegistration` logs its own, accurate, list).
 */
export function compileProjectRoutingFields(
  routingConfig: RoutingConfig | null | undefined,
  onSkipped?: (note: string) => void,
): CompiledRoutingFields {
  if (!routingConfig) return {};
  const compiled = compileVercelRouting(routingConfig);
  if (onSkipped) for (const note of compiled.skipped) onSkipped(note);
  return {
    ...(compiled.proxyLocations.length ? { proxyLocations: compiled.proxyLocations } : {}),
    ...(compiled.redirects.length ? { redirects: compiled.redirects } : {}),
    ...(compiled.headerRules.length ? { headerRules: compiled.headerRules } : {}),
    ...(compiled.cleanUrls ? { cleanUrls: true } : {}),
    ...(compiled.trailingSlash === undefined ? {} : { trailingSlash: compiled.trailingSlash }),
  };
}
