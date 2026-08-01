import {
  getRouteRegistry,
  isPublicSpec,
  parsePermissionTag,
  ORG_SINGLETON_RESOURCES,
  type RegisteredRoute,
} from "../../lib/route-permission";
import {
  PROJECT_ROOTED,
  roleAllowsResourceType,
  type CheckedResourceType,
} from "../../lib/permission";

/**
 * MCP tool generation from the HTTP route registry. A route is exposed as a
 * tool ONLY if its spec declares an `mcp` block (opt-in allowlist) — the
 * description and body-param schema come from there, co-located with the route.
 * Each tool's handler dispatches an internal request through the real Hono app
 * (see mcp-dispatch.ts), so no business logic is duplicated here.
 */

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean };
  // Dispatch metadata (not sent to the client):
  method: string;
  path: string; // full path with :params, e.g. /api/projects/:id
  pathParams: string[];
  hasBody: boolean;
  /** Parsed permission metadata for capability-aware listing (not sent to client). */
  perm: {
    root: string;
    leaf: string;
    action: string;
    /** Operates on the whole org ("*") — list / create / org-singleton. A
     *  restricted principal can never pass these (checkPermission "*" → false). */
    wildcard: boolean;
    /** Resource type a grant must be on to enable this tool for a restricted
     *  principal (project-rooted sub-resources resolve to "project"). */
    grantRoot: string;
    /** The dedicated project-create route (POST /projects, POST /apps install).
     *  Reachable by an "own projects" create-capable grant — see the
     *  canCreateProjects arm in filterToolsForPrincipal. */
    projectCreate: boolean;
    /** Repo content tier this route requires, mirrored from PermissionSpec.source.
     *  Set ⇒ the tool touches repository CONTENT and needs a source capability
     *  beyond the repo grant itself. Undefined ⇒ metadata tier. */
    source?: "content" | "content-tree" | "content-whole" | "write";
  };
}

/** The caller's effective capability, resolved once per MCP request for `tools/list` filtering. */
export interface McpPrincipal {
  role: "owner" | "admin" | "member" | "restricted";
  readOnly: boolean;
  /** Resource types the token holds grants on — only consulted when role === "restricted". */
  grantedRootTypes: ReadonlySet<string>;
  /** True when the token holds a create-capable project wildcard grant
   *  ({project, "*", permissions:["create"]}) — the "own projects" scope. Lets a
   *  restricted token see the project-create routes and the project list (which
   *  it may call, filtered to its self-created projects). Mirrors permission.ts. */
  canCreateProjects: boolean;
  /**
   * Repo source capabilities the token holds anywhere in its grants — `content`
   * for file reads, `write` for writes. A repo grant is metadata-only by default,
   * so a token can hold github grants and still have NEITHER.
   *
   * Coarse by design, matching this filter's existing doctrine: a tool is listed
   * if the caller could succeed at it for SOME input, and `tools/call` narrows to
   * the specific repo and path. Optional so existing test principals stay valid.
   */
  sourceCapabilities?: ReadonlySet<"content" | "write">;
}

/**
 * Modules that must NEVER be tools even if a route is mistakenly annotated —
 * credential/auth surfaces. `tokens` in particular would let a full-access MCP
 * token mint a fresh PAT and escape its own scope. Everything else is gated by
 * opt-in (no `mcp` block → not a tool), so this stays minimal.
 */
const HARD_DENY = new Set(["tokens", "auth", "mcp"]);

const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

function includeRoute(route: RegisteredRoute): boolean {
  const spec = route.spec;
  if (isPublicSpec(spec)) return false;
  if (HARD_DENY.has(route.module)) return false;
  return spec.mcp != null; // opt-in allowlist
}

function extractPathParams(path: string): string[] {
  return path
    .split("/")
    .filter((s) => s.startsWith(":"))
    .map((s) => s.slice(1));
}

/** Stable, unique, MCP-safe tool name from method + path. */
function toolName(route: RegisteredRoute, taken: Set<string>): string {
  const segments = route.path
    .split("/")
    .filter((s) => s && s !== "api")
    .map((s) => (s.startsWith(":") ? `by_${s.slice(1)}` : s.replace(/[^a-z0-9]+/gi, "_")));
  const base = [route.method.toLowerCase(), ...segments].join("_").replace(/_+/g, "_").slice(0, 64);
  let name = base;
  let n = 2;
  while (taken.has(name)) {
    name = `${base.slice(0, 60)}_${n++}`;
  }
  taken.add(name);
  return name;
}

