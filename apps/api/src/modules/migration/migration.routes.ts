/**
 * Docker migration routes — mounted at /api/migration in app.ts.
 *
 * Self-hosted only (gated by localOnly): inspecting a server's Docker needs SSH
 * into the user's own box.
 */

import { Hono } from "hono";
import { localOnly } from "../../middleware";
import { secureRouter } from "../../lib/secure-router";
import * as migration from "./migration.controller";

const r = secureRouter(new Hono(), {
  module: "migration",
  basePath: "/api/migration",
  ids: { server: "serverId" },
});

r.use("*", localOnly);

// Read-only: inspect a server's Docker and return the adoptable stack.
r.post("/scan", { tag: "server:write", collection: true }, migration.scanServer);
// Streaming variant (SSE): step progress + result, no fixed timeout.
r.get("/scan/stream", { tag: "server:write", collection: true }, migration.scanServerStream);
// Create an Openship project from the selected discovered services (records only).
r.post("/adopt", { tag: "server:write", collection: true }, migration.adoptServer);
// Re-import an orphaned Openship project (DR / cross-instance), preserving its id.
r.post("/reimport", { tag: "server:write", collection: true }, migration.reimportServer);

// Read-only preview of a full migration (registry/build, volumes, warnings).
r.post("/preview", { tag: "server:write", collection: true }, migration.previewMigration);
// Start a full migration (adopt → move → deploy → verify → await cutover).
r.post("/migrate", { tag: "server:write", collection: true }, migration.startMigration);
// Migration run status, live progress, and the opt-in destructive cutover.
r.get("/migrations/:id", { tag: "server:read", collection: true }, migration.getMigration);
r.get("/migrations/:id/stream", { tag: "server:read", collection: true }, migration.streamMigration);
r.post("/migrations/:id/cutover", { tag: "server:write", collection: true }, migration.confirmCutover);

export const migrationRoutes = r.hono;
