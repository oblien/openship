import { createLocalJWKSet, jwtVerify } from "jose";
import { reportCaughtError } from "@repo/core/diagnostics";
import { repos } from "@repo/db";
import { auth } from "@repo/platform/engine/lib/auth";
import { mcpIssuer } from "@repo/platform/engine/lib/mcp-issuer";
import {
  allowedMcpResources,
  isAllowedMcpResource,
  resolveTokenAudience,
} from "../../lib/mcp-resource";

/**
 * The 1.7 provider owns signing, audience binding and refresh rotation. Keep an
 * encrypted receipt for host-side assistant/chat connections and immediate
 * disconnects; never re-sign or relax the provider's token validation.
 */
export async function handleMcpTokenRequest(request: Request): Promise<Response> {
  const origin = mcpIssuer();
  const contentType = request.headers.get("content-type") ?? "";
  let params: URLSearchParams;
  try {
    if (contentType.includes("application/json")) {
      const body = await request.clone().json();
      if (!body || typeof body !== "object" || Array.isArray(body)) return auth.handler(request);
      params = new URLSearchParams();
      for (const [key, value] of Object.entries(body)) {
        if (Array.isArray(value)) value.forEach((item) => params.append(key, String(item)));
        else if (typeof value === "string") params.append(key, value);
      }
    } else {
      params = new URLSearchParams(await request.clone().text());
    }
  } catch {
    // diagnostics-ignore: Better Auth validates malformed request bodies and returns the OAuth error.
    return auth.handler(request);
  }
  const resources = params.getAll("resource");
  if (resources.some((resource) => !isAllowedMcpResource(resource, origin))) {
    return Response.json(
      {
        error: "invalid_target",
        error_description: "The resource is not served by this authorization server.",
      },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (!resources.length) params.set("resource", resolveTokenAudience(undefined, origin));
  const headers = new Headers(request.headers);
  headers.set("content-type", "application/x-www-form-urlencoded");
  headers.delete("content-length");
  const response = await auth.handler(new Request(request, { headers, body: params }));
  // Keep the existing RFC 6749 error contract: only invalid_client uses 401.
  if (response.status === 401) {
    const error = (await response
      .clone()
      .json()
      .catch(() => {
        // diagnostics-ignore: An unreadable error body keeps the provider's original response.
        return null;
      })) as { error?: string } | null;
    if (
      [
        "invalid_request",
        "invalid_grant",
        "unauthorized_client",
        "unsupported_grant_type",
        "invalid_scope",
        "invalid_target",
      ].includes(error?.error ?? "")
    ) {
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      return new Response(response.body, { status: 400, headers });
    }
  }
  if (response.status !== 200) return response;

  try {
    const body = (await response.clone().json()) as Record<string, unknown>;
    if (typeof body.access_token !== "string") throw new Error("Missing OAuth access token");
    const { payload } = await jwtVerify(
      body.access_token,
      createLocalJWKSet(await auth.api.getJwks()),
      {
        issuer: origin,
        audience: [...allowedMcpResources(origin)],
        algorithms: ["RS256"],
        requiredClaims: ["sub", "client_id", "sid", "exp", "aud"],
      },
    );
    if (
      typeof payload.sub !== "string" ||
      typeof payload.client_id !== "string" ||
      typeof payload.sid !== "string" ||
      typeof payload.exp !== "number" ||
      payload.cnf
    ) {
      throw new Error("Unsupported MCP token identity or sender constraint");
    }
    await repos.oauth.recordIssuedToken({
      accessToken: body.access_token,
      refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : undefined,
      userId: payload.sub,
      clientId: payload.client_id,
      sessionId: payload.sid,
      scopes: typeof payload.scope === "string" ? payload.scope : "",
      accessTokenExpiresAt: new Date(payload.exp * 1000),
    });
    return response;
  } catch (error) {
    reportCaughtError(error, "api/modules/auth/mcp-token.handler");
    // A token without a recorded receipt cannot authenticate to Openship. Do
    // not return a successful-looking grant that immediately fails at the API.
    return Response.json(
      {
        error: "server_error",
        error_description: "Could not complete authorization. Please connect again.",
      },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