function inputSchema(
  pathParams: string[],
  hasBody: boolean,
  bodySchema?: Record<string, unknown>,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const p of pathParams) {
    properties[p] = { type: "string", description: `Path parameter :${p}` };
  }
  properties.query = { type: "object", description: "Optional query-string parameters", additionalProperties: true };
  if (hasBody && bodySchema) {
    // Emit the route's TypeBox body schema (JSON Schema at runtime) verbatim.
    // Convention: a mutating MCP route that takes a structured body declares it
    // via `spec.body` (which also drives auto-validation); one with NO `spec.body`
    // is a no-body action and advertises no `body` param at all — never a
    // permissive blob that would make an agent guess at fields that don't exist.
    // So "add a typed body to an MCP tool" == "add spec.body to its route".
    properties.body = bodySchema;
  }
  return {
    type: "object",
    properties,
    required: pathParams,
    additionalProperties: false,
  };
}

function annotationsFor(route: RegisteredRoute): { readOnlyHint: boolean; destructiveHint: boolean } {
  const spec = route.spec;
  if (isPublicSpec(spec)) return { readOnlyHint: true, destructiveHint: false };
  const parsed = parsePermissionTag(spec.tag);
  const readOnlyHint = parsed.action === "read" || parsed.isList || spec.readOnly === true;
  const destructiveHint =
    route.method === "DELETE" ||
    parsed.action === "admin" ||
    /delete|teardown|destroy|remove|wipe|revoke/i.test(route.path);
  return { readOnlyHint, destructiveHint };
}

let cached: McpToolDef[] | null = null;

/** All curated tools, generated once from the route registry. */
export function getMcpTools(): McpToolDef[] {
  if (cached) return cached;
  const taken = new Set<string>();
  cached = getRouteRegistry()
    .filter(includeRoute)
    .map((route): McpToolDef => {
      const spec = route.spec;
      // includeRoute already excluded public specs, so spec is a PermissionSpec.
      const mcp = isPublicSpec(spec) ? undefined : spec.mcp;
      const parsed = isPublicSpec(spec) ? null : parsePermissionTag(spec.tag);
      const collection = !isPublicSpec(spec) && spec.collection === true;
      const collectionProject = !isPublicSpec(spec) && spec.collectionProject === true;
      const leaf = parsed?.leaf ?? "";
      const pathParams = extractPathParams(route.path);
      const hasBody = BODY_METHODS.has(route.method);
      // Single-source body schema: the top-level `spec.body` (which also drives
      // auto-validation) wins; `mcp.body` is a deprecated fallback.
      const specBody = isPublicSpec(spec) ? undefined : spec.body;
      const bodySchema = (specBody ?? mcp?.body) as Record<string, unknown> | undefined;
      return {
        name: toolName(route, taken),
        description: mcp?.description ?? `${route.method} ${route.path}`,
        inputSchema: inputSchema(pathParams, hasBody, hasBody ? bodySchema : undefined),
        annotations: annotationsFor(route),
        method: route.method,
        path: route.path,
        pathParams,
        hasBody,
        perm: {
          root: parsed?.root ?? "",
          leaf,
          action: (parsed?.action ?? "read") as string,
          // "wildcard" = operates on the WHOLE org. A scoped token can never pass
          // a list/collection wildcard — but it CAN pass an org-singleton one when
          // it holds a grant on that singleton type, so `filterToolsForPrincipal`
          // treats those two cases differently (see its wildcard branch).
          // A list / collection / org-singleton op is org-wide ONLY
          // when it carries no path params. WITH path params (e.g.
          // /repos/:owner/:repo/branches, /projects/:id/deployments) it is
          // scoped to a specific resource, so a grant on that resource's root
          // type enables it — those must stay listable for scoped tokens.
          // A `collectionProject` route is org-wide in SHAPE (no :id) but scoped
          // in EFFECT — its handler authorizes the project named in the body, so
          // a grant on that project is enough and it must stay listable.
          wildcard:
            !collectionProject &&
            ((parsed?.isList ?? false) || collection || ORG_SINGLETON_RESOURCES.has(leaf)) &&
            pathParams.length === 0,
          grantRoot: PROJECT_ROOTED.has(leaf as CheckedResourceType) ? "project" : (parsed?.root ?? ""),
          projectCreate: !isPublicSpec(spec) && spec.projectCreate === true,
          // Repo content tier, declared once on the route and consumed both here
          // (advertisement) and by requirePermission (enforcement).
          source: isPublicSpec(spec) ? undefined : spec.source,
        },
      };
    });
  return cached;
}

