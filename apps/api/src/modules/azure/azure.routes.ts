/**
 * Azure DevOps routes — self-hosted only.
 * Mounted at /api/azure.
 */

import { Hono } from "hono";
import { secureRouter } from "../../lib/secure-router";
import * as ctrl from "./azure.controller";

const r = secureRouter(new Hono(), {
  module: "azure",
  basePath: "/api/azure",
});

r.get("/status", { tag: "azure:read", localOnly: true }, ctrl.getStatus);
r.post("/connections", { tag: "azure:write", localOnly: true }, ctrl.saveToken);
r.delete("/connections/:org", { tag: "azure:admin", localOnly: true }, ctrl.deleteConnection);

r.get("/orgs", { tag: "azure:list", localOnly: true }, ctrl.listOrgs);
r.get("/orgs/:org/repos", { tag: "azure:list", localOnly: true }, ctrl.listRepos);
r.get(
  "/repos/:org/:project/:repo/branches",
  { tag: "azure:list", localOnly: true },
  ctrl.listBranches,
);
r.get(
  "/repos/:org/:project/:repo/detect",
  { tag: "azure:read", localOnly: true },
  ctrl.detectStack,
);
r.post(
  "/repos/:org/:project/:repo/webhooks",
  { tag: "azure:write", localOnly: true },
  ctrl.registerWebhook,
);
r.delete(
  "/repos/:org/:project/:repo/webhooks",
  { tag: "azure:admin", localOnly: true },
  ctrl.deleteWebhook,
);

export const azureRoutes = r.hono;
