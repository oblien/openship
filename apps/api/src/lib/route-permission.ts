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
import { NotFoundError, normalizeRepoPath } from "@repo/core";
import { permission, ORG_SINGLETON_RESOURCES, type CheckedResourceType } from "./permission";
import { getRequestContext } from "./request-context";
import type { Permission as Action } from "@repo/db";
import { repos } from "@repo/db";
import { audit, auditContextFrom } from "./audit";
import {
  canUseGitHubRepo,
  checkSourceTier,
  type SourceTier,
} from "../modules/github/github-access";

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
 * Re-exported from ./permission, which is where this policy now lives so the
 * restricted arm of `checkPermission` can honor org-singleton grants without
 * importing this module (that would cycle). Kept exported here for the existing
 * importers (mcp-tools.ts).
 */
export { ORG_SINGLETON_RESOURCES };

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

export interface ParsedTag {
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
 * Co-locating it with the route keeps the description next to the handler
 * instead of in a detached map.
 */
export interface McpRouteMeta {
  /** Agent-facing tool description. */
  description: string;
  /**
   * @deprecated Declare the body schema ONCE via the top-level `spec.body`
   * field instead — secureRouter auto-wires `tbValidator` from it AND the MCP
   * layer reads it as the tool's body params, so there is a single source. This
   * field is kept only as a fallback for the (now migrated) legacy call sites.
   */
  body?: TSchema;
}

export interface PermissionSpec {
  /** The tag describing what action is being performed. */
  tag: PermissionTag;
  /**
   * Source-access tier for a GitHub route that touches repository CONTENT.
   *
   * A repo grant is metadata-only by default: `github:read` on a repo authorises
   * deploying it, reading branches, and detecting its stack, but NOT crawling it.
   * Any route that serves file bytes or directory entries MUST declare this, or a
   * deploy-only token would read content it was never granted.
   *
   * One declaration, two behaviours — the same doctrine as `tag`:
   *   - `requirePermission` enforces the tier per call (below)
   *   - `mcp-tools.ts` hides the tool from a principal without the capability
   *
   * `test/lib/github-source-tier.test.ts` is the ratchet: add a content-serving
   * github route without a tier and it fails.
   */
  source?: SourceTier;
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
   * The route's BODY names the project it acts on (a required `projectId`), and
   * its handler already asserts `{project, body.projectId, <action>}` itself.
   * Skips the collection-level `{leaf,"*"}` pre-check here and lets that handler
   * assert be the authority.
   *
   * Why this exists: `resourceId: "*"` is unsatisfiable for a `restricted`
   * principal (`permission.ts` denies every wildcard except the project-create
   * pair), so the pre-check wasn't a second line of defence for scoped tokens —
   * it was the ONLY line, and it rejected them before the precise per-project
   * check could pass. A token granted a project could not deploy that project.
   * For owner/admin/member nothing changes: both checks resolve to the same
   * `roleAllowsResourceType` answer.
   *
   * Only set this where BOTH hold, or the route loses its gate entirely:
   *   1. `body` declares `projectId` as REQUIRED — the auto-wired validator runs
   *      right after this middleware, so a missing id is a 400 before the handler.
   *   2. The handler asserts on that id before doing any work.
   */
  collectionProject?: boolean;
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
  /**
   * TypeBox schema for the JSON request body. Declared ONCE here and consumed
   * in two places — no duplication:
   *   1. secureRouter auto-mounts `tbValidator("json", body)` ahead of the
   *      handlers (so every body-carrying route validates by construction).
   *   2. The MCP layer emits it verbatim as the tool's `body` params (TypeBox
   *      *is* JSON Schema, so there's no second contract to keep in sync).
   * Prefer this over the deprecated `mcp.body`.
   */
  body?: TSchema;
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
/*  GitHub grant-width resolution                                      */
/* ------------------------------------------------------------------ */

/**
 * GitHub read/list routes whose URL names a repo owner.
 *
 * GitHub is granted at three widths — org-wide `github` (resourceId "*"),
 * per-account `github_installation` (the owner login), and per-repo
 * `github_repository` ("owner/repo"). `modules/github/github-access.ts` is
 * the resolver for all three, and mcp-tools.ts already documents it as the
 * call-time authority.
 *
 * Without this branch these routes fall through to the isList /
 * ORG_SINGLETON_RESOURCES paths, which assert
 * `{resourceType:"github", resourceId:"*"}`. For a restricted principal that
 * check can never pass at ANY width: `resolveResourceOrg` sends "github" to
 * `loadRootOrgId`, which has no "github" case and returns null, so
 * `checkPermission` denies regardless of the grant held. Meanwhile
 * `filterToolsForPrincipal` advertises these tools to any holder of a
 * github-family grant (GITHUB_GRANT_FAMILY in mcp-tools.ts). Net effect
 * before this fix: every GitHub MCP tool was listed and then failed with the
 * tell-tale `github '*' not found`.
 *
 * Deliberately limited to read/list. Write/admin GitHub routes (create or
 * delete repo, disconnect, instance-token) keep the strict org-wide check —
 * owner role or an all-GitHub grant — and MCP exposes no GitHub mutations.
 * Paramless GitHub routes (/home, /status, /repos) also stay on the org-wide
 * path: `filterToolsForPrincipal` already hides them from a scoped token via
 * `perm.wildcard`, and their handlers narrow results through
 * filterAllowedRepos / filterAllowedAccounts.
 *
 * Exported for the regression test that pins this invariant.
 */
export function githubReadTarget(
  parsed: ParsedTag,
  c: Context,
): { owner: string; repo: string | null; key: string } | null {
  if (parsed.leaf !== "github") return null;
  if (parsed.action !== "read" && parsed.action !== "list") return null;
  // ":owner" on /repos/:owner/:repo…, ":org" on /orgs/:org/repos.
  const owner = c.req.param("owner") ?? c.req.param("org");
  if (!owner) return null;
  const repo = c.req.param("repo") ?? null;
  return { owner, repo, key: repo ? `${owner}/${repo}` : owner };
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

    const ghTarget = githubReadTarget(parsed, c);

    if (ghTarget) {
      // Authorize against the caller's ACTUAL GitHub grant width instead of
      // the unsatisfiable {github,"*"} singleton check — see githubReadTarget.
      // `canUseGitHubRepo` gates membership itself and short-circuits to allow
      // for a non-scoped owner, so relative to the old path this narrows
      // (an ungranted member is now stopped at the gate rather than opaquely
      // downstream in tokenFor) and never widens.
      const allowed = await canUseGitHubRepo(
        getRequestContext(c),
        { owner: ghTarget.owner, repo: ghTarget.repo },
        parsed.action === "list" ? "list" : "read",
      );
      // NotFoundError over 403 to match the IDOR-safe convention used
      // throughout this middleware — and it names the repo actually
      // requested rather than a bare "*".
      if (!allowed) throw new NotFoundError("github", ghTarget.key);

      // Second gate: may they reach this SURFACE of the repo? Passing the check
      // above only means "may use this repo at all" (deploy, branches, detect).
      // Content is separately granted and path-scoped.
      if (spec.source) {
        // `?file=` on the single-file route, `?path=` on the tree route; absent
        // means the repo root, which is what /files with no path lists.
        const rawPath = c.req.query("file") ?? c.req.query("path") ?? "";

        // Normalise HERE, once, and publish the result — so the string we
        // authorise is byte-identical to the one the handler goes on to fetch.
        // Handlers used to re-read the raw query param, which meant the check and
        // the read operated on different strings ("src/./a.ts" was authorised as
        // "src/a.ts"). They resolve to the same object today, so this was not
        // exploitable — but "check one string, use another" is one refactor of
        // normalizeRepoPath away from being a real bypass, and it costs nothing
        // to make them the same value.
        //
        // null ⇒ traversal / NUL / backslash / over-length: refuse, never resolve.
        const path = normalizeRepoPath(rawPath);
        if (path === null) {
          throw new NotFoundError("github", `${ghTarget.key}/${rawPath}`);
        }

        const { ok, readPaths } = await checkSourceTier(
          getRequestContext(c),
          { owner: ghTarget.owner, repo: ghTarget.repo },
          spec.source,
          path,
        );
        if (!ok) {
          // Name the path, not just the repo — the caller may legitimately hold
          // the repo and only be missing this subtree.
          throw new NotFoundError("github", path ? `${ghTarget.key}/${path}` : ghTarget.key);
        }
        // Hand the allow-list to the handler so a tree listing can filter its
        // entries without resolving the grant a second time, and the authorised
        // path so it never re-derives one.
        c.set("sourceReadPaths", readPaths);
        c.set("sourcePath", path);
      }

      leafId = ghTarget.key;
    } else if (spec.collectionProject) {
      // The body names the target project and the handler asserts on it — see
      // PermissionSpec.collectionProject for why the `"*"` pre-check is skipped
      // rather than kept as belt-and-braces. `leafId` stays "*" so the audit
      // record below is byte-identical to the collection branch's.
      leafId = "*";
    } else if (parsed.isList) {
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
