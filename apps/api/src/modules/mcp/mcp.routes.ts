/**
 * MCP endpoint — mounted at /api/mcp in app.ts. A stateless Streamable-HTTP
 * JSON-RPC endpoint. It is a PUBLIC route (no auto-injected authMiddleware):
 * it authenticates the PAT itself, and every tool call dispatches an internal
 * request that re-runs the full auth + permission stack (see mcp-dispatch.ts).
 */

import { Hono } from "hono";
import { repos } from "@repo/db";
import { secureRouter } from "../../lib/secure-router";
import { parseBearerToken } from "../../lib/bearer";
import { requestPublicOrigin } from "../../lib/public-url";
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
  let canCreateProjects = false;
  let sourceCapabilities: ReadonlySet<"content" | "write"> = new Set();
  if (role === "restricted" && id.hasBinding) {
    const grants = await repos.patGrant.listByToken(id.tokenId);
    grantedRootTypes = new Set(grants.map((g) => g.resourceType));
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

  return { role, readOnly: id.readOnly, grantedRootTypes, canCreateProjects, sourceCapabilities };
}

const PUBLIC_REASON =
  "MCP JSON-RPC endpoint; authenticates via PAT bearer and re-checks auth on every dispatched tool call";

// This server doesn't push server→client messages, so GET (SSE stream) is 405.
r.public("get", "/", { reason: PUBLIC_REASON }, (c) => c.body(null, 405));

// Same tight per-IP budget as the auth endpoints — unauthenticated PAT probes
// run a DB lookup, so cap them well below the default-anon rate.
r.public("post", "/", { reason: PUBLIC_REASON, rateLimit: "mcp" }, async (c) => {
  const token = parseBearerToken(c);

  // Resource-server 401: a missing/invalid credential returns 401 with a
  // `WWW-Authenticate` header pointing at the Protected Resource Metadata, so
  // OAuth-2.1 MCP clients discover the authorization server and start the flow.
  const unauthorized = () =>
    c.json(jsonRpcError(null, -32001, "Missing or invalid access token"), 401, {
      // Advertise the PUBLIC discovery URL (from the forwarded host) so a remote
      // OAuth client can actually reach it — not the loopback origin the API binds.
      "WWW-Authenticate": `Bearer resource_metadata="${requestPublicOrigin(c.req.raw)}/.well-known/oauth-protected-resource"`,
    });

  if (!token) return unauthorized();

  // Accept BOTH credentials: a PAT (API-key path) or an OAuth access token
  // (mcp() plugin). This resolves the caller's capability for tools/list
  // filtering AND gates the request (null → 401). It is NOT the per-tool
  // authorization — the real check runs on the dispatched sub-request through
  // authMiddleware (see tryPatAuth / tryOAuthMcpAuth); tools/call re-auths.
  const principal = await resolveMcpPrincipal(token, c.req.raw.headers);
  if (!principal) return unauthorized();

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
