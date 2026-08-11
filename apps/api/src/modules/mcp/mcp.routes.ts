/**
 * MCP endpoint — mounted at /api/mcp in app.ts. A stateless Streamable-HTTP
 * JSON-RPC endpoint. It is a PUBLIC route (no auto-injected authMiddleware):
 * it authenticates the PAT itself, and every tool call dispatches an internal
 * request that re-runs the full auth + permission stack (see mcp-dispatch.ts).
 */

import { Hono, type Context } from "hono";
import { repos, type Permission } from "@repo/db";
import { secureRouter } from "../../lib/secure-router";
import { parseBearerToken } from "../../lib/bearer";
import {
  MCP_RESOURCE_PATH,
  allowedMcpResources,
  canonicalizeResource,
  protectedResourceMetadataUrl,
  publicOriginFor,
} from "../../lib/mcp-resource";
import { readTokenAudience } from "../../lib/mcp-token";
import { resolveActiveOrganizationId } from "../../middleware/active-organization";
import { resolveBearerIdentity } from "../../middleware/auth";
import { handleMcpMessage, jsonRpcError } from "./mcp-server";
import type { McpPrincipal } from "./mcp-tools";

const r = secureRouter(new Hono(), { module: "mcp", basePath: "/api/mcp" });

/**
 * Resolve the caller's effective capability for `tools/list` filtering. NOT the
 * authorization gate — every `tools/call` re-auths through the real stack
 * (mcp-dispatch → authMiddleware). This is read-only capability info so we don't
 * advertise tools the token can't use. Returns null on an invalid credential
 * (→ 401). Mirrors how authMiddleware resolves a bearer principal (same repos).
 */
async function resolveMcpPrincipal(token: string, headers: Headers): Promise<McpPrincipal | null> {
  // Same credential→identity lookup authMiddleware uses — one resolver, no fork.
  const id = await resolveBearerIdentity(token, headers);
  if (!id) return null;

  // Layer the capability on top: org (default-resolved), effective role, and —
  // for a scoped principal — the resource types it actually holds grants on.
  const organizationId = await resolveActiveOrganizationId(id.userId, id.organizationId);
  let role: McpPrincipal["role"] = "restricted";
  if (!id.scoped && organizationId) {
    const member = await repos.member.find(organizationId, id.userId);
    role = (member?.role as McpPrincipal["role"]) ?? "restricted";
  }

  let grantedRootTypes: ReadonlySet<string> = new Set();
  let wildcardGrants: ReadonlyMap<string, readonly Permission[]> = new Map();
  let canCreateProjects = false;
  let sourceCapabilities: ReadonlySet<"content" | "write"> = new Set();
  if (role === "restricted" && id.hasBinding) {
    const grants = await repos.patGrant.listByToken(id.tokenId);
    grantedRootTypes = new Set(grants.map((g) => g.resourceType));
    // Wildcard rows carry their permissions so the tool filter can answer the same
    // verb question the wildcard arm of `checkPermission` answers. One row per type
    // at most — `pat_grant_unique` is on (token, type, id).
    wildcardGrants = new Map(
      grants
        .filter((g) => g.resourceId === "*")
        .map((g) => [g.resourceType, g.permissions ?? []] as const),
    );
    // Repo CONTENT is granted separately from the repo itself, so a token holding
    // github grants is still deploy-only until some grant names read/write paths.
    // Coarse on purpose (any grant, not per-repo): `tools/list` advertises what
    // could succeed for SOME input, and `tools/call` still narrows per repo+path.
    const caps = new Set<"content" | "write">();
    for (const g of grants) {
      if (g.scope?.read?.paths?.length) caps.add("content");
      if (g.scope?.write?.paths?.length && (g.permissions ?? []).some((p) => p === "write" || p === "admin")) {
        caps.add("write");
      }
    }
    sourceCapabilities = caps;
    // "Own projects" scope: a project wildcard grant carrying the create ability
    // (mirrors the {project,"*",create} check in permission.ts).
    canCreateProjects = grants.some(
      (g) =>
        g.resourceType === "project" &&
        g.resourceId === "*" &&
        (g.permissions ?? []).includes("create"),
    );
  }

  return {
    role,
    readOnly: id.readOnly,
    grantedRootTypes,
    wildcardGrants,
    canCreateProjects,
    sourceCapabilities,
  };
}

