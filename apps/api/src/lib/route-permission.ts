/**
 * Tag-based route permission system — the single source of truth for
 * "user × resource × action".
 *
 * Every route declares a tag of the form:
 *   <root>:<action>                       e.g. "project:read"
 *   <root>:<subresource>:<action>         e.g. "project:service:edit"
 *   <root>:<subresource>:list             e.g. "project:deployment:list"
 *
 * The middleware:
 *   1. Parses the tag → resource type + action + scope (single vs list)
 *   2. Resolves the resource id from URL params (idParam map, conventional)
 *   3. For sub-resource tags: verifies the child belongs to the named parent
 *      (e.g. service.project_id === :id from the URL)
 *   4. Calls permission.assert(getRequestContext(c), ...) — which loads the resource, reads its
 *      org_id, checks member(userId, org_id), and applies role/grants
 *
 * No bypass:
 *   - The secureRouter wrapper requires a tag (or explicit publicRoute) for
 *     every route declaration. TypeScript enforces it at compile time.
 *   - The boot-time scanner walks the route registry and refuses to start
 *     the server if any registered route lacks a spec.
 */

import type { Context, Next, MiddlewareHandler } from "hono";
import type { TSchema } from "@sinclair/typebox";
import { NotFoundError } from "@repo/core";
import { permission, type CheckedResourceType } from "./permission";
import { getRequestContext } from "./request-context";
import type { Permission as Action } from "@repo/db";
import { repos } from "@repo/db";
import { audit, auditContextFrom } from "./audit";

/* ------------------------------------------------------------------ */
/*  Tag types                                                          */
/* ------------------------------------------------------------------ */

/**
 * Tag grammar:
 *   simple:  <resource>:<action>          → operates on one resource by id
 *   nested:  <root>:<sub>:<action>        → operates on a sub-resource;
 *                                           parent id verified from URL too
 *   list:    <resource>:list              → list-on-collection (org-scoped)
 *   nested-list: <root>:<sub>:list        → list sub-resources for a parent
 *
 * Actions:
 *   read   → GET
 *   write  → POST/PUT/PATCH on an existing resource (or create on a list)
 *   admin  → DELETE / destructive
 *   list   → GET on a collection (org-scoped, no specific resource)
 *
 * Examples:
 *   "project:read"                  — GET /projects/:id
 *   "project:write"                 — PATCH /projects/:id
 *   "project:admin"                 — DELETE /projects/:id
 *   "project:list"                  — GET /projects
 *   "project:service:read"          — GET /projects/:id/services/:serviceId
 *   "project:service:write"         — PATCH /projects/:id/services/:serviceId
 *   "project:service:admin"         — DELETE /projects/:id/services/:serviceId
 *   "project:service:list"          — GET /projects/:id/services
 *   "project:deployment:list"       — GET /projects/:id/deployments
 *   "deployment:read"               — GET /deployments/:id (standalone, no parent)
 *   "backup_destination:run:write"  — POST /backup-destinations/:id/runs
 *   "billing:read"                  — GET /billing (org-singleton)
 *   "audit:read"                    — GET /audit (org-singleton)
 */
export type PermissionTag = string; // keep wide; the parser validates structurally

/**
 * Resource → URL param-name convention. The middleware reads the id from
 * `c.req.param(paramName)`. Overridable per route.
 */
const DEFAULT_ID_PARAMS: Record<string, string> = {
  project: "id",
  deployment: "id",
  domain: "id",
  service: "serviceId",
  server: "id",
  mail_server: "id",
  backup_destination: "id",
  backup_policy: "policyId",
  backup_run: "runId",
  backup_restore: "restoreId",
  env_var: "envVarId",
  build_session: "buildId",
};

const ROOT_RESOURCES = new Set<string>([
  "project",
  "deployment",
  "server",
  "mail_server",
  "backup_destination",
  "billing",
  "audit",
  "analytics",
  "github",
  "gitlab",
  "permissions",
  "domain",
  "settings",
  "job",
  "terminal",
  "cloud",
  "notifications",
  "updates",
]);

