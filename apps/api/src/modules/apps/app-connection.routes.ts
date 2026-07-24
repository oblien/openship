/**
 * App connection route — mounted at /api/projects/:id/app-connection in app.ts.
 *
 * Scoped to the project (`:id`) so it reuses the standard project permission
 * check + `cloudProjectProxy` (a cloud app's env is canonical on the SaaS, so
 * the proxy forwards there; self-hosted resolves locally). Returns the installed
 * app's connection details (public URL + generated keys) fully resolved.
 */

import { Hono } from "hono";
import { secureRouter } from "../../lib/secure-router";
import { cloudProjectProxy } from "../../lib/cloud/project-router";
import * as ctrl from "./app.controller";

const r = secureRouter(new Hono(), {
  module: "apps",
  basePath: "/api/projects/:id/app-connection",
});

// project:write (NOT read): this returns FULLY DECRYPTED credentials — Supabase
// service_role JWTs, DB passwords embedded in postgres://… URLs — that bypass DB
// RLS. The env listing masks secrets at project:read; this surface can't, so it
// must sit above the read tier (a read-only/viewer grant or project:read MCP
// token must not be able to exfiltrate live credentials).
r.get(
  "/",
  {
    tag: "project:write",
    mcp: { description: "Get an installed app's resolved connection details (URLs + generated keys)." },
  },
  cloudProjectProxy,
  ctrl.getConnection,
);

export const appConnectionRoutes = r.hono;
