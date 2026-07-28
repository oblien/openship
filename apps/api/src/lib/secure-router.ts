/**
 * Secure router wrapper — the ONLY supported way to declare HTTP routes.
 *
 * Every method (.get/.post/.put/.patch/.delete) REQUIRES a RouteSpec as
 * its second argument. The spec is either:
 *
 *   { tag: "project:read" }        → permission-protected
 *   { tag: "project:service:edit", ids: { project: "id", service: "serviceId" } }
 *   { public: true, reason: "..." } → explicitly unauthenticated
 *
 * Because the type signature requires the spec, you literally cannot
 * declare a route without classifying it. The boot-time scanner adds a
 * second line of defense: it walks the registry and refuses startup if
 * any route is missing.
 *
 * USAGE:
 *   import { secureRouter } from "../../lib/secure-router";
 *
 *   const r = secureRouter(new Hono(), { module: "projects" });
 *   r.get("/", { tag: "project:list" }, ctrl.list);
 *   r.get("/:id", { tag: "project:read" }, ctrl.getById);
 *   r.delete("/:id", { tag: "project:admin" }, ctrl.remove);
 *   r.public("/healthcheck", { reason: "Load balancer probe" }, ctrl.healthz);
 *
 *   export const projectRoutes = r.hono;
 *
 * Auth is AUTO-INJECTED: every permission-tagged route gets
 * `authMiddleware` mounted ahead of the permission check. Do NOT also
 * call `r.use("*", authMiddleware)` — that would run auth twice per
 * request (DB session lookup on each pass). Opt out with `skipAuth:
 * true` on routes that handle their own auth (e.g. internalAuth shared
 * tokens for Electron).
 *
 * `r.use(...)` is still appropriate for non-auth cross-cutting concerns:
 * `localOnly`, body validation, etc.
 */

import type { Hono, MiddlewareHandler, Handler } from "hono";
import {
  requirePermission,
  publicRoute,
  registerRoute,
  type RouteSpec,
  type PermissionSpec,
  type PublicSpec,
  isPublicSpec,
} from "./route-permission";
import { authMiddleware } from "../middleware/auth";
import { rateLimiterFor } from "../middleware/rate-limiter";
import { localOnly } from "../middleware/local-only";

export interface SecureRouterOptions {
  /**
   * Identifier for this module — used in scanner reports and audit logs.
   * Conventionally the directory name (e.g. "projects", "deployments").
   */
  module: string;
  /**
   * Base path used in scanner reports and registry entries. The actual
   * Hono mount path is set by app.route() in app.ts — this is just for
   * diagnostics. Optional; defaults to "/<module>".
   */
  basePath?: string;
  /**
   * Default resource → URL param name overrides applied to every route
   * declared on this router (unless the per-route spec overrides them).
   * Useful for modules whose URLs consistently use a non-default param
   * name — e.g. mail admin routes use `:serverId` for the mail_server
   * resource: `{ ids: { mail_server: "serverId" } }`.
   */
  ids?: Partial<Record<string, string>>;
}

type MethodName = "get" | "post" | "put" | "patch" | "delete";

export interface SecureRouter<T extends Hono = Hono> {
  /** The underlying Hono instance — pass to app.route() to mount. */
  hono: T;
  use: T["use"];

  get(path: string, spec: RouteSpec, ...handlers: (MiddlewareHandler | Handler)[]): void;
  post(path: string, spec: RouteSpec, ...handlers: (MiddlewareHandler | Handler)[]): void;
  put(path: string, spec: RouteSpec, ...handlers: (MiddlewareHandler | Handler)[]): void;
  patch(path: string, spec: RouteSpec, ...handlers: (MiddlewareHandler | Handler)[]): void;
  delete(path: string, spec: RouteSpec, ...handlers: (MiddlewareHandler | Handler)[]): void;

  /**
   * Convenience for explicitly-public routes. Same as passing
   * `{ public: true, reason }` to .get/.post/etc., but reads clearer.
   * The HTTP method is required as the first argument.
   *
   * `rateLimit` is optional and works the same as on PermissionSpec —
   * pass a policy id to override the global `default-anon` default
   * (e.g. `webhook-ingress` for inbound webhooks).
   */
  public(
    method: MethodName,
    path: string,
    spec: Omit<PublicSpec, "public">,
    ...handlers: (MiddlewareHandler | Handler)[]
  ): void;
}