/**
 * Resources that exist exactly once per org and don't carry a resource id
 * in the URL. The middleware treats the action as operating on "*" (the
 * org-singleton) and resolves the org from the request scope instead of
 * loading a specific row.
 *
 * Add here any new "feature" tag whose URL doesn't follow the
 * /resource/:id pattern. Per-resource types (project, deployment, etc.)
 * MUST NOT be in this set.
 */
export const ORG_SINGLETON_RESOURCES = new Set<string>([
  "billing",
  "audit",
  "analytics",
  "github",
  "gitlab",
  "permissions",
  "settings",
  "job",
  "cloud",
  "terminal",
  "notifications",
  "updates",
]);

/**
 * Resources that are normally per-row but ALSO support org-level bulk
 * operations on the same path prefix (e.g. POST /domains/renew-all
 * lives next to POST /domains/:id/verify). When the request URL lacks
 * the resource-id param, the middleware falls back to "*" scope. The
 * controller is still responsible for performing org-wide reasoning
 * safely (no implicit cross-tenant access).
 */
const CONDITIONAL_SINGLETON_RESOURCES = new Set<string>([
  "domain",
  "mail_server",
]);

const VALID_ACTIONS = new Set(["read", "write", "admin", "list"]);

interface ParsedTag {
  raw: string;
  /** First segment of the tag (e.g. "project" in "project:service:edit"). */
  root: CheckedResourceType;
  /** Last NON-action segment — the actual resource being acted on. Equals root for simple tags. */
  leaf: CheckedResourceType;
  /** "read" | "write" | "admin" | "list" */
  action: Action | "list";
  /** True if it's a list/collection scope; false if a specific resource id is expected. */
  isList: boolean;
}

export function parsePermissionTag(tag: PermissionTag): ParsedTag {
  const parts = tag.split(":").map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) {
    throw new Error(
      `Invalid permission tag "${tag}" — must be at least <resource>:<action>`,
    );
  }
  const action = parts[parts.length - 1];
  if (!VALID_ACTIONS.has(action)) {
    throw new Error(
      `Invalid action "${action}" in tag "${tag}" — must be read|write|admin|list`,
    );
  }
  const root = parts[0];
  if (!ROOT_RESOURCES.has(root)) {
    throw new Error(
      `Invalid root resource "${root}" in tag "${tag}" — must be one of ${[...ROOT_RESOURCES].join("|")}`,
    );
  }
  const resourceSegments = parts.slice(0, -1);
  const leaf = resourceSegments[resourceSegments.length - 1];

  return {
    raw: tag,
    root: root as CheckedResourceType,
    leaf: leaf as CheckedResourceType,
    action: action as Action | "list",
    isList: action === "list",
  };
}

/* ------------------------------------------------------------------ */
/*  Parent-chain assertion (for nested tags like project:service:X)    */
/* ------------------------------------------------------------------ */

async function assertParentChain(
  parsed: ParsedTag,
  parentId: string,
  childId: string,
): Promise<void> {
  // We verify the CHILD belongs to the named PARENT. This prevents URL
  // confusion attacks where /projects/A/services/B is accepted when
  // service B actually belongs to project C.
  const parent = parsed.root;
  const child = parsed.leaf;

  // service belongs to project via service.project_id
  if (parent === "project" && child === "service") {
    const s = await repos.service.findById(childId);
    if (!s || s.projectId !== parentId) {
      throw new NotFoundError("service", childId);
    }
    return;
  }
  if (parent === "project" && child === "deployment") {
    const d = await repos.deployment.findById(childId);
    if (!d || d.projectId !== parentId) {
      throw new NotFoundError("deployment", childId);
    }
    return;
  }
  if (parent === "project" && child === "domain") {
    const d = await repos.domain.findById(childId);
    if (!d || d.projectId !== parentId) {
      throw new NotFoundError("domain", childId);
    }
    return;
  }
  // backup_destination → backup_policy / backup_run / backup_restore
  if (parent === "backup_destination" && child === "backup_policy") {
    const p = await repos.backupPolicy.findById(childId).catch(() => null);
    if (!p || p.destinationId !== parentId) {
      throw new NotFoundError("backup_policy", childId);
    }
    return;
  }
  if (parent === "backup_destination" && child === "backup_run") {
    const r = await repos.backupRun.findById(childId).catch(() => null);
    if (!r || r.destinationId !== parentId) {
      throw new NotFoundError("backup_run", childId);
    }
    return;
  }
  if (parent === "backup_destination" && child === "backup_restore") {
    const r = await repos.backupRestore.findById(childId).catch(() => null);
    if (!r || r.destinationId !== parentId) {
      throw new NotFoundError("backup_restore", childId);
    }
    return;
  }
  // HIGH F8: any unenumerated (parent, child) pair MUST hard-fail.
  // Silently no-op'ing would skip the cross-parent confusion check and
  // let /projects/A/services/B-belonging-to-project-C slip through.
  // Throw NotFoundError so the leaf id is the value disclosed (IDOR-
  // safe) and so the next maintainer adding a new nested tag is forced
  // to enumerate the pair here.
  throw new NotFoundError(child, childId);
}

