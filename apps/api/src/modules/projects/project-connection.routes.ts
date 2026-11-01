/**
 * Service-connection routes — mounted at /api/projects/:id/connections in app.ts.
 *
 * Project-scoped (`:id` = the consumer/target). Reuses the standard project
 * permission check and shared Cloud resource gateway. The create handler independently
 * asserts write access on the SOURCE app + same-org before injecting its env.
 */

import { Hono } from "hono";
import { secureRouter } from "../../lib/secure-router";
import * as ctrl from "./project-connection.controller";
import { CreateConnectionBody, CreateBundleBody } from "@repo/contracts";

const r = secureRouter(new Hono(), {
  module: "projects",
  basePath: "/api/projects/:id/connections",
});

r.get("/candidates", {
  tag: "project:write",
  mcp: { description: "List projects and apps available for a service connection, filtered by access." },
}, ctrl.candidates);

r.get(
  "/",
  {
    tag: "project:read",
    mcp: { description: "List the database/app connections wired into this project." },
  },
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
  ctrl.consumers,
);

r.post(
  "/",
  {
    tag: "project:write",
    auditHandledByOperation: true,
    body: CreateConnectionBody,
    mcp: { description: "Connect a database app into this project (inject its connection URL as a secret env)." },
  },
  ctrl.create,
);

r.post(
  "/bundle",
  {
    tag: "project:write",
    auditHandledByOperation: true,
    body: CreateBundleBody,
    mcp: { description: "Wire several outputs from one source app into this project atomically (all-or-nothing)." },
  },
  ctrl.createBundle,
);

r.delete(
  "/:linkId",
  {
    tag: "project:admin",
    auditHandledByOperation: true,
    mcp: { description: "Remove a database/app connection and its injected env var." },
  },
  ctrl.remove,
);

export const projectConnectionRoutes = r.hono;
