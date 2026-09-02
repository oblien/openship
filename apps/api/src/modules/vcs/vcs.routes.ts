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
  { tag: "github:list" },
  (c) => ctrl.listOrgRepos(c.req.param("provider")!)(c),
);

/* ─── Repositories ─────────────────────────────────────────────────────── */
r.get(
  "/:provider/repos",
  { tag: "github:list" },
  (c) => ctrl.listRepos(c.req.param("provider")!)(c),
);
r.get(
  "/:provider/repos/:owner/:repo",
  { tag: "github:read" },
  (c) => ctrl.getRepo(c.req.param("provider")!)(c),
);

/* ─── Branches ─────────────────────────────────────────────────────────── */
r.get(
  "/:provider/repos/:owner/:repo/branches",
  { tag: "github:list" },
  (c) => ctrl.listBranches(c.req.param("provider")!)(c),
);

/* ─── Stack detection ──────────────────────────────────────────────────── */
r.get(
  "/:provider/repos/:owner/:repo/detect",
  {
    tag: "github:read",
  },
  (c) => ctrl.detectStack(c.req.param("provider")!)(c),
);

/* ─── Clone token (short-lived GitHub App installation token) ──────────── */
r.get(
  "/:provider/repos/:owner/:repo/clone-token",
  { tag: "github:read", source: "content-whole" },
  (c) => ctrl.getCloneToken(c.req.param("provider")!)(c),
);

/* ─── Files ────────────────────────────────────────────────────────────── */
r.get(
  "/:provider/repos/:owner/:repo/files",
  {
    tag: "github:list",
    source: "content-tree",
  },
  (c) => ctrl.listFiles(c.req.param("provider")!)(c),
);
r.get(
  "/:provider/repos/:owner/:repo/tree",
  { tag: "github:list", source: "content-tree" },
  (c) => ctrl.listTree(c.req.param("provider")!)(c),
);
r.get(
  "/:provider/repos/:owner/:repo/file",
  {
    tag: "github:read",
    source: "content",
  },
  (c) => ctrl.getFile(c.req.param("provider")!)(c),
);

/* ─── Repo Webhooks ────────────────────────────────────────────────────── */
r.get(
  "/:provider/repos/:owner/:repo/webhooks",
  { tag: "github:list" },
  (c) => ctrl.listWebhooks(c.req.param("provider")!)(c),
);
r.post("/:provider/repos/:owner/:repo/webhooks", { tag: "github:write" }, (c) => ctrl.registerWebhook(c.req.param("provider")!)(c));
r.delete("/:provider/repos/:owner/:repo/webhooks", { tag: "github:admin" }, (c) => ctrl.deleteWebhook(c.req.param("provider")!)(c));

export const vcsRoutes = r.hono;