/* ------------------------------------------------------------------ */
/*  Spec types                                                         */
/* ------------------------------------------------------------------ */

/**
 * Rate-limit policy id — see `lib/rate-limit/policies.ts`. Routes that
 * omit `rateLimit` fall through to the default global limiter
 * (`default-anon` for public routes, `default-authed` for permission-
 * tagged routes). Override when a route warrants tighter or looser
 * limits than the default.
 */
export type RateLimitPolicyId =
  | "default-anon"
  | "default-authed"
  | "auth-tight"
  | "auth-loose"
  | "mcp"
  | "read-authed"
  | "write-authed"
  | "webhook-ingress"
  | "billing-portal";

/**
 * MCP exposure for a route. Presence of this block is the MCP allowlist:
 * routes without `mcp` are never exposed as tools (see modules/mcp/mcp-tools).
 * Co-locating it with the route keeps the description and the body-param schema
 * next to the handler instead of in a detached map.
 */
export interface McpRouteMeta {
  /** Agent-facing tool description. */
  description: string;
  /**
   * TypeBox schema for the request body — emitted verbatim as the tool's body
   * params. TypeBox *is* JSON Schema, so there's no second contract to keep in
   * sync; reuse the same schema the controller types against.
   */
  body?: TSchema;
}

export interface PermissionSpec {
  /** The tag describing what action is being performed. */
  tag: PermissionTag;
  /**
   * Per-route rate-limit policy. When set, the rate-limit middleware
   * uses this policy instead of `default-authed`. See
   * `lib/rate-limit/policies.ts` for the catalog.
   */
  rateLimit?: RateLimitPolicyId;
  /**
   * URL param name → resource type map. Used to extract resource ids.
   * Defaults follow `DEFAULT_ID_PARAMS` per leaf resource type. Override
   * when your route uses a non-standard param name.
   */
  ids?: Partial<Record<string, string>>;
  /**
   * Opt out of the route-scanner's "mutation method must use write/admin"
   * check. Set true ONLY when the handler is genuinely side-effect-free
   * but uses POST/PUT/PATCH to carry a body (e.g. DNS preview probes).
   * The permission requirement still applies — readOnly is a static-
   * check waiver, not a runtime permission relaxation.
   */
  readOnly?: boolean;
  /**
   * Skip the auto-injected `authMiddleware`. Defaults to false — i.e.
   * every permission-tagged route gets `authMiddleware` mounted before
   * the permission check, because permission checks need a user in
   * context to mean anything.
   *
   * Set true when the route handles its own auth (e.g. `internalAuth`
   * for Electron↔API trusted-token endpoints). The handlers array
   * must then include the alternate auth middleware before the
   * controller.
   */
  skipAuth?: boolean;
  /**
   * Route operates on the collection rather than a specific resource:
   * org scope comes from the request (X-Organization-Id header or
   * session default), no :id is required. Use for create/bulk
   * endpoints whose action is write/admin (e.g. POST /deployments,
   * POST /deployments/prepare, POST /projects, POST /projects/scan).
   *
   * For action=list this is already the default behaviour — do NOT
   * set `collection: true` on list routes.
   *
   * The safety property of the :id requirement is preserved on every
   * per-resource route that doesn't opt in: forgetting to add the
   * flag is a 400, not a silent fall-through to org-singleton scope.
   */
  collection?: boolean;
  /** Marks the dedicated project-create route. Lets the "own projects" token
   *  scope allow creation here without allowing other collection-write project
   *  routes (ensure/scan/import) that can reference existing projects. */
  projectCreate?: boolean;
  /**
   * Restrict this route to self-hosted instances. The secure router mounts the
   * `localOnly` middleware ahead of auth, so a request in CLOUD_MODE gets a 404
   * before any handler runs. Declarative replacement for an inline
   * `assertNotCloud(c)` guard — it also surfaces the self-hosted-only fact right
   * in the route table. An inline guard may still be kept as deliberate
   * defense-in-depth.
   */
  localOnly?: boolean;
  /** Opt this route into the MCP tool surface. See {@link McpRouteMeta}. */
  mcp?: McpRouteMeta;
}

