/**
 * GitLab routes — mounted at /api/gitlab.
 */

import { Hono } from "hono";
import { secureRouter } from "../../lib/secure-router";
import * as ctrl from "./gitlab.controller";

const r = secureRouter(new Hono(), {
  module: "gitlab",
  basePath: "/api/gitlab",
});

r.get("/status", { tag: "gitlab:read", mcp: { description: "GitLab connection status." } }, ctrl.getStatus);
r.get("/home", { tag: "gitlab:read", mcp: { description: "GitLab home: connection, namespaces, and projects." } }, ctrl.getHome);
r.post("/connect", { tag: "gitlab:write" }, ctrl.connect);
r.public("get", "/connect/redirect", { reason: "GitLab OAuth callback - session may be mid-link" }, ctrl.connectRedirect);
r.post("/disconnect", { tag: "gitlab:admin" }, ctrl.disconnect);

r.get("/namespaces", { tag: "gitlab:list", mcp: { description: "List GitLab namespaces (user + groups)." } }, ctrl.listNamespaces);
r.get("/projects", { tag: "gitlab:list", mcp: { description: "List GitLab projects." } }, ctrl.listProjects);
r.get("/projects/:projectId", { tag: "gitlab:read" }, ctrl.getProject);
r.get("/projects/:projectId/branches", { tag: "gitlab:list", mcp: { description: "List branches for a GitLab project." } }, ctrl.listBranches);
r.post("/projects/:projectId/webhooks", { tag: "gitlab:write" }, ctrl.registerWebhook);
r.get("/projects/:projectId/clone-token", { tag: "gitlab:read" }, ctrl.getCloneToken);
r.get("/parse-url", { tag: "gitlab:read" }, ctrl.parseUrl);

export const gitlabRoutes = r.hono;
