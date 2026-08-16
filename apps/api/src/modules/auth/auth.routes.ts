/**
 * Auth API — mounted at /api/auth in app.ts.
 *
 * Two surfaces:
 *   1. **Desktop-mode endpoints** (gated by env.DEPLOY_MODE === "desktop")
 *      — bootstrap zero-auth session + cloud OAuth handoff.
 *   2. **Better Auth catch-all** — every standard endpoint
 *      (sign-in/up, organization plugin, OAuth callbacks, etc.) is
 *      delegated to Better Auth's handler.
 *
 * Handlers live in auth.controller.ts; this file is route wiring only.
 */

import { Hono } from "hono";
import { db, eq, repos, schema } from "@repo/db";
import { env } from "../../config/env";
import { auth, isSaasDeployment } from "../../lib/auth";
import { normalizeMcpRedirectUri } from "../../lib/oauth-redirect";
import { isLoopbackRequest } from "../../middleware/loopback-peer";
import * as ctrl from "./auth.controller";
import { handleMcpTokenRequest } from "./mcp-token.handler";

export const authRoutes = new Hono();

if (env.DEPLOY_MODE === "desktop") {
  authRoutes.get("/get-session", ctrl.getSession);
  authRoutes.get("/desktop-login", ctrl.desktopLogin);
}

// Invite-only sign-up guard (runs BEFORE the Better Auth catch-all). SaaS keeps
// open public signup. On self-host the ONLY Better Auth signup allowed is the
// FIRST account and only from loopback (CLI bootstrap / local dev) — this closes
// the remote first-admin race and public invite-hijack signup. Every other new
// account is created via the token-bound POST /api/system/invite-signup, so a
// remote peer can never create an account through /sign-up here.
authRoutes.on("POST", "/sign-up/*", async (c, next) => {
  if (isSaasDeployment) return next();
  const [anyUser] = await db.select({ id: schema.user.id }).from(schema.user).limit(1);
  if (!anyUser && isLoopbackRequest(c)) return next();
  return c.json(
    {
      error: "Public sign-up is disabled on this instance. Use your invitation link to join.",
      code: "SIGNUP_DISABLED",
    },
    403,
  );
});

// The mcp() plugin's discovery metadata advertises `jwks_uri` and
// `userinfo_endpoint` under /api/auth/mcp/* but implements NEITHER — both fell
// through to the catch-all and 404'd. A verifying OAuth client (Claude.ai)
// fetches the jwks to validate the id_token; an empty answer kills the
// connection right after the token exchange. Serve them here, BEFORE the
// catch-all. The key is the instance's persistent RS256 keypair that also
// signs the (re-issued) id_token — see lib/mcp-oidc-keys.ts.
authRoutes.get("/mcp/jwks", async (c) => {
  const { getMcpSigningKey } = await import("../../lib/mcp-oidc-keys");
  const key = await getMcpSigningKey();
  return c.json(
    { keys: [key.publicJwk] },
    200,
    { "Cache-Control": "public, max-age=3600", "Access-Control-Allow-Origin": "*" },
  );
});

authRoutes.get("/mcp/userinfo", async (c) => {
  const token = c.req.header("authorization")?.replace(/^Bearer /i, "");
  if (!token) {
    return c.json({ error: "invalid_token" }, 401, { "WWW-Authenticate": "Bearer" });
  }
  const row = await repos.oauth.findAccessToken(token);
  if (!row?.userId || row.accessTokenExpiresAt < new Date()) {
    return c.json({ error: "invalid_token" }, 401, { "WWW-Authenticate": "Bearer" });
  }
  const user = await repos.user.findById(row.userId);
  if (!user) return c.json({ error: "invalid_token" }, 401, { "WWW-Authenticate": "Bearer" });
  const scopes = row.scopes.split(" ");
  return c.json({
    sub: user.id,
    ...(scopes.includes("profile") ? { name: user.name } : {}),
    ...(scopes.includes("email") ? { email: user.email, email_verified: user.emailVerified } : {}),
  });
});

// Better Auth catch-all — must be last so the desktop overrides + signup guard win.
authRoutes.on(["GET", "POST"], "/*", async (c) => {
  const request = await normalizeMcpRedirectUri(c.req.raw, async (clientId) => {
    const [client] = await db
      .select({ redirectUrls: schema.oauthApplication.redirectUrls })
      .from(schema.oauthApplication)
      .where(eq(schema.oauthApplication.clientId, clientId))
      .limit(1);
    return client?.redirectUrls.split(",");
  });
  // MCP token grants go through the RFC 8707 wrapper (validates `resource`,
  // audience-binds the issued token) before reaching the plugin. Everything
  // else is delegated verbatim.
  if (c.req.method === "POST" && new URL(request.url).pathname.endsWith("/mcp/token")) {
    return handleMcpTokenRequest(request);
  }
  return auth.handler(request);
});
