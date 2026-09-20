/** HTTP parameter/mode adapters. Resource policy lives in the platform engine. */
import type { Context } from "hono";
import { env } from "@repo/platform/engine/config/env";
import { resolvePlatformConfig } from "@repo/platform/engine/lib/platform-config";
export { platform, resolvePlatformConfig } from "@repo/platform/engine/lib/platform-config";
export * from "@repo/platform/engine/lib/resource-access";

/** Extract and validate a required route parameter */
export function param(c: Context, name: string): string {
  const val = c.req.param(name);
  if (!val) throw new Error(`Missing route param: ${name}`);
  return val;
}

/**
 * Local-only route guard. Returns a 404 Response when CLOUD_MODE is on,
 * or `null` when the route may proceed.
 *
 * Use at the top of self-hosted-only handlers:
 *
 *   export async function handler(c: Context) {
 *     const guard = assertNotCloud(c);
 *     if (guard) return guard;
 *     // ... cloud-impossible work ...
 *   }
 *
 * This is defense-in-depth on top of routing-level gates — even if a
 * route ever gets mounted in cloud mode by mistake, the handler refuses
 * to execute the cloud-impossible code path.
 */
export function assertNotCloud(c: Context): Response | null {
  if (env.CLOUD_MODE) {
    return c.json({ error: "Not available in cloud mode" }, 404);
  }
  return null;
}

/**
 * Desktop-only route guard. Returns a 404 Response unless the platform target
 * resolves to "desktop", or `null` when the route may proceed.
 *
 * Pairs with `localOnly` for desktop-exclusive features (e.g. SSH port-forward
 * tunnels): `localOnly` keeps them out of SaaS, this also keeps them out of a
 * self-hosted VPS — where forwarding a remote port to "localhost" is
 * meaningless. Defense-in-depth on top of routing-level gates.
 */
export function assertDesktop(c: Context): Response | null {
  if (resolvePlatformConfig().target !== "desktop") {
    return c.json({ error: "Not available in this mode" }, 404);
  }
  return null;
}
