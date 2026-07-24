/**
 * Apps routes — mounted at /api/apps in app.ts.
 *
 * The one-click app catalog + installer. Works on self-hosted and cloud (apps
 * install as normal services projects), so NOT gated localOnly.
 */

import { Hono } from "hono";
import { secureRouter } from "../../lib/secure-router";
import * as ctrl from "./app.controller";

const r = secureRouter(new Hono(), {
  module: "apps",
  basePath: "/api/apps",
});

r.get(
  "/catalog",
  { tag: "project:list", mcp: { description: "List the one-click app catalog (Convex, WordPress, mail, …)." } },
  ctrl.catalog,
);
r.get(
  "/catalog/:id",
  { tag: "project:list", mcp: { description: "Get one app's full template (services, config, endpoints) by id." } },
  ctrl.catalogEntry,
);
r.post(
  "/",
  {
    tag: "project:write",
    collection: true,
    projectCreate: true,
    mcp: { description: "Install an app from the catalog as a project (or return a flow route for wizard apps)." },
  },
  ctrl.install,
);

export const appRoutes = r.hono;
