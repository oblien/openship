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

import { Hono, type Handler } from "hono";
import { db, eq, schema } from "@repo/db";
import { env } from "@repo/platform/engine/config/env";
import { auth } from "@repo/platform/engine/lib/auth";
import { withMcpIssuer } from "@repo/platform/engine/lib/mcp-issuer";
import { normalizeMcpRedirectUri } from "../../lib/oauth-redirect";
import { authMiddleware } from "../../middleware/auth";
import * as organizationController from "./organization.controller";
import { internalAuth } from "../../middleware/internal-auth";
import { firstSignupGuard } from "../../middleware/local-bootstrap";
import * as ctrl from "./auth.controller";
import { handleMcpTokenRequest } from "./mcp-token.handler";
import { REPOSITORY_OAUTH_STATE_PREFIX } from "@repo/platform/engine/modules/github/github-repository-authorization";

export const authRoutes = new Hono();

if (env.DEPLOY_MODE === "desktop") {
  authRoutes.get("/get-session", ctrl.getSession);
  authRoutes.get("/desktop-login", ctrl.desktopLogin);
  authRoutes.get("/cloud-callback", ctrl.cloudCallback);
  authRoutes.post("/desktop-auth-start", internalAuth, ctrl.desktopAuthStart);
  authRoutes.get("/desktop-auth-poll", ctrl.desktopAuthPoll);
  authRoutes.get("/desktop-claim", ctrl.desktopClaim);
}

// Public by design: the invitation id is an unguessable bearer token and this
// route returns only its claim-page projection. Better Auth's own invitation
// lookup requires a session, which a brand-new invitee cannot have yet.
authRoutes.get("/invitation-preview/:id", ctrl.invitationPreview);

// Compatibility URLs use the same authorized operations as the SDK. The shared
// invitation service owns the serialization boundary.
authRoutes.post("/organization/invite-member", authMiddleware, organizationController.inviteMember);
authRoutes.post("/organization/accept-invitation", authMiddleware, organizationController.acceptInvitation);
authRoutes.post("/organization/reject-invitation", authMiddleware, organizationController.rejectInvitation);
authRoutes.post("/organization/cancel-invitation", authMiddleware, organizationController.cancelInvitation);
authRoutes.post("/organization/update-member-role", authMiddleware, organizationController.updateMemberRole);
authRoutes.post("/organization/remove-member", authMiddleware, organizationController.removeMember);
authRoutes.post("/organization/leave", authMiddleware, organizationController.leaveOrganization);

// Invite-only sign-up guard (runs BEFORE the Better Auth catch-all). SaaS keeps
// open public signup. On self-host the ONLY Better Auth signup allowed is the
// FIRST account on an explicitly local instance and from a loopback peer.
// Public/CLI instances bootstrap through the host-token flow. Every other new
// account is created via the token-bound POST /api/system/invite-signup, so a
// remote peer can never create an account through /sign-up here.
authRoutes.on("POST", "/sign-up/*", firstSignupGuard);

// Better Auth catch-all — must be last so the desktop overrides + signup guard win.
// Reuse the registered GitHub callback. Repository-grant states are separate
// from Better Auth's sign-in states and never create or transfer login links.
authRoutes.get("/callback/github", async (c, next) => {
  if (!env.CLOUD_MODE || !c.req.query("state")?.startsWith(REPOSITORY_OAUTH_STATE_PREFIX)) return next();
  const { finishRepositoryAuthorization } = await import("../github/github-repository.controller");
  return finishRepositoryAuthorization(c);
});

const handleProviderRequest: Handler = async (c) =>
  withMcpIssuer(async () => {
    // Existing MCP clients may cache the 1.6 endpoint URLs. Forward aliases into
    // the provider's new endpoints so PKCE and client authentication stay intact.
    const url = new URL(c.req.url);
    const aliases: Record<string, string> = {
      "/mcp/authorize": "/oauth2/authorize",
      "/mcp/token": "/oauth2/token",
      "/mcp/register": "/oauth2/register",
      "/mcp/jwks": "/jwks",
      "/mcp/userinfo": "/oauth2/userinfo",
    };
    const alias = aliases[url.pathname.slice("/api/auth".length)];
    if (alias) url.pathname = `/api/auth${alias}`;
    const forwarded = new Request(url, c.req.raw);
    const request = await normalizeMcpRedirectUri(forwarded, async (clientId) => {
      const [client] = await db
        .select({ redirectUris: schema.oauthClient.redirectUris })
        .from(schema.oauthClient)
        .where(eq(schema.oauthClient.clientId, clientId))
        .limit(1);
      return client?.redirectUris;
    });
    if (c.req.method === "POST" && url.pathname.endsWith("/oauth2/token")) {
      return handleMcpTokenRequest(request);
    }
    return auth.handler(request);
  });

// Keep these documented compatibility routes explicit in the HTTP inventory.
authRoutes.get("/mcp/jwks", handleProviderRequest);
authRoutes.get("/mcp/userinfo", handleProviderRequest);
authRoutes.on(["GET", "POST"], "/*", handleProviderRequest);
