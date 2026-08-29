/**
 * Object-storage routes — mounted at /api/projects/:id/storage in app.ts.
 *
 * Project-scoped (`:id` = the app the bucket is bound to). Same shape as the
 * service-connection router: standard project permission tags plus
 * `cloudProjectProxy`, with the source-app read check done in the service.
 */

import { Hono } from "hono";
import { secureRouter } from "../../lib/secure-router";
import { cloudProjectProxy } from "../../lib/cloud/project-router";
import * as ctrl from "./project-storage.controller";
import { BindObjectStorageBody } from "./project-storage.schema";

const r = secureRouter(new Hono(), {
  module: "projects",
  basePath: "/api/projects/:id/storage",
});

r.get(
  "/",
  {
    tag: "project:read",
    mcp: {
      description:
        "Read this project's object-storage binding (S3 bucket wired into its filesystem config) and what could be bound.",
    },
  },
  cloudProjectProxy,
  ctrl.get,
);

r.post(
  "/",
  {
    tag: "project:write",
    body: BindObjectStorageBody,
    mcp: {
      description:
        "Bind an S3 bucket to this project — either an installed MinIO app or an external provider. Verifies the bucket, then injects the framework's storage env vars.",
    },
  },
  cloudProjectProxy,
  ctrl.bind,
);

r.delete(
  "/",
  {
    tag: "project:admin",
    mcp: { description: "Remove the object-storage binding and the env vars it injected." },
  },
  cloudProjectProxy,
  ctrl.unbind,
);

export const projectStorageRoutes = r.hono;