export interface PublicSpec {
  /** Marks a route as intentionally unauthenticated. */
  public: true;
  /** Free-text justification (CRON, webhook, healthcheck, etc.). */
  reason: string;
  /**
   * Per-route rate-limit policy. When omitted, the route gets
   * `default-anon` (per-IP, conservative). Webhook ingress should use
   * `"webhook-ingress"`; auth endpoints should use `"auth-tight"`.
   */
  rateLimit?: RateLimitPolicyId;
  /** Restrict this route to self-hosted instances (404 in CLOUD_MODE). See
   *  the same field on {@link PermissionSpec}. */
  localOnly?: boolean;
}

export type RouteSpec = PermissionSpec | PublicSpec;

export function isPublicSpec(spec: RouteSpec): spec is PublicSpec {
  return (spec as PublicSpec).public === true;
}

/* ------------------------------------------------------------------ */
/*  Middleware factory                                                 */
/* ------------------------------------------------------------------ */

/**
 * Build the Hono middleware that enforces a permission tag AND emits an
 * audit_event after a successful mutation.
 *
 * The tag is the operation identifier — it's both the permission decision
 * key AND the audit event_type. One declaration, both behaviors:
 *
 *   r.delete("/:id", { tag: "project:admin" }, ctrl.remove);
 *                            │
 *                            ├──► permission check (before handler)
 *                            └──► audit_event(tag, user, org, resource) after success
 *
 * Used internally by `secureRouter`. Direct use is allowed but the
 * scanner won't verify the route was actually mounted with this — prefer
 * the wrapper so coverage is guaranteed.
 */
