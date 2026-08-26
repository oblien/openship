import { Hono } from "hono";
import { secureRouter } from "../../lib/secure-router";
import * as ctrl from "./vcs.controller";

const r = secureRouter(new Hono(), {
  module: "vcs",
  basePath: "/api/vcs",
});

/* ─── Accounts / Organisations ─────────────────────────────────────────── */
r.get(
  "/:provider/orgs/:org/repos",
  { tag: "github:list", mcp: { description: "List repositories in a VCS org/account." } },
  ctrl.listOrgRepos,
);

/* ─── Repositories ─────────────────────────────────────────────────────── */
r.get(
  "/:provider/repos",
  { tag: "github:list", mcp: { description: "List the connected account's VCS repositories." } },
  ctrl.listRepos,
);
r.get(
  "/:provider/repos/:owner/:repo",
  { tag: "github:read", mcp: { description: "Get a VCS repository's metadata." } },
  ctrl.getRepo,
);

/* ─── Branches ─────────────────────────────────────────────────────────── */
r.get(
  "/:provider/repos/:owner/:repo/branches",
  { tag: "github:list", mcp: { description: "List a repository's branches." } },
  ctrl.listBranches,
);

/* ─── Stack detection ──────────────────────────────────────────────────── */
r.get(
  "/:provider/repos/:owner/:repo/detect",
  {
    tag: "github:read",
    mcp: {
      description: "Detect a repo's build config without reading its files.",
    },
  },
  ctrl.detectStack,
);

/* ─── Clone token (short-lived GitHub App installation token) ──────────── */
r.get(
  "/:provider/repos/:owner/:repo/clone-token",
  { tag: "github:read", source: "content-whole" },
  ctrl.getCloneToken,
);

/* ─── Files ────────────────────────────────────────────────────────────── */
r.get(
  "/:provider/repos/:owner/:repo/files",
  {
    tag: "github:list",
    source: "content-tree",
    mcp: {
      description:
        "List files/dirs at a path in a repo (query: path, ref). Requires repo content access.",
    },
  },
  ctrl.listFiles,
);
r.get(
  "/:provider/repos/:owner/:repo/tree",
  { tag: "github:list", source: "content-tree" },
  ctrl.listTree,
);
r.get(
  "/:provider/repos/:owner/:repo/file",
  {
    tag: "github:read",
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
  "/:provider/repos/:owner/:repo/webhooks",
  { tag: "github:list", mcp: { description: "List a repo's webhooks." } },
  ctrl.listWebhooks,
);
r.post("/:provider/repos/:owner/:repo/webhooks", { tag: "github:write" }, ctrl.registerWebhook);
r.delete("/:provider/repos/:owner/:repo/webhooks", { tag: "github:admin" }, ctrl.deleteWebhook);

export const vcsRoutes = r.hono;
