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

r.post(
  "/",
  {
    tag: "project:write",
    mcp: { description: "Connect a database app into this project (inject its connection URL as a secret env)." },
  },
  cloudProjectProxy,
  ctrl.create,
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
