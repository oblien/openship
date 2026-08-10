/**
 * Service-connection routes — mounted at /api/projects/:id/connections in app.ts.
 *
 * Project-scoped (`:id` = the consumer/target). Reuses the standard project
 * permission check + `cloudProjectProxy`. The create handler independently
 * asserts read access on the SOURCE app + same-org before injecting its env.
 */

import { Hono } from "hono";
import { secureRouter } from "../../lib/secure-router";
import { cloudProjectProxy } from "../../lib/cloud/project-router";
import * as ctrl from "./project-connection.controller";
import { CreateConnectionBody, CreateBundleBody } from "./project-connection.schema";

const r = secureRouter(new Hono(), {
  module: "projects",
  basePath: "/api/projects/:id/connections",
});

r.get(
  "/",
  {
    tag: "project:read",
    mcp: { description: "List the database/app connections wired into this project." },
  },
  cloudProjectProxy,
  ctrl.list,
);

// Registered BEFORE `/:linkId`-style paths so "consumers" is never captured as an
// id by a future param route on this router.
r.get(
  "/consumers",
  {
    tag: "project:read",
    mcp: {
      description:
        "List the projects that consume THIS app's connection (a shared database has many).",
    },
  },
  cloudProjectProxy,
  ctrl.consumers,
);

r.post(
  "/",
  {
    tag: "project:write",
    body: CreateConnectionBody,
    mcp: { description: "Connect a database app into this project (inject its connection URL as a secret env)." },
  },
  cloudProjectProxy,
  ctrl.create,
);

r.post(
  "/bundle",
  {
    tag: "project:write",
    body: CreateBundleBody,
    mcp: { description: "Wire several outputs from one source app into this project atomically (all-or-nothing)." },
  },
  cloudProjectProxy,
  ctrl.createBundle,
);

r.delete(
  "/:linkId",
  {
    tag: "project:admin",
    mcp: { description: "Remove a database/app connection and its injected env var." },
  },
  cloudProjectProxy,
  ctrl.remove,
);

export const projectConnectionRoutes = r.hono;
