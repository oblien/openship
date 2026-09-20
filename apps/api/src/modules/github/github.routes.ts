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
import * as sourceCtrl from "./github-source.controller";
import {
  GitHubSourceManifestBody,
  GitHubSourceManifestConvertBody,
  GitHubSourceManualBody,
  GitHubSourceUpdateBody,
} from "@repo/contracts";

const r = secureRouter(new Hono(), {
  module: "github",
  basePath: "/api/github",
});

/* ─── Status / Connection ──────────────────────────────────────────────── */
r.get(
  "/status",
  { tag: "github:read", authorizationHandledByOperation: true, auditHandledByOperation: true, mcp: { description: "GitHub connection status for the org." } },
  ctrl.getStatus,
);
r.get("/local-status", { tag: "github:read", authorizationHandledByOperation: true, auditHandledByOperation: true, localOnly: true }, ctrl.getLocalStatus);
r.get("/connect/poll", { tag: "github:read", authorizationHandledByOperation: true, auditHandledByOperation: true, localOnly: true }, ctrl.pollConnect);
r.get(
  "/home",
  {
    tag: "github:read", authorizationHandledByOperation: true, auditHandledByOperation: true,
    mcp: { description: "GitHub home: connection state, accounts, and repos in one call." },
  },
  ctrl.getHome,
);
r.post("/connect", { tag: "github:write", authorizationHandledByOperation: true, auditHandledByOperation: true }, ctrl.connect);
r.post(
  "/installations/claim",
  { tag: "github:write", authorizationHandledByOperation: true, auditHandledByOperation: true, localOnly: true },
  ctrl.claimInstallation,
);
r.public(
  "get",
  "/connect/redirect",
  { reason: "GitHub OAuth callback - no session yet during redirect" },
  ctrl.connectRedirect,
);
r.post("/disconnect", { tag: "github:admin", authorizationHandledByOperation: true, auditHandledByOperation: true }, ctrl.disconnect);
// Instance-wide git identity from a pasted token — the no-setup path when this
// instance has no device client id. `localOnly` because CLOUD_MODE has no such
// identity; `github:admin` because it sets a credential for the whole instance.
r.post("/instance-token", { tag: "github:admin", authorizationHandledByOperation: true, auditHandledByOperation: true, localOnly: true }, ctrl.setInstanceToken);

/* ─── Self-hosted GitHub App sources (workspace owner only) ───────────── */
r.get(
  "/sources",
  { tag: "github:admin", authorizationHandledByOperation: true, auditHandledByOperation: true, localOnly: true },
  sourceCtrl.listSources,
);
r.post(
  "/sources/manifest",
  { tag: "github:admin", authorizationHandledByOperation: true, auditHandledByOperation: true, localOnly: true, body: GitHubSourceManifestBody },
  sourceCtrl.beginManifest,
);
r.post(
  "/sources/manifest/convert",
  { tag: "github:admin", authorizationHandledByOperation: true, auditHandledByOperation: true, localOnly: true, body: GitHubSourceManifestConvertBody },
  sourceCtrl.convertManifest,
);
r.post(
  "/sources/manual",
  { tag: "github:admin", authorizationHandledByOperation: true, auditHandledByOperation: true, localOnly: true, body: GitHubSourceManualBody },
  sourceCtrl.createManual,
);
r.patch(
  "/sources/:id",
  { tag: "github:admin", authorizationHandledByOperation: true, auditHandledByOperation: true, localOnly: true, body: GitHubSourceUpdateBody },
  sourceCtrl.updateSource,
);
r.delete(
  "/sources/:id",
  { tag: "github:admin", authorizationHandledByOperation: true, auditHandledByOperation: true, localOnly: true },
  sourceCtrl.deleteSource,
);
r.post(
  "/sources/:id/verify",
  { tag: "github:admin", authorizationHandledByOperation: true, auditHandledByOperation: true, localOnly: true },
  sourceCtrl.verifySource,
);
r.post(
  "/sources/:id/default",
  { tag: "github:admin", authorizationHandledByOperation: true, auditHandledByOperation: true, localOnly: true },
  sourceCtrl.setDefaultSource,
);
r.post(
  "/sources/:id/install",
  { tag: "github:admin", authorizationHandledByOperation: true, auditHandledByOperation: true, localOnly: true },
  sourceCtrl.createInstallUrl,
);

/* ─── Accounts / Organisations ─────────────────────────────────────────── */
// /home returns { state, accounts, repos } in one round trip — the
// dashboard's only entry point.
r.get(
  "/orgs/:org/repos",
  { tag: "github:list", authorizationHandledByOperation: true, auditHandledByOperation: true, mcp: { description: "List repositories in a GitHub org/account." } },
  ctrl.listOrgRepos,
);

