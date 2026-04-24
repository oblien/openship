/**
 * GitHub routes — all authenticated GitHub endpoints.
 *
 * Mounted at /api/github in app.ts.
 * Every route goes through authMiddleware (session required).
 *
 * TypeBox validation is applied at the route level using typebox-validator
 * for params/query/body where applicable.
 */

import { Hono } from "hono";
import { authMiddleware, localOnly } from "../../middleware";
import * as ctrl from "./github.controller";

export const githubRoutes = new Hono();

/* All GitHub routes require authentication */
githubRoutes.use("*", authMiddleware);

/* ─── Status / Connection ──────────────────────────────────────────────── */
githubRoutes.get("/status", ctrl.getStatus);
githubRoutes.get("/local-status", localOnly, ctrl.getLocalStatus);
githubRoutes.get("/connect/poll", localOnly, ctrl.pollConnect);
githubRoutes.get("/home", ctrl.getHome);
githubRoutes.post("/connect", ctrl.connect);
githubRoutes.get("/connect/redirect", ctrl.connectRedirect);
githubRoutes.post("/disconnect", ctrl.disconnect);

/* ─── Accounts / Organisations ─────────────────────────────────────────── */
githubRoutes.get("/accounts", ctrl.listAccounts);
githubRoutes.get("/orgs", ctrl.listOrgs);
githubRoutes.get("/orgs/repos", ctrl.listOrgsWithRepos);
githubRoutes.get("/orgs/:org/repos", ctrl.listOrgRepos);

/* ─── Repositories ─────────────────────────────────────────────────────── */
githubRoutes.get("/repos", ctrl.listRepos);
githubRoutes.post("/repos", ctrl.createRepo);
githubRoutes.get("/repos/:owner/:repo", ctrl.getRepo);
githubRoutes.delete("/repos/:owner/:repo", ctrl.deleteRepo);

/* ─── Branches ─────────────────────────────────────────────────────────── */
githubRoutes.get("/repos/:owner/:repo/branches", ctrl.listBranches);

/* ─── Files ────────────────────────────────────────────────────────────── */
githubRoutes.get("/repos/:owner/:repo/files", ctrl.listFiles);
githubRoutes.get("/repos/:owner/:repo/file", ctrl.getFile);

/* ─── Repo Webhooks ────────────────────────────────────────────────────── */
githubRoutes.get("/repos/:owner/:repo/webhooks", ctrl.listWebhooks);
githubRoutes.post("/repos/:owner/:repo/webhooks", ctrl.registerWebhook);
githubRoutes.delete("/repos/:owner/:repo/webhooks", ctrl.deleteWebhook);
