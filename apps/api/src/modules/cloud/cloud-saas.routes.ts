import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { rateLimiter } from "../../middleware/rate-limiter";
import { secureRouter } from "../../lib/secure-router";
import { cloudSessionAuth } from "./cloud-session-auth";
import * as saas from "./cloud-saas.controller";

/** SaaS-only cloud routes. */
const r = secureRouter(new Hono(), {
  module: "cloud-saas",
  basePath: "/api/cloud",
});

// PUBLIC handoff endpoints — arrive from browser redirects with signed tokens
r.public("get", "/desktop-handoff", { reason: "Desktop handoff redirect - signed token in URL, no session" }, saas.desktopHandoff);
r.public("get", "/connect-handoff", { reason: "Connect handoff redirect - validates params and 302s to dashboard consent page" }, saas.connectHandoff);
// POST /connect-authorize is called from the dashboard consent page. It
// performs the session check inline (cookie-based) and 401s if missing,
// which the page handles by routing the user to /login?returnTo=...
// Marked public here so the secure-router doesn't add an extra auth
// layer — the controller is the authority on this endpoint.
r.public("post", "/connect-authorize", { reason: "Connect authorize - cookie session checked inline by controller; 401s drive dashboard login redirect" }, saas.connectAuthorize);

r.use("/exchange-code", rateLimiter);
r.public("post", "/exchange-code", { reason: "OAuth code exchange - validated by single-use code, not session" }, saas.exchangeCode);

// Device/poll flow: a headless CLI (over SSH) polls here with its unguessable
// `state` to pick up its one-time PKCE code — no browser redirect to the box.
r.use("/connect-poll", rateLimiter);
r.public("get", "/connect-poll", { reason: "Device-flow poll - CLI retrieves its one-time PKCE code by unguessable state; no session" }, saas.connectPoll);

r.use("/token", cloudSessionAuth);
r.post("/token", { tag: "cloud:write" }, saas.getToken);

r.use("/account", cloudSessionAuth);
r.get("/account", { tag: "cloud:read" }, saas.account);

r.use("/disconnect", cloudSessionAuth);
r.post("/disconnect", { tag: "cloud:admin" }, saas.disconnect);

r.use("/preflight", cloudSessionAuth);
r.post("/preflight", { tag: "cloud:write" }, saas.preflight);

r.use("/edge-proxy", cloudSessionAuth);
r.use("/edge-proxy/*", cloudSessionAuth);
r.post("/edge-proxy", { tag: "cloud:write" }, saas.syncEdgeProxy);
r.post("/edge-proxy/delete", { tag: "cloud:write" }, saas.deleteEdgeProxy);
// Target verification. `cloud:write` deliberately: these MUTATE upstream state
// (issue a challenge, run a probe), and the route scanner makes a POST with a
// read tag boot-fatal. Covered by the /edge-proxy/* auth above.
r.post("/edge-proxy/verify", { tag: "cloud:write" }, saas.requestEdgeVerification);
r.post("/edge-proxy/verify-check", { tag: "cloud:write" }, saas.checkEdgeVerification);

r.use("/analytics", cloudSessionAuth);
r.post("/analytics", { tag: "cloud:write" }, saas.analyticsProxy);

r.use("/pages", cloudSessionAuth);
r.use("/pages/*", cloudSessionAuth);
r.post("/pages", { tag: "cloud:write" }, saas.pagesProxy);
r.post("/pages/disable", { tag: "cloud:write" }, saas.pagesDisable);
r.post("/pages/enable", { tag: "cloud:write" }, saas.pagesEnable);
r.post("/pages/delete", { tag: "cloud:write" }, saas.pagesDelete);

r.use("/send-invitation", cloudSessionAuth);
r.post("/send-invitation", { tag: "cloud:write" }, saas.sendInvitation);

// Unified subgraph ingest/export — used by team-mode migration
// Path B (org-scope) AND project transfer (project-scope). One pair
// of endpoints handles both flows via the SubgraphScope discriminator.
// Rate limit: defense against repeated junk ingest filling storage; bounded blast radius via remapOrgId but still operationally hostile
r.use("/ingest-subgraph", rateLimiter);
// 50MB body cap — subgraph dumps are bounded in practice (project/org scope, JSON rows);
// reject oversized payloads BEFORE auth so DoS uploaders can't burn auth/DB cycles.
r.use("/ingest-subgraph", bodyLimit({
  maxSize: 50_000_000,
  onError: (c) => c.json({
    error: "Dump exceeds 50MB limit on this endpoint.",
    code: "PAYLOAD_TOO_LARGE",
  }, 413),
}));
r.use("/ingest-subgraph", cloudSessionAuth);
r.post("/ingest-subgraph", { tag: "cloud:admin" }, saas.ingestSubgraphHandler);

// Rate limit: throttle scope-enumeration / exfiltration attempts (a
// compromised cloud session could otherwise loop over scopes to map
// the caller's org out as fast as the API responds).
r.use("/export-subgraph", rateLimiter);
r.use("/export-subgraph", cloudSessionAuth);
r.post("/export-subgraph", { tag: "cloud:admin" }, saas.exportSubgraphHandler);

// Delete a project's rows on the SaaS (bring-home cleanup + promote reconcile).
// Ownership is enforced in the service; rate-limited like the other data ops.
r.use("/teardown-project", rateLimiter);
r.use("/teardown-project", cloudSessionAuth);
r.post("/teardown-project", { tag: "cloud:admin" }, saas.teardownProjectHandler);

// ─── GitHub App proxy (cloud holds the App private key) ───────────────────
// All endpoints below are what self-hosted instances call via cloud-client.
// Cloud signs JWTs / mints install tokens; local never holds App creds.
//
// PUBLIC endpoints (no session auth) — the user's browser arrives here
// directly from github.com / from a popup with no SaaS session cookie.
// Auth is a single-use random token in the URL. Register these BEFORE
// the cloudSessionAuth middleware so it isn't gated.
r.public("get", "/github/install-callback", { reason: "GitHub App install callback - validated by state token in URL" }, saas.githubInstallCallback);
r.public("get", "/github/oauth-bridge", { reason: "GitHub OAuth bridge redirect - validated by state token, no session" }, saas.githubOauthBridge);
r.public("get", "/github/oauth-success", { reason: "GitHub OAuth success page - validated by single-use token in URL" }, saas.githubOauthSuccess);

r.use("/github/*", cloudSessionAuth);
r.post("/github/oauth-handoff", { tag: "cloud:write" }, saas.githubOauthHandoff);
r.post("/github/install-url", { tag: "cloud:write" }, saas.githubInstallUrl);
r.get("/github/installations", { tag: "cloud:read" }, saas.githubInstallations);
r.post("/github/installation-token", { tag: "cloud:write" }, saas.githubInstallationToken);
r.get("/github/user-status", { tag: "cloud:read" }, saas.githubUserStatus);

export const cloudSaasRoutes = r.hono;