export function secureRouter<T extends Hono>(
  hono: T,
  options: SecureRouterOptions,
): SecureRouter<T> {
  const module = options.module;
  const basePath = options.basePath ?? `/${module}`;
  const routerIds = options.ids ?? {};

  function mount(
    method: MethodName,
    path: string,
    spec: RouteSpec,
    handlers: (MiddlewareHandler | Handler)[],
  ): void {
    // Inherit router-level id overrides unless the per-route spec
    // explicitly maps the same resource → param.
    const mergedSpec: RouteSpec = isPublicSpec(spec)
      ? spec
      : {
          ...(spec as PermissionSpec),
          ids: { ...routerIds, ...((spec as PermissionSpec).ids ?? {}) },
        };

    registerRoute({
      method: method.toUpperCase(),
      path: `${basePath}${path}`,
      module,
      spec: mergedSpec,
    });

    // Order is load-bearing: authMiddleware must run BEFORE the permission
    // check so `c.var.ctx` (the RequestContext) is set by the time
    // `permission.assert(getRequestContext(c), ...)` reads userId from it.
    // Permission-tagged routes get authMiddleware
    // auto-injected unless they explicitly opt out via `skipAuth: true`
    // (e.g. routes that handle their own auth via internalAuth or
    // similar). Public routes don't auto-inject anything.
    //
    // Rate-limit ordering: when a per-route `rateLimit` is set, the
    // limiter runs AFTER authMiddleware (so ctx is available for
    // per-user/per-org subject keys) but BEFORE the permission check
    // (so we reject ratelimited callers before doing a DB load). Public
    // routes mount the limiter first (no auth to wait for).
    const chain: (MiddlewareHandler | Handler)[] = [];
    if (mergedSpec.localOnly) {
      chain.push(localOnly);
    }
    if (!isPublicSpec(mergedSpec) && !(mergedSpec as PermissionSpec).skipAuth) {
      chain.push(authMiddleware);
    }
    // Every route is rate-limited (fixes #123): the explicit spec policy if set,
    // else per-user `default-authed` for permission-tagged routes (authMiddleware
    // ran just above → ctx is set, so the limiter keys per user), else per-IP
    // `default-anon` for public / self-auth routes (no ctx). Placed AFTER auth and
    // BEFORE the permission check. There is NO global `/api/*` limiter anymore — it
    // ran upstream of auth, so it always fell back to default-anon AND double-
    // charged routes that set their own policy.
    const authed = !isPublicSpec(mergedSpec) && !(mergedSpec as PermissionSpec).skipAuth;
    const rateLimitPolicy = mergedSpec.rateLimit ?? (authed ? "default-authed" : "default-anon");
    chain.push(rateLimiterFor(rateLimitPolicy));
    chain.push(
      isPublicSpec(mergedSpec)
        ? publicRoute({ reason: mergedSpec.reason })
        : requirePermission(mergedSpec as PermissionSpec),
    );
    chain.push(...handlers);

    // Hono's method signatures are loose — use a typed indexer.
    const honoMethod = hono[method] as (
      path: string,
      ...handlers: (MiddlewareHandler | Handler)[]
    ) => unknown;
    honoMethod.call(hono, path, ...chain);
  }

  return {
    hono,
    use: hono.use.bind(hono) as T["use"],
    get(path, spec, ...handlers) {
      mount("get", path, spec, handlers);
    },
    post(path, spec, ...handlers) {
      mount("post", path, spec, handlers);
    },
    put(path, spec, ...handlers) {
      mount("put", path, spec, handlers);
    },
    patch(path, spec, ...handlers) {
      mount("patch", path, spec, handlers);
    },
    delete(path, spec, ...handlers) {
      mount("delete", path, spec, handlers);
    },
    public(method, path, spec, ...handlers) {
      const publicSpec: PublicSpec = { public: true, ...spec };
      mount(method, path, publicSpec, handlers);
    },
  };
}