export function requirePermission(spec: PermissionSpec): MiddlewareHandler {
  const parsed = parsePermissionTag(spec.tag);
  const idsMap = spec.ids ?? {};

  return async (c: Context, next: Next) => {
    let leafId: string | undefined;

    if (parsed.isList) {
      // List scope — org from request (X-Organization-Id header or
      // session default). No specific resource id.
      await permission.assert(getRequestContext(c), {
        resourceType: parsed.leaf,
        resourceId: "*",
        action: "read",
        scope: "list",
      });
    } else if (ORG_SINGLETON_RESOURCES.has(parsed.leaf as string)) {
      // Org-singleton resources (billing, settings, analytics, etc.) —
      // no resource id in the URL. Pass "*" so the permission resolver
      // derives the org from request scope.
      await permission.assert(getRequestContext(c), {
        resourceType: parsed.leaf,
        resourceId: "*",
        action: parsed.action as Action,
      });
      leafId = "*";
    } else if (spec.collection) {
      // Collection-scoped write/admin (e.g. POST /deployments, POST
      // /deployments/prepare). No :id in the URL; org scope comes from
      // the request (X-Organization-Id header or session default).
      // Same resolution path as list reads, just with the route's
      // declared action so role/grants still apply.
      await permission.assert(getRequestContext(c), {
        resourceType: parsed.leaf,
        resourceId: "*",
        action: parsed.action as Action,
        scope: "list",
        projectCreate: spec.projectCreate,
      });
      leafId = "*";
    } else {
      // Resolve the leaf resource's id from URL param. For resources
      // that support BOTH per-resource and org-level bulk operations
      // (e.g. /domains/:id/verify vs /domains/renew-all), fall back to
      // org-singleton scope when the URL has no param.
      const leafParamName =
        idsMap[parsed.leaf] ?? DEFAULT_ID_PARAMS[parsed.leaf] ?? "id";
      leafId = c.req.param(leafParamName);
      if (!leafId) {
        if (CONDITIONAL_SINGLETON_RESOURCES.has(parsed.leaf as string)) {
          await permission.assert(getRequestContext(c), {
            resourceType: parsed.leaf,
            resourceId: "*",
            action: parsed.action as Action,
          });
          leafId = "*";
          // Stash tag + skip the per-resource block below.
          c.set("routePermissionTag", spec.tag);
          c.set("routeResourceId", leafId);
          await next();
          return;
        }
        return c.json(
          {
            error: `Missing route param :${leafParamName} required by tag "${spec.tag}"`,
          },
          400,
        );
      }

      // If the tag has a parent (e.g. "project:service:edit") AND the URL
      // also carries the parent id, verify the child belongs to that
      // parent. If the URL only carries the leaf id (e.g. /services/:id),
      // the leaf-resource permission check below still enforces org
      // isolation by deriving the parent from the leaf row — the extra
      // assertion is only for URLs that explicitly claim a (parent, child)
      // pair so we catch /projects/A/services/B-belonging-to-project-C.
      if (parsed.root !== parsed.leaf) {
        const parentParamName =
          idsMap[parsed.root] ?? DEFAULT_ID_PARAMS[parsed.root] ?? "id";
        const parentId = c.req.param(parentParamName);
        if (parentId) {
          await assertParentChain(parsed, parentId, leafId);
        }
      }

      // Run the permission check. Loads resource → reads its org_id →
      // checks member(userId, org_id) → applies role/grants.
      await permission.assert(getRequestContext(c), {
        resourceType: parsed.leaf,
        resourceId: leafId,
        action: parsed.action as Action,
      });
    }

    // Stash the tag for downstream consumers (audit emitter, logging).
    c.set("routePermissionTag", spec.tag);
    if (leafId) c.set("routeResourceId", leafId);

    // Run the handler.
    await next();

    // After handler success: emit an audit event for write/admin/list-
    // -with-side-effects. Read/list are typically too noisy to log unless
    // the route opts in (TODO: per-route auditOnRead flag).
    const action = parsed.action;
    if (action === "write" || action === "admin") {
      const status = c.res.status;
      if (status >= 200 && status < 400) {
        // For CREATE flows, the handler stamps the new id via
        // `c.set("createdResourceId", id)` so the audit row carries it.
        // For UPDATE/DELETE, leafId from the URL is the target.
        const resourceId =
          (c.get("createdResourceId") as string | undefined) ?? leafId ?? "*";

        const orgId =
          (c.get("scopedOrganizationId") as string | undefined) ??
          permission.resolveRequestScopeOrg(c);

        if (orgId) {
          audit.recordAsync(auditContextFrom(c, orgId, getRequestContext(c).userId), {
            eventType: spec.tag,
            resourceType: parsed.leaf,
            resourceId,
            after: (c.get("auditAfter") as Record<string, unknown> | undefined) ?? null,
            before: (c.get("auditBefore") as Record<string, unknown> | undefined) ?? null,
          });
        }
      }
    }
  };
}

/**
 * Marker middleware for intentionally-public routes (CRON, webhooks,
 * healthchecks). The boot scanner allows these through without complaint
 * because the `reason` is logged at startup.
 */
export function publicRoute(spec: { reason: string }): MiddlewareHandler {
  const mw: MiddlewareHandler = async (_c, next) => next();
  publicMarkers.set(mw, { ...spec, public: true });
  return mw;
}

/* ------------------------------------------------------------------ */
/*  Registry — populated by secureRouter at route-mount time           */
/* ------------------------------------------------------------------ */

export interface RegisteredRoute {
  method: string;
  path: string;
  module: string;
  spec: RouteSpec;
}

const routeRegistry: RegisteredRoute[] = [];
const publicMarkers = new WeakMap<MiddlewareHandler, PublicSpec>();

export function registerRoute(entry: RegisteredRoute) {
  routeRegistry.push(entry);
}

export function getRouteRegistry(): readonly RegisteredRoute[] {
  return routeRegistry;
}

export function isPublicMiddleware(mw: MiddlewareHandler): boolean {
  return publicMarkers.has(mw);
}
