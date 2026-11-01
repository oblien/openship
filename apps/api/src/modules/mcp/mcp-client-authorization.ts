import { createHash, randomBytes } from "node:crypto";
import { AppError } from "@repo/core";
import { repos } from "@repo/db";
import { app } from "../../app";
import type { RequestContext } from "../../lib/request-context";
import { resolveDashboardPublicUrl } from "@repo/platform/engine/lib/public-url";
import { createProvisionLock } from "@repo/platform/engine/lib/provision-lock";
import { resolveBearerIdentity } from "../../middleware/auth";

export async function mcpOAuthRequest(
  origin: string,
  path: string,
  body: object | URLSearchParams,
) {
  const form = body instanceof URLSearchParams;
  const response = await app.fetch(
    new Request(`${new URL(origin).origin}/api/auth/${path}`, {
      method: "POST",
      headers: { "content-type": form ? "application/x-www-form-urlencoded" : "application/json" },
      body: form ? body.toString() : JSON.stringify(body),
    }),
  );
  if (!response.ok)
    throw new AppError(
      "Could not complete authorization. Please connect again.",
      409,
      "CONNECTION_AUTHORIZATION_FAILED",
    );
  return response.json() as Promise<Record<string, unknown>>;
}
/** Shared registration + PKCE + ordinary consent challenge. Better Auth is the only grant issuer. */
export async function prepareMcpConsent(
  ctx: RequestContext,
  input: { origin: string; name: string; redirectUri: string; state: string },
) {
  const registered = await mcpOAuthRequest(input.origin, "mcp/register", {
    client_name: input.name,
    redirect_uris: [input.redirectUri],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    scope: "openid offline_access",
  });
  if (typeof registered.client_id !== "string")
    throw new AppError("Could not prepare permissions.", 409);
  const clientId = registered.client_id,
    verifier = randomBytes(32).toString("base64url");
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: input.redirectUri,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state: input.state,
    scope: "openid offline_access",
    resource: `${input.origin}/api/mcp`,
    prompt: "consent",
  });
  const headers = new Headers(),
    cookie = ctx.hono?.req.header("cookie");
  if (cookie) headers.set("cookie", cookie);
  const response = await app.fetch(
    new Request(`${new URL(input.origin).origin}/api/auth/mcp/authorize?${params}`, { headers }),
  );
  const location = response.headers.get("location"),
    consent = location ? new URL(location, resolveDashboardPublicUrl()) : null;
  const consentCode = consent?.searchParams.get("consent_code");
  if (
    response.status !== 302 ||
    consent?.pathname !== "/mcp/authorize" ||
    consent.searchParams.get("client_id") !== clientId ||
    !consentCode
  )
    throw new AppError("Could not prepare permissions. Check your session and try again.", 401);
  return { clientId, verifier, consentCode };
}
export async function mcpClientToken(
  input: { userId: string; organizationId: string; clientId: string; origin: string },
  refresh = true,
) {
  return createProvisionLock(`mcp-client-token:${input.clientId}`).run(async () => {
    let row = await repos.oauth.findClientToken(input.userId, input.clientId);
    if (!row)
      throw new AppError(
        "This connection was disconnected. Link your account again.",
        403,
        "CONNECTION_DISABLED",
      );
    if (refresh && row.accessTokenExpiresAt.getTime() <= Date.now() + 30000) {
      if (
        !row.refreshToken ||
        !row.refreshTokenExpiresAt ||
        row.refreshTokenExpiresAt.getTime() <= Date.now()
      )
        throw new AppError(
          "Connection access expired. Link your account again.",
          403,
          "CONNECTION_DISABLED",
        );
      await mcpOAuthRequest(
        input.origin,
        "mcp/token",
        new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: row.refreshToken,
          client_id: input.clientId,
          resource: `${input.origin}/api/mcp`,
        }),
      );
      row = await repos.oauth.findClientToken(input.userId, input.clientId);
    }
    const token = row?.accessToken;
    const identity = token
      ? await resolveBearerIdentity(token, new Headers({ authorization: `Bearer ${token}` }))
      : null;
    if (
      !token ||
      !identity ||
      identity.userId !== input.userId ||
      identity.organizationId !== input.organizationId ||
      !(await repos.member.find(input.organizationId, input.userId))
    )
      throw new AppError(
        "Connection access changed. Review its permissions.",
        403,
        "CONNECTION_ACCESS_CHANGED",
      );
    return token;
  });
}
