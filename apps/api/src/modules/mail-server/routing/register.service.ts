/**
 * Mail-server route registration - wires the route plan (built in @repo/core)
 * into openship's existing routing provider (NginxProvider / OpenResty /
 * Cloud, whichever is active on the deploy target).
 *
 * This is the I/O half of the routing module - the pure half lives in
 * `@repo/core/mail-server/routing` (types + `buildMailServerRoutes`). Keep
 * platform calls inside this file only; everything else should be testable
 * without booting the platform.
 *
 * Symmetric API:
 *   - `registerMailServerRoutes(input)` - register every HTTP route
 *   - `removeMailServerRoutes(input)`   - unregister every HTTP route
 *   - `rotateMailServerRoutes(prev, next)` - migrate from one input to another
 *
 * DNS records are NOT touched here. The caller takes `plan.dns` and either
 * surfaces it to the dashboard for manual publication or feeds it into a
 * future DNS-provider integration.
 *
 * Failure model:
 *   - Each route registration is best-effort isolated; one failure doesn't
 *     short-circuit the rest. Caller receives a per-route result list.
 *   - On `removeMailServerRoutes`, we always attempt all removals - even
 *     if some fail - to avoid leaving half-routed state behind.
 */

import {
  buildMailServerRoutes,
  type MailRoute,
  type MailServerRouteInput,
  type MailServerRoutePlan,
  safeErrorMessage,
} from "@repo/core";
import { platform } from "../../../lib/controller-helpers";

export interface RouteRegistrationResult {
  routeId: MailRoute["id"];
  hostname: string;
  ok: boolean;
  error?: string;
}

export interface MailServerRouteRegistration {
  plan: MailServerRoutePlan;
  routes: RouteRegistrationResult[];
}

/**
 * Build the plan from `input` and register each HTTP route with openship's
 * active routing provider. Returns the plan (for the caller to surface DNS
 * records to the UI) + a per-route registration result.
 */
export async function registerMailServerRoutes(
  input: MailServerRouteInput,
): Promise<MailServerRouteRegistration> {
  const plan = buildMailServerRoutes(input);
  const { routing } = platform();

  const results: RouteRegistrationResult[] = [];
  for (const route of plan.routes) {
    try {
      await routing.registerRoute({
        domain: route.hostname,
        tls: route.tls,
        // Mail routes are the operator's own hostnames on this box, so their TLS is
        // ours: keep a :443 listener up from the start rather than refusing the
        // handshake until a cert lands (Cloudflare 525, #308).
        terminatesTlsLocally: route.tls,
        targetUrl: route.targetUrl,
      });
      results.push({ routeId: route.id, hostname: route.hostname, ok: true });
    } catch (err) {
      results.push({
        routeId: route.id,
        hostname: route.hostname,
        ok: false,
        error: safeErrorMessage(err),
      });
    }
  }

  return { plan, routes: results };
}

/**
 * Unregister every HTTP route in the plan. Best-effort: attempts every removal
 * even on intermediate failures. Used when deprovisioning a mail server or
 * migrating to a new VPS.
 */
export async function removeMailServerRoutes(
  input: MailServerRouteInput,
): Promise<MailServerRouteRegistration> {
  const plan = buildMailServerRoutes(input);
  const { routing } = platform();

  const results: RouteRegistrationResult[] = [];
  for (const route of plan.routes) {
    try {
      await routing.removeRoute(route.hostname);
      results.push({ routeId: route.id, hostname: route.hostname, ok: true });
    } catch (err) {
      results.push({
        routeId: route.id,
        hostname: route.hostname,
        ok: false,
        error: safeErrorMessage(err),
      });
    }
  }

  return { plan, routes: results };
}

/**
 * Re-register routes after an input change (e.g. mail VPS IP migration,
 * Zero server moved to a new host). For simplicity we always remove +
 * re-register all four routes - the set is small and routing providers
 * handle idempotent updates fine. Swap to a true diff if a provider grows
 * expensive per-route ops.
 */
export async function rotateMailServerRoutes(
  previousInput: MailServerRouteInput,
  nextInput: MailServerRouteInput,
): Promise<{
  removed: MailServerRouteRegistration;
  registered: MailServerRouteRegistration;
}> {
  const removed = await removeMailServerRoutes(previousInput);
  const registered = await registerMailServerRoutes(nextInput);
  return { removed, registered };
}