const PUBLIC_REASON =
  "MCP JSON-RPC endpoint; authenticates via PAT bearer and re-checks auth on every dispatched tool call";

/**
 * Resource-server 401. `WWW-Authenticate` points at the PATH-AWARE Protected
 * Resource Metadata for the canonical MCP URL (RFC 9728 §5.1) — the root
 * document describes the origin, not this endpoint, and a strict client that
 * follows the pointer must land on metadata whose `resource` matches the URL it
 * connected to. Built from the PUBLIC origin (forwarded host), not the loopback
 * one the API binds to.
 */
function unauthorized(c: Context, message: string) {
  return c.json(jsonRpcError(null, -32001, message), 401, {
    "WWW-Authenticate": `Bearer resource_metadata="${protectedResourceMetadataUrl(
      publicOriginFor(c.req.raw),
      MCP_RESOURCE_PATH,
    )}"`,
    "Access-Control-Expose-Headers": "WWW-Authenticate",
  });
}

/**
 * RFC 8707 audience check. A token minted for a DIFFERENT resource must not be
 * accepted here — that's the resource server's half of the contract, and it's
 * what stops a token phished by another MCP server from being replayed against
 * this one. A token with no audience (opaque, issued before audience binding
 * existed) is unconstrained and passes, so existing clients keep working.
 * Comparison is on canonicalized URLs, never raw strings.
 */
function audienceAccepted(token: string, req: Request): boolean {
  const aud = readTokenAudience(token);
  if (!aud) return true;
  const value = canonicalizeResource(aud);
  if (!value) return false;
  return allowedMcpResources(publicOriginFor(req)).some(
    (allowed) => canonicalizeResource(allowed) === value,
  );
}

// This server doesn't push server→client messages, so GET is never an SSE
// stream. An UNAUTHENTICATED GET still answers 401 with the discovery pointer:
// probing the endpoint with a bare GET is how several clients (Claude.ai among
// them) find the authorization server. An authenticated GET is a 405.
r.public("get", "/", { reason: PUBLIC_REASON, rateLimit: "mcp" }, async (c) => {
  const token = parseBearerToken(c);
  if (!token) return unauthorized(c, "Missing or invalid access token");
  if (!audienceAccepted(token, c.req.raw)) {
    return unauthorized(c, "Access token was issued for a different resource");
  }
  const principal = await resolveMcpPrincipal(token, c.req.raw.headers);
  if (!principal) return unauthorized(c, "Missing or invalid access token");
  return c.body(null, 405);
});

// Same tight per-IP budget as the auth endpoints — unauthenticated PAT probes
// run a DB lookup, so cap them well below the default-anon rate.
r.public("post", "/", { reason: PUBLIC_REASON, rateLimit: "mcp" }, async (c) => {
  const token = parseBearerToken(c);
  if (!token) return unauthorized(c, "Missing or invalid access token");

  // Reject a token issued for another resource before spending a DB lookup on it.
  if (!audienceAccepted(token, c.req.raw)) {
    return unauthorized(c, "Access token was issued for a different resource");
  }

  // Accept BOTH credentials: a PAT (API-key path) or an OAuth access token
  // (mcp() plugin). This resolves the caller's capability for tools/list
  // filtering AND gates the request (null → 401). It is NOT the per-tool
  // authorization — the real check runs on the dispatched sub-request through
  // authMiddleware (see tryPatAuth / tryOAuthMcpAuth); tools/call re-auths.
  const principal = await resolveMcpPrincipal(token, c.req.raw.headers);
  if (!principal) return unauthorized(c, "Missing or invalid access token");

  let payload: unknown;
  try {
    payload = await c.req.json();
  } catch {
    return c.json(jsonRpcError(null, -32700, "Parse error"), 400);
  }

  // 2025-06-18 removed JSON-RPC batching; accept a single message only.
  if (Array.isArray(payload)) {
    return c.json(jsonRpcError(null, -32600, "Batch requests are not supported"), 400);
  }

  const res = await handleMcpMessage(payload as Parameters<typeof handleMcpMessage>[0], token, principal);
  // Notification (no id) → 202 Accepted with no body (per JSON-RPC).
  if (!res) return c.body(null, 202);
  return c.json(res);
});

export const mcpRoutes = r.hono;
