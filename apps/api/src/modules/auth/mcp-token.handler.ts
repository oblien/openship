/**
 * `POST /api/auth/mcp/token` — RFC 8707 wrapper around better-auth's MCP token
 * endpoint.
 *
 * The plugin ignores the `resource` parameter entirely and mints an opaque
 * token with no audience. A spec-strict MCP client (Claude.ai) sends `resource`
 * on both the authorize and the token request and expects the token it gets
 * back to belong to that resource. So this wrapper:
 *
 *   1. rejects a `resource` that doesn't name this instance's MCP endpoint with
 *      the OAuth error the spec asks for (`invalid_target`) instead of silently
 *      ignoring it;
 *   2. delegates the whole grant to the plugin (PKCE, client auth, code
 *      validation, refresh rotation — all unchanged);
 *   3. re-issues the returned access token as an audience-bound JWT
 *      (lib/mcp-token.ts), rewriting the stored row so introspection still
 *      resolves it.
 *
 * Backward compatible in both directions: a client that sends no `resource`
 * gets the canonical MCP URL as its audience, and a token minted before this
 * existed keeps resolving (the audience gate treats "no audience" as
 * unconstrained).
 */

import { repos } from "@repo/db";
import { auth } from "../../lib/auth";
import { isAllowedMcpResource, publicOriginFor, resolveTokenAudience } from "../../lib/mcp-resource";
import { signMcpAccessToken } from "../../lib/mcp-token";
import { signRs256Jwt } from "../../lib/mcp-oidc-keys";

/** Decode a JWT payload without verifying (we re-sign, we don't trust). */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(parts[1] as string, "base64url").toString("utf8"),
    );
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Re-issue the plugin's id_token as a VERIFIABLE one.
 *
 * The mcp() plugin signs the id_token with HS256 over a key it generates and
 * throws away inside the request, omits `iss`, and stamps `iat` in
 * milliseconds. No client can validate that against the advertised metadata
 * (`id_token_signing_alg_values_supported: ["RS256","none"]` + a jwks_uri) —
 * Claude.ai tries, fails, and drops the connection right after the token
 * exchange. Keep the plugin's user claims, fix the protocol claims, sign RS256
 * with the instance key the jwks endpoint serves.
 */
async function reissueIdToken(
  original: string,
  issuer: string,
  clientId: string,
  userId: string,
  expiresAt: Date,
): Promise<string | null> {
  const claims = decodeJwtPayload(original);
  if (!claims) return null;
  const now = Math.floor(Date.now() / 1000);
  const authTime = typeof claims.auth_time === "number" ? claims.auth_time : undefined;
  return signRs256Jwt({
    ...claims,
    iss: issuer,
    sub: userId,
    aud: clientId,
    iat: now,
    exp: Math.floor(expiresAt.getTime() / 1000),
    // The plugin stamps auth_time in ms; OIDC wants seconds.
    ...(authTime !== undefined ? { auth_time: authTime > 1e12 ? Math.floor(authTime / 1000) : authTime } : {}),
  });
}

/** Read `resource` out of a token request without consuming the body. */
async function readResourceParam(request: Request): Promise<string | undefined> {
  const contentType = request.headers.get("content-type") ?? "";
  try {
    if (contentType.includes("application/x-www-form-urlencoded")) {
      const form = await request.clone().formData();
      const value = form.get("resource");
      return typeof value === "string" ? value : undefined;
    }
    if (contentType.includes("application/json")) {
      const body = (await request.clone().json()) as Record<string, unknown> | null;
      const value = body && typeof body === "object" ? body.resource : undefined;
      return typeof value === "string" ? value : undefined;
    }
  } catch {
    // Malformed body — let the plugin produce its own `invalid_request`.
  }
  return undefined;
}

/**
 * OAuth error codes RFC 6749 §5.2 requires to be returned with HTTP 400. The
 * plugin answers 401 for all of them; only `invalid_client` legitimately uses
 * 401. That matters most on a refresh: a client that sees 401 reads it as "the
 * server rejected my credentials" and gives up, where 400 + `invalid_grant`
 * tells it the grant is stale and a fresh authorization is needed. Claude.ai
 * strands a connector in a connected-but-unauthenticated state on the 401.
 */
const BAD_REQUEST_ERRORS = new Set([
  "invalid_request",
  "invalid_grant",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_scope",
  "invalid_target",
]);

/** Re-status an OAuth error response to what RFC 6749 §5.2 prescribes. */
async function normalizeErrorStatus(response: Response): Promise<Response> {
  if (response.status !== 401) return response;
  if (!(response.headers.get("content-type") ?? "").includes("application/json")) return response;

  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    return response;
  }
  const error = (body as { error?: unknown } | null)?.error;
  if (typeof error !== "string" || !BAD_REQUEST_ERRORS.has(error)) return response;

  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(JSON.stringify(body), { status: 400, headers });
}

function invalidTarget(resource: string): Response {
  return Response.json(
    {
      error: "invalid_target",
      error_description: `The requested resource "${resource}" is not served by this authorization server.`,
    },
    { status: 400, headers: { "Cache-Control": "no-store", Pragma: "no-cache" } },
  );
}

/**
 * Replace the opaque access token in a successful token response with an
 * audience-bound JWT. Returns the response to send. Any failure leaves the
 * plugin's response untouched — a token that works without an audience is
 * strictly better than a failed authorization.
 */
async function bindAudience(response: Response, audience: string, issuer: string): Promise<Response> {
  const body = (await response.clone().json()) as Record<string, unknown>;
  const opaque = body.access_token;
  if (typeof opaque !== "string" || opaque.length === 0) return response;

  const row = await repos.oauth.findAccessToken(opaque);
  if (!row?.userId) return response;

  const now = Math.floor(Date.now() / 1000);
  const jwt = signMcpAccessToken({
    iss: issuer,
    sub: row.userId,
    aud: audience,
    iat: now,
    exp: Math.floor(row.accessTokenExpiresAt.getTime() / 1000),
    jti: opaque,
    client_id: row.clientId,
    scope: row.scopes,
  });

  if (!(await repos.oauth.rebindAccessToken(opaque, jwt))) return response;

  const next: Record<string, unknown> = { ...body, access_token: jwt };
  if (typeof body.id_token === "string") {
    const reissued = await reissueIdToken(
      body.id_token,
      issuer,
      row.clientId,
      row.userId,
      row.accessTokenExpiresAt,
    );
    if (reissued) next.id_token = reissued;
  }

  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(JSON.stringify(next), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Handle an MCP token request. `request` is the (already redirect-normalized)
 * request that would otherwise go straight to `auth.handler`.
 */
export async function handleMcpTokenRequest(request: Request): Promise<Response> {
  const origin = publicOriginFor(request);
  const resource = await readResourceParam(request);
  if (resource && !isAllowedMcpResource(resource, origin)) return invalidTarget(resource);

  const response = await auth.handler(request);
  if (response.status !== 200) return normalizeErrorStatus(response);
  if (!(response.headers.get("content-type") ?? "").includes("application/json")) return response;

  try {
    return await bindAudience(response, resolveTokenAudience(resource, origin), origin);
  } catch {
    // Never turn a successful grant into a failure over the audience rebind.
    return response;
  }
}
