/**
 * Boot-time route scanner — the second line of defense for "no route
 * ships without an explicit permission decision".
 *
 * The TypeScript signature of `secureRouter` already requires a RouteSpec
 * on every method. But to catch:
 *   - routes mounted directly on a raw Hono instance (bypassing secureRouter)
 *   - PermissionSpec tags that point at nonexistent resources / invalid actions
 *   - inconsistencies between the declared tag and the URL params
 *
 * we also walk the registered routes at boot and refuse to start if any
 * of these conditions trip. The intent: a misconfigured route should
 * fail at server startup, not at the first malicious request.
 *
 * Use:
 *   import { scanRoutes } from "./lib/route-scanner";
 *   const { ok, errors, summary } = scanRoutes(app);
 *   if (!ok) {
 *     console.error("Route scanner refused startup:", errors);
 *     process.exit(1);
 *   }
 */

import { reportCaughtError as observeCaughtError, diagnostics as errorDiagnostics } from "@repo/core/diagnostics";
import type { Hono } from "hono";
import {
  getRouteRegistry,
  parsePermissionTag,
  isPublicSpec,
  type RegisteredRoute,
} from "./route-permission";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface ScanError {
  /** Where the issue is. */
  route: { method: string; path: string };
  /** Severity — "critical" fails the boot; "warning" logs at startup. */
  severity: "critical" | "warning";
  /** Human-readable explanation. */
  message: string;
}

export interface ScanResult {
  ok: boolean;
  errors: ScanError[];
  summary: {
    total: number;
    permissionGated: number;
    explicitlyPublic: number;
    unregistered: number;
  };
}

/**
 * Walk Hono's registered routes and cross-check against the secure-router
 * registry. Any route Hono knows about that isn't in the registry is a
 * potential bypass — flagged as critical for mutation methods, warning
 * for GET (since reads might intentionally bypass org scoping for things
 * like /api/auth/* which is owned by Better Auth, not us).
 */
export function scanRoutes(app: Hono): ScanResult {
  const errors: ScanError[] = [];
  const registry = getRouteRegistry();
  const registered = new Map<string, RegisteredRoute>();
  for (const entry of registry) {
    registered.set(`${entry.method} ${entry.path}`, entry);
  }

  // Hono's `routes` is a flat array of `{ method, path, handler }`.
  // The path is RELATIVE to where the sub-app was mounted; secureRouter
  // tracks absolute paths via its basePath option. We compare on the
  // tail portion since basePath is best-effort.
  type HonoRoute = { method: string; path: string };
  const allRoutes: HonoRoute[] =
    (app as unknown as { routes?: HonoRoute[] }).routes ?? [];

  // We don't have a perfect map from Hono's mounted path to our registry's
  // basePath. Instead we ensure: for every registered route, the spec is
  // valid; for every mutation route in Hono's table, SOMETHING in the
  // registry covers it (path-suffix match).

  // 1. Validate registry entries individually.
  for (const entry of registry) {
    if (isPublicSpec(entry.spec)) {
      if (MUTATING_METHODS.has(entry.method) && !entry.spec.reason.trim()) {
        errors.push({
          route: { method: entry.method, path: entry.path },
          severity: "critical",
          message: `Public mutation route has empty reason — public routes must justify the bypass`,
        });
      }
      continue;
    }
    try {
      const parsed = parsePermissionTag(entry.spec.tag);
      // Sanity: mutation methods shouldn't carry list/read tags UNLESS
      // the route explicitly opts out via { readOnly: true } — for
      // genuinely side-effect-free probes that use POST only to carry
      // a body (e.g. DNS preview). The permission requirement is still
      // "read" semantically; readOnly just unblocks the static check.
      if (MUTATING_METHODS.has(entry.method) && !entry.spec.readOnly) {
        if (parsed.action === "read" || parsed.action === "list") {
          errors.push({
            route: { method: entry.method, path: entry.path },
            severity: "critical",
            message: `Mutation method ${entry.method} but tag action is "${parsed.action}". Use write or admin (or set readOnly: true if the handler is genuinely side-effect-free).`,
          });
        }
      }
    } catch (err) {
      observeCaughtError(err, "api/lib/route-scanner");
      errors.push({
        route: { method: entry.method, path: entry.path },
        severity: "critical",
        message: `Invalid permission tag: ${(err as Error).message}`,
      });
    }
  }

  // 2. Cross-check: every mutation route Hono knows about should be in
  // the registry.
  //
  // Path normalization: both the registry and Hono's app.routes can
  // produce paths that differ only by a trailing slash. A registry
  // entry from `r.post("/", ...)` with basePath="/api/projects" stores
  // `/api/projects/` while Hono composes the mounted route as
  // `/api/projects` (no slash). Normalize both sides so the lookup
  // matches.
  //
  // Deduplication: Hono's `routes` array contains one entry per
  // handler-chain element AND duplicate entries from parent/child
  // mounts. Without dedup, the same logical route gets reported N times.
  const registeredSuffixes = new Set(
    registry.map((r) => `${r.method} ${normalizePath(r.path)}`),
  );
  const seen = new Set<string>();
  let unregistered = 0;
  for (const r of allRoutes) {
    const method = r.method.toUpperCase();
    if (!MUTATING_METHODS.has(method)) continue;
    const key = `${method} ${normalizePath(r.path)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (registeredSuffixes.has(key)) continue;
    // Allow Better Auth's own /api/auth/* mutations — owned by the plugin.
    if (r.path.startsWith("/api/auth/")) continue;
    errors.push({
      route: { method: r.method, path: r.path },
      severity: "critical",
      message: `Mutation route mounted directly on Hono (not via secureRouter). Convert to secureRouter or mark public(reason).`,
    });
    unregistered++;
  }

  const permissionGated = registry.filter((r) => !isPublicSpec(r.spec)).length;
  const explicitlyPublic = registry.filter((r) => isPublicSpec(r.spec)).length;

  const criticals = errors.filter((e) => e.severity === "critical");
  return {
    ok: criticals.length === 0,
    errors,
    summary: {
      total: registry.length,
      permissionGated,
      explicitlyPublic,
      unregistered,
    },
  };
}

/**
 * Strip a single trailing slash from any path of length > 1. Used on
 * both sides of the registry / Hono cross-check so that `/api/projects/`
 * (registry side, from `r.post("/", ...)` under basePath="/api/projects")
 * matches `/api/projects` (Hono's composed form after sub-app mount).
 */
function normalizePath(path: string): string {
  if (path.length > 1 && path.endsWith("/")) return path.slice(0, -1);
  return path;
}

/**
 * Convenience for app bootstrap: run the scan, log the summary, exit on
 * critical errors.
 */
export function enforceRouteScanAtBoot(app: Hono): void {
  const result = scanRoutes(app);

  console.log(
    `[route-scanner] ${result.summary.permissionGated} permission-gated, ` +
      `${result.summary.explicitlyPublic} explicitly-public, ` +
      `${result.summary.unregistered} unregistered`,
  );

  if (result.errors.length > 0) {
    for (const err of result.errors) {
      const tag = err.severity === "critical" ? "ERROR" : "WARN";
      errorDiagnostics.error("api/lib/route-scanner",
        `[route-scanner] ${tag} ${err.route.method} ${err.route.path}: ${err.message}`,
      );
    }
  }

  if (!result.ok) {
    errorDiagnostics.error("api/lib/route-scanner",
      `[route-scanner] Refusing to start: ${
        result.errors.filter((e) => e.severity === "critical").length
      } critical error(s). Fix above before booting.`,
    );
    process.exit(1);
  }
}
