import { Hono } from "hono";
import { secureRouter } from "../../lib/secure-router";
import { listDirectory, readFile, downloadFile } from "./service-files.controller";

/**
 * Read-only file browsing inside a deployed service.
 *
 * Sibling of service-terminal.routes.ts and, like it, NOT `localOnly`: it works
 * on self-hosted (docker exec) AND cloud (Oblien workspace exec). The runtime
 * is chosen inside the controller from the deployment's meta.
 *
 *   GET /api/services/files/:serviceId/list?path=      directory listing
 *   GET /api/services/files/:serviceId/read?path=      text preview (capped)
 *   GET /api/services/files/:serviceId/download?path=  raw bytes (capped)
 *
 * All three carry `terminal:write` rather than a read tag. That is deliberate:
 * the tag names the CAPABILITY TIER, not the HTTP verb, and reading a
 * container's filesystem is exactly as sensitive as opening a shell in it —
 * same `.env`, same credentials. Gating these below the terminal would let
 * someone denied a shell read everything the shell would have shown them.
 * The controller re-asserts project `admin` per request on top of this.
 */
export const serviceFilesRoutes = new Hono();
const r = secureRouter(serviceFilesRoutes, {
  module: "service-files",
  basePath: "/api/services/files",
});

r.get("/:serviceId/list", { tag: "terminal:write" }, listDirectory);
r.get("/:serviceId/read", { tag: "terminal:write" }, readFile);
r.get("/:serviceId/download", { tag: "terminal:write" }, downloadFile);
