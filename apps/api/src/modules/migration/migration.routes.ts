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
// On-demand reveal of ONE discovered container's real env (scan masks it). Write-
// gated: the masked scan is a read, revealing the real secret is a write (#336).
r.post("/reveal-env", { tag: "server:write", collection: true }, migration.revealServiceEnv);
// Create an Openship project from the selected discovered services (records only).
r.post("/adopt", { tag: "server:write", collection: true }, migration.adoptServer);
// Re-import an orphaned Openship project (DR / cross-instance), preserving its id.
r.post("/reimport", { tag: "server:write", collection: true }, migration.reimportServer);

// Read-only: parse a linked repo's docker-compose (GitHub API) for the map step.
r.post("/repo-compose", { tag: "server:read", readOnly: true, collection: true }, migration.repoCompose);
// Read-only preview of a full migration (registry/build, volumes, warnings).
r.post("/preview", { tag: "server:write", collection: true }, migration.previewMigration);
// Start a full migration (adopt → move → deploy → verify → await cutover).
r.post("/migrate", { tag: "server:write", collection: true }, migration.startMigration);
// Migration run status, live progress, and the opt-in destructive cutover.
r.get("/migrations/:id", { tag: "server:read", collection: true }, migration.getMigration);
r.get("/migrations/:id/stream", { tag: "server:read", collection: true }, migration.streamMigration);
r.post("/migrations/:id/cutover", { tag: "server:write", collection: true }, migration.confirmCutover);
// Abort an in-flight migration (kills the transfer + rolls back).
r.post("/migrations/:id/cancel", { tag: "server:write", collection: true }, migration.cancelMigration);
// Resume a partial run: re-transfer pending paths (edit/skip), then finish.
r.post("/migrations/:id/resume", { tag: "server:write", collection: true }, migration.resumeMigration);
// Remove the volumes a FAILED run copied to the target (retry starts clean).
r.post("/migrations/:id/cleanup-target", { tag: "server:write", collection: true }, migration.cleanupTargetData);
// Delete a terminal run's record (history cleanup; project + data untouched).
r.delete("/migrations/:id", { tag: "server:write", collection: true }, migration.deleteMigration);
// The in-flight run for a server, so a reloaded client can re-attach.
r.get("/active", { tag: "server:read", collection: true }, migration.getActiveMigration);
// Recent runs for a server (the "Migrations" tab list, like project deployments).
r.get("/runs", { tag: "server:read", collection: true }, migration.getMigrationRuns);

export const migrationRoutes = r.hono;