/* ─── Repositories ─────────────────────────────────────────────────────── */
r.get(
  "/repos",
  { tag: "github:list", authorizationHandledByOperation: true, auditHandledByOperation: true, mcp: { description: "List the connected account's GitHub repositories." } },
  ctrl.listRepos,
);
r.post("/repos", { tag: "github:write", authorizationHandledByOperation: true, auditHandledByOperation: true }, ctrl.createRepo);
r.get(
  "/repos/:owner/:repo",
  { tag: "github:read", authorizationHandledByOperation: true, auditHandledByOperation: true, mcp: { description: "Get a GitHub repository's metadata." } },
  ctrl.getRepo,
);
r.delete("/repos/:owner/:repo", { tag: "github:admin", authorizationHandledByOperation: true, auditHandledByOperation: true }, ctrl.deleteRepo);

/* ─── Branches ─────────────────────────────────────────────────────────── */
r.get(
  "/repos/:owner/:repo/branches",
  { tag: "github:list", authorizationHandledByOperation: true, auditHandledByOperation: true, mcp: { description: "List a repository's branches." } },
  ctrl.listBranches,
);

/* ─── Stack detection ──────────────────────────────────────────────────── */
// The deploy-tier alternative to crawling the repo: returns DERIVED config only
// (framework, package manager, commands, output dir, port, compose services) and
// never file bytes. Without this, "deploy-only" would be unusable — configuring a
// git deploy would still require content access.
r.get(
  "/repos/:owner/:repo/detect",
  {
    tag: "github:read", authorizationHandledByOperation: true, auditHandledByOperation: true,
    mcp: {
      description:
        "Detect a repo's build config without reading its files — framework, package manager, install/build/start commands, output directory, port, and compose services. Use this to configure a deploy; it needs no content access.",
    },
  },
  ctrl.detectStack,
);

/* ─── Clone token (short-lived GitHub App installation token) ──────────── */
// `content-whole`: a clone hands over every byte and cannot be path-filtered, so a
// caller scoped to a subtree must NOT be able to mint one.
r.get(
  "/repos/:owner/:repo/clone-token",
  { tag: "github:read", authorizationHandledByOperation: true, auditHandledByOperation: true, source: "content-whole" },
  ctrl.getCloneToken,
);

/* ─── Files ────────────────────────────────────────────────────────────── */
// Both serve repository CONTENT, so both are gated above metadata. `content-tree`
// allows listing a directory that merely LEADS to a granted path (and the handler
// filters the entries); `content` requires the exact file to be granted.
r.get(
  "/repos/:owner/:repo/files",
  {
    tag: "github:list", authorizationHandledByOperation: true, auditHandledByOperation: true,
    source: "content-tree",
    mcp: {
      description:
        "List files/dirs at a path in a repo (query: path, ref). Requires repo content access.",
    },
  },
  ctrl.listFiles,
);
// Recursive tree for the source-access path picker. `content-tree` like /files —
// it lists paths, never bytes — and the handler filters to the caller's own reach.
// No `mcp` block: agents already have /files for browsing, and a recursive dump is
// a dashboard authoring aid, not something to widen the agent surface for.
r.get("/repos/:owner/:repo/tree", { tag: "github:list", authorizationHandledByOperation: true, auditHandledByOperation: true, source: "content-tree" }, ctrl.listTree);
r.get(
  "/repos/:owner/:repo/file",
  {
    tag: "github:read", authorizationHandledByOperation: true, auditHandledByOperation: true,
    source: "content",
    mcp: {
      description:
        "Read a single file's contents from a repo. Requires repo content access; prefer /detect for build config.",
    },
  },
  ctrl.getFile,
);

/* ─── Repo Webhooks ────────────────────────────────────────────────────── */
r.get(
  "/repos/:owner/:repo/webhooks",
  {
    tag: "github:list", authorizationHandledByOperation: true, auditHandledByOperation: true,
    mcp: { description: "List a repo's webhooks (to check push auto-deploy wiring)." },
  },
  ctrl.listWebhooks,
);
r.post("/repos/:owner/:repo/webhooks", { tag: "github:write", authorizationHandledByOperation: true, auditHandledByOperation: true }, ctrl.registerWebhook);
r.delete("/repos/:owner/:repo/webhooks", { tag: "github:admin", authorizationHandledByOperation: true, auditHandledByOperation: true }, ctrl.deleteWebhook);

export const githubRoutes = r.hono;