/**
 * GitHub is granted at three widths that all key off the same route root
 * ("github"): the org-wide `github`, per-account `github_installation`, and
 * per-repo `github_repository`. Any of them satisfies a github-rooted tool for
 * `tools/list` purposes (call-time still resolves the exact width — see
 * github-access.ts). Without this, a repo-scoped token (grant type
 * `github_repository`) would advertise ZERO github tools even though it can
 * call the per-repo ones.
 */
const GITHUB_GRANT_FAMILY: ReadonlySet<string> = new Set([
  "github",
  "github_installation",
  "github_repository",
]);

/** Does the principal hold a grant whose root type enables this tool? */
function principalHasGrantFor(granted: ReadonlySet<string>, grantRoot: string): boolean {
  if (grantRoot === "github") {
    for (const t of GITHUB_GRANT_FAMILY) if (granted.has(t)) return true;
    return false;
  }
  return granted.has(grantRoot);
}

/**
 * Filter the full tool set to what a caller can actually use — capability
 * hygiene on `tools/list`. Reuses the SAME authority as call-time: read-only is
 * gated by HTTP method (matching the MUTATION_METHODS check in authMiddleware),
 * owner/admin/member by `roleAllowsResourceType`, and a restricted principal by
 * its grant set. `tools/call` still enforces per call — this only trims what's
 * advertised. A tool is listed iff the caller could succeed at it for some input.
 *
 * The "own projects" scope ({project, "*", create}) is handled explicitly via
 * `principal.canCreateProjects`: such a token may CREATE projects and LIST its
 * own, mirroring both arms of the runtime check in permission.ts.
 */
export function filterToolsForPrincipal(tools: McpToolDef[], principal: McpPrincipal): McpToolDef[] {
  return tools.filter((t) => {
    // Read-only tokens can only call GET — the runtime gate rejects mutations by
    // HTTP method, so mirror that exactly rather than guessing from the tag.
    if (principal.readOnly && t.method !== "GET") return false;

    // Repo CONTENT is a capability of its own, orthogonal to role: a repo grant
    // authorises deploying and inspecting metadata, not crawling files. Hide the
    // content tools from any principal without the capability — including an
    // owner-role token whose grants say metadata-only — so a deploy-only agent
    // isn't handed tools that will 404. `tools/call` still enforces per repo+path.
    if (t.perm.source) {
      const needed = t.perm.source === "write" ? "write" : "content";
      const caps = principal.sourceCapabilities;
      // A non-restricted principal acts with its own role, whose GitHub access is
      // resolved by github-access.ts (owner ⇒ everything), so don't hide from it.
      if (principal.role === "restricted" && !caps?.has(needed)) return false;
    }

    if (principal.role !== "restricted") {
      return roleAllowsResourceType(principal.role, t.perm.leaf as CheckedResourceType);
    }
    // "Own projects" scope: the create-capable project wildcard grant reaches the
    // dedicated create routes (POST /projects, POST /apps) and the project list
    // (which the caller filters to its self-created projects). Checked before the
    // wildcard gate, since these are exactly the wildcard ops it can pass.
    if (principal.canCreateProjects) {
      if (t.perm.projectCreate) return true;
      if (t.perm.leaf === "project" && t.perm.action === "list") return true;
    }
    // Restricted: a per-resource op needs a grant on its root type (github grants
    // matched as a family).
    if (t.perm.wildcard) {
      // An ORG-SINGLETON wildcard op is reachable for a scoped token that holds a
      // grant on the singleton type itself: the restricted arm of
      // `checkPermission` authorizes {leaf,"*"} directly from that grant
      // (permission.ts). Advertise iff such a grant is held — hiding a tool the
      // token can actually call is the same advertise/enforce drift as listing one
      // it can't, just inverted.
      //
      // A LIST or COLLECTION wildcard stays denied: no arm authorizes those from a
      // grant, so they'd 404 (the `project` create/list capability is the sole
      // exception, and it is handled above via `canCreateProjects`).
      if (!ORG_SINGLETON_RESOURCES.has(t.perm.leaf)) return false;
      return principal.grantedRootTypes.has(t.perm.leaf);
    }
    return principalHasGrantFor(principal.grantedRootTypes, t.perm.grantRoot);
  });
}

/** Client-facing tool descriptor (no dispatch internals). */
export function toClientTool(t: McpToolDef) {
  return {
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: {
      readOnlyHint: t.annotations.readOnlyHint,
      destructiveHint: t.annotations.destructiveHint,
    },
  };
}
