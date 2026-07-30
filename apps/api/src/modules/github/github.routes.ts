/**
 * GitHub routes - all authenticated GitHub endpoints.
 *
 * Mounted at /api/github in app.ts. Every permission-tagged route
 * runs authMiddleware (auto-injected by secureRouter) which also
 * resolves the active organization id onto context — required by
 * tokenFor's self-hosted gh-cli operator-vs-member gate.
 *
 * The only public route here is /connect/redirect, the GitHub OAuth
 * callback, which intentionally has no user session yet.
 */

import { Hono } from "hono";
import { secureRouter } from "../../lib/secure-router";
import * as ctrl from "./github.controller";

const r = secureRouter(new Hono(), {
  module: "github",
  basePath: "/api/github",
});

/* ─── Status / Connection ──────────────────────────────────────────────── */
r.get("/status", { tag: "github:read", mcp: { description: "GitHub connection status for the org." } }, ctrl.getStatus);
r.get("/local-status", { tag: "github:read", localOnly: true }, ctrl.getLocalStatus);
r.get("/connect/poll", { tag: "github:read", localOnly: true }, ctrl.pollConnect);
r.get("/home", { tag: "github:read", mcp: { description: "GitHub home: connection state, accounts, and repos in one call." } }, ctrl.getHome);
r.post("/connect", { tag: "github:write" }, ctrl.connect);
r.public("get", "/connect/redirect", { reason: "GitHub OAuth callback - no session yet during redirect" }, ctrl.connectRedirect);
r.post("/disconnect", { tag: "github:admin" }, ctrl.disconnect);
// Instance-wide git identity from a pasted token — the no-setup path when this
// instance has no device client id. `localOnly` because CLOUD_MODE has no such
// identity; `github:admin` because it sets a credential for the whole instance.
r.post("/instance-token", { tag: "github:admin", localOnly: true }, ctrl.setInstanceToken);

/* ─── Accounts / Organisations ─────────────────────────────────────────── */
// /home returns { state, accounts, repos } in one round trip — the
// dashboard's only entry point.
r.get("/orgs/:org/repos", { tag: "github:list", mcp: { description: "List repositories in a GitHub org/account." } }, ctrl.listOrgRepos);

/* ─── Repositories ─────────────────────────────────────────────────────── */
r.get("/repos", { tag: "github:list", mcp: { description: "List the connected account's GitHub repositories." } }, ctrl.listRepos);
r.post("/repos", { tag: "github:write" }, ctrl.createRepo);
r.get("/repos/:owner/:repo", { tag: "github:read", mcp: { description: "Get a GitHub repository's metadata." } }, ctrl.getRepo);
r.delete("/repos/:owner/:repo", { tag: "github:admin" }, ctrl.deleteRepo);

/* ─── Branches ─────────────────────────────────────────────────────────── */
r.get("/repos/:owner/:repo/branches", { tag: "github:list", mcp: { description: "List a repository's branches." } }, ctrl.listBranches);

/* ─── Clone token (short-lived GitHub App installation token) ──────────── */
r.get("/repos/:owner/:repo/clone-token", { tag: "github:read" }, ctrl.getCloneToken);

/* ─── Files ────────────────────────────────────────────────────────────── */
r.get("/repos/:owner/:repo/files", { tag: "github:list", mcp: { description: "List files/dirs at a path in a repo (query: path, ref)." } }, ctrl.listFiles);
r.get("/repos/:owner/:repo/file", { tag: "github:read", mcp: { description: "Read a single file's contents from a repo (to detect stack / read config)." } }, ctrl.getFile);

/* ─── Repo Webhooks ────────────────────────────────────────────────────── */
r.get("/repos/:owner/:repo/webhooks", { tag: "github:list", mcp: { description: "List a repo's webhooks (to check push auto-deploy wiring)." } }, ctrl.listWebhooks);
r.post("/repos/:owner/:repo/webhooks", { tag: "github:write" }, ctrl.registerWebhook);
r.delete("/repos/:owner/:repo/webhooks", { tag: "github:admin" }, ctrl.deleteWebhook);

export const githubRoutes = r.hono;

