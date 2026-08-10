/**
 * Apps routes — mounted at /api/apps in app.ts.
 *
 * The one-click app catalog + installer. Works on self-hosted and cloud (apps
 * install as normal services projects), so NOT gated localOnly.
 */

import { Hono } from "hono";
import { secureRouter } from "../../lib/secure-router";
import * as ctrl from "./app.controller";
import { InstallAppBody, AddCustomAppBody } from "./app.schema";

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
r.get(
  "/custom",
  { tag: "project:list", mcp: { description: "List this org's custom (user-uploaded, unverified) apps." } },
  ctrl.listCustom,
);
r.post(
  "/custom",
  {
    tag: "project:write",
    collection: true,
    body: AddCustomAppBody,
    mcp: { description: "Add a custom app from an uploaded JSON definition (stored per-org, unverified)." },
  },
  ctrl.addCustom,
);
r.delete(
  "/custom/:appId",
  { tag: "project:write", mcp: { description: "Remove a custom app from this org's catalog." } },
  ctrl.removeCustom,
);
r.post(
  "/",
  {
    tag: "project:write",
    collection: true,
    projectCreate: true,
    body: InstallAppBody,
    mcp: {
      description:
        "Install an app from the catalog as a project (or return a flow route for wizard apps). Public hostnames come ONLY from `routes` — omit it and the app installs port-only (no domain is invented).",
    },
  },
  ctrl.install,
);

export const appRoutes = r.hono;
