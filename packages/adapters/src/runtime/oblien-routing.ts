/**
 * Compile a normalized `RoutingConfig` (parsed from vercel.json) into the Oblien
 * `routes.set` payload — the CLOUD counterpart to `compileVercelRouting` →
 * OpenResty for self-hosted. Reuses `compileVercelRouting` for all parsing +
 * injection-sanitization, then maps its structured result to Oblien's rule shape
 * (`client.routes.set(hostname, RoutesInput)`), so both emitters share one source
 * of truth and one set of safety guards.
 *
 * `routes.set` ATOMICALLY REPLACES a hostname's entire edge behavior, so the
 * payload must be a COMPLETE table — what backs `/` (a static Page or a root
 * workspace) plus every override. The context says which topology backs `/`;
 * without it we'd emit a partial table that takes the site down. Pure — no I/O —
 * so it's unit-testable without the SDK/network.
 */

import type { RoutesInput, RouteRule, RouteProxyAction } from "oblien";
import type { RoutingConfig } from "@repo/core";
import { compileVercelRouting } from "../infra/vercel-routing";

/** Sentinel so reused `compileVercelRouting` marks which proxy targets are the
 *  owned backend (→ Oblien `workspace`+`port`) vs. a literal external URL. */
const BACKEND_SENTINEL = "oblien-backend://self";

/** An owned Oblien workspace to reverse-proxy to. */
export interface OblienWorkspaceTarget {
  workspace: string;
  port: number;
}

export interface OblienRoutingContext {
  /** Static Page slug backing `/` (CDN + SPA fallback). The Vercel-parity shape:
   *  static frontend on a Page, backend proxied at rewrite prefixes. */
  staticPage?: string;
  /** Workspace backing `/` when the frontend runs as a container instead of a
   *  Page (a catch-all `/` proxy is appended last). Mutually exclusive with
   *  `staticPage`. Also the server-only shape: set `root`, omit `backend`. */
  root?: OblienWorkspaceTarget;
  /** Backend workspace that path rewrites (e.g. `/api/*`) proxy to. */
  backend?: OblienWorkspaceTarget;
}

/** Oblien only accepts 301/302/307/308; coerce anything else to a safe default
 *  (permanent → 308, everything else → temporary 307). */
function toOblienRedirectStatus(code: number): 301 | 302 | 307 | 308 {
  if (code === 301 || code === 302 || code === 307 || code === 308) return code;
  return code === 301 || code === 308 ? 308 : 307;
}

export function compileRoutingToOblien(
  routing: RoutingConfig,
  ctx: OblienRoutingContext = {},
): RoutesInput {
  const compiled = compileVercelRouting(routing, {
    backendTargetUrl: ctx.backend ? BACKEND_SENTINEL : undefined,
  });

  const routes: RouteRule[] = [];

  // Terminal rules are first-match-wins, evaluated before static files; order
  // them Vercel-style: redirects → rewrites(proxies) → catch-all. Headers are
  // non-terminal and appended last.

  for (const r of compiled.redirects) {
    routes.push({
      match: { path: r.path, type: r.exact ? "exact" : "prefix" },
      action: { kind: "redirect", status: toOblienRedirectStatus(r.statusCode), to: r.destination },
    });
  }

  // rewrites → proxy. A sentinel target means "the owned backend" → workspace+port
  // (Oblien resolves its internal IP); any other target is a literal external URL.
  for (const loc of compiled.proxyLocations) {
    const action: RouteProxyAction =
      loc.targetUrl === BACKEND_SENTINEL && ctx.backend
        ? { kind: "proxy", workspace: ctx.backend.workspace, port: ctx.backend.port }
        : { kind: "proxy", origin: loc.targetUrl };
    routes.push({ match: { path: loc.pathPrefix, type: "prefix" }, action });
  }

  // A root workspace backs `/` as the last terminal rule (a Page backs it via
  // `static` + SPA fallback instead, so no catch-all proxy in that case).
  if (ctx.root) {
    routes.push({
      match: { path: "/", type: "prefix" },
      action: { kind: "proxy", workspace: ctx.root.workspace, port: ctx.root.port },
    });
  }

  for (const h of compiled.headerRules) {
    routes.push({
      match: { path: h.path, type: "prefix" },
      action: { kind: "headers", set: h.headers },
    });
  }

  const input: RoutesInput = { routes };
  if (ctx.staticPage) input.static = { page: ctx.staticPage };
  if (compiled.cleanUrls) input.cleanUrls = true;
  // vercel `trailingSlash` is a boolean; Oblien wants a policy. true → enforce,
  // explicit false → strip, omitted → leave default.
  if (routing.trailingSlash === true) input.trailingSlash = "enforce";
  else if (routing.trailingSlash === false) input.trailingSlash = "strip";

  return input;
}
