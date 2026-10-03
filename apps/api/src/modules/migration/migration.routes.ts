/**
 * Docker migration routes — mounted at /api/migration in app.ts.
 *
 * One migration flow for connected and managed servers. Cloud sources have
 * migration-only access; Cloud targets must be owned managed servers.
 */

import { Hono } from "hono";
import { MigrationRequestSchemas } from "@repo/contracts";
import { secureRouter } from "../../lib/secure-router";
import * as migration from "./migration.controller";

const r = secureRouter(new Hono(), {
  module: "migration",
  basePath: "/api/migration",
  ids: { server: "serverId" },
});

r.get("/sources", { tag: "server:read", collection: true, mcp: { description: "List reusable migration-only SSH sources in the active organization. These connections cannot host Openship deployments or run general server commands." } }, migration.listSources);
r.post("/sources/test", { tag: "server:write", collection: true, body: MigrationRequestSchemas.source, mcp: { description: "Verify a public SSH migration source using a password or uploaded private key. Returns its host fingerprint; does not save credentials or modify workloads." } }, migration.testSource);
r.post("/sources", { tag: "server:write", collection: true, body: MigrationRequestSchemas.source, mcp: { description: "Connect a public SSH server for migration only. Verifies the connection, pins its host key and encrypts credentials. Scan it, preview a move to a managed server, then start the existing migration flow." } }, migration.createSource);
r.delete("/sources/:serverId", { tag: "server:write", mcp: { description: "Remove a migration-only connection and its stored credentials after its runs finish. Does not delete the external server, source containers, data or imported projects." } }, migration.deleteSource);

// Read-only: inspect a server's Docker and return the adoptable stack.
r.post("/scan", { tag: "server:write", collection: true, mcp: { description: "Inspect Docker workloads on body.serverId, returning groups, container IDs, volumes and detected routes with secrets masked. Does not adopt or stop workloads. Use container IDs when selecting services shared across Compose projects." }, body: MigrationRequestSchemas.scan }, migration.scanServer);
// Streaming variant (SSE): step progress + result, no fixed timeout.
r.get("/scan/stream", { tag: "server:write", collection: true, mcpExcluded: "SSE transport for live progress. Use the resource’s JSON status/log tools over MCP, or an authenticated HTTP client for streaming." }, migration.scanServerStream);
// On-demand reveal of ONE discovered container's real env (scan masks it). Write-
// gated: the masked scan is a read, revealing the real secret is a write (#336).
r.post("/reveal-env", { tag: "server:write", collection: true, mcpExcluded: "Explicit dashboard secret reveal. Migration rediscovers real source environment server-side; MCP passes selected container IDs." }, migration.revealServiceEnv);
// Create an Openship project from the selected discovered services (records only).
r.post("/adopt", { localOnly: true, tag: "server:write", collection: true, mcp: { description: "Register selected discovered Docker services as an Openship project while preserving running containers and volumes. Rediscovers values on the server; do not send masked secrets as replacements. Deployment and cutover are separate." }, body: MigrationRequestSchemas.adopt }, migration.adoptServer);
// Re-import an orphaned Openship project (DR / cross-instance), preserving its id.
r.post("/reimport", { localOnly: true, tag: "server:write", collection: true, mcp: { description: "Re-register an orphaned Openship project found on this server, preserving its scanned project ID and configuration. Use scan to identify the project; this is recovery of existing workloads." }, body: MigrationRequestSchemas.reimport }, migration.reimportServer);

// Read-only: parse a linked repo's docker-compose (GitHub API) for the map step.
r.post("/repo-compose", { tag: "server:read", readOnly: true, collection: true, mcp: { description: "Read derived Compose service configuration from an accessible GitHub repository for migration mapping. Environment values are masked; absence of Compose returns an empty services list." }, body: MigrationRequestSchemas.repoCompose }, migration.repoCompose);
// Read-only preview of a full migration (registry/build, volumes, warnings).
r.post("/preview", { tag: "server:write", collection: true, mcp: { description: "Preview a Docker migration’s images, volumes, destination conflicts and downtime warnings without moving workloads. Use the same server and service selection for the subsequent migrate call." }, body: MigrationRequestSchemas.preview }, migration.previewMigration);
// Start a full migration (adopt → move → deploy → verify → await cutover).
r.post("/migrate", { tag: "server:write", collection: true, mcp: { description: "Start adoption, data transfer, deployment and routing verification for the reviewed Docker services. Returns migrationId and confirmationToken; poll the run and answer its offered pending prompts. Leave killOriginals false to review explicit cutover. True authorizes automatic retirement of original containers after verification." }, body: MigrationRequestSchemas.migrate }, migration.startMigration);

// Project move (door B): relocate a project this instance already owns. `server:write`
// like the rest of this module — the handler additionally asserts `project:write`, because
// neither permission implies the other when a run mutates a workload on two machines.
r.post("/project", { tag: "server:write", collection: true, mcp: { description: "Move or copy an existing Docker project to a registered server through the migration pipeline. Requires access to the project and both servers. Returns migrationId; poll and explicitly confirm cutover. Does not move k3s projects or convert database replication." }, body: MigrationRequestSchemas.project }, migration.startProjectMove);
// Migration run status, live progress, and the opt-in destructive cutover.
r.get("/migrations/:id", { tag: "server:read", collection: true, mcp: { description: "Read migration state, saved progress, logs and pendingPrompt. When awaiting_cutover, review target health/routing before confirmation. A partial run can be resumed; polling never starts another migration." } }, migration.getMigration);
r.get("/migrations/:id/stream", { tag: "server:read", collection: true, mcpExcluded: "SSE transport for live progress. Use the resource’s JSON status/log tools over MCP, or an authenticated HTTP client for streaming." }, migration.streamMigration);
r.post("/migrations/:id/cutover", { tag: "server:write", collection: true, mcp: { description: "Confirm migration cutover using the returned confirmationToken. kill:true destroys original containers. False retains them: external cross-server imports restart previously running sources; existing project moves and same-server imports leave them stopped. Source volumes remain. Failed destructive cutover can only resume that same choice.", destructive: true }, body: MigrationRequestSchemas.cutover }, migration.confirmCutover);
// Abort an in-flight migration (kills the transfer + rolls back).
r.post("/migrations/:id/cancel", { tag: "server:write", collection: true, mcp: { description: "Cancel an in-flight migration and request rollback of target changes. Poll until rollback finishes. Not available after awaiting_cutover or terminal completion; use explicit cutover at that point." } }, migration.cancelMigration);
r.post("/migrations/:id/respond", { tag: "server:write", collection: true, mcp: { description: "Answer the migration’s current pendingPrompt with its promptId and an offered action ID. Use the run’s actual options and expiry; do not invent takeover decisions." }, body: MigrationRequestSchemas.respond }, migration.respondMigration);
// Resume a partial run: re-transfer pending paths (edit/skip), then finish.
r.post("/migrations/:id/resume", { tag: "server:write", collection: true, mcp: { description: "Resume a partial migration’s remaining paths, optionally with reviewed source-path overrides or skips. Skipping excludes data from the move. Poll the run through verification and cutover." }, body: MigrationRequestSchemas.resume }, migration.resumeMigration);
// Remove the volumes a FAILED run copied to the target (retry starts clean).
r.post("/migrations/:id/cleanup-target", { tag: "server:write", collection: true, mcp: { description: "Remove target volumes copied by a failed migration, so a later retry can start cleanly. Source data is retained; succeeded migrations are refused. Review the failed run before cleanup.", destructive: true } }, migration.cleanupTargetData);
// Delete a terminal run's record (history cleanup; project + data untouched).
r.delete("/migrations/:id", { tag: "server:write", collection: true, mcp: { description: "Delete a terminal migration’s history record. Does not delete the migrated project or its data; active runs must first finish or be cancelled." } }, migration.deleteMigration);
// The in-flight run for a server, so a reloaded client can re-attach. A PROJECT's live run is
// not here — it rides on the project payload (`readActiveMigration`), which is what every
// surface that renders a project already reads. See the handler.
r.get("/active", { tag: "server:read", collection: true, mcp: { description: "Find an existing active migration involving query.serverId before starting or reattaching to work. Returns its ID and cutover state; source environment values remain masked." }, query: MigrationRequestSchemas.active }, migration.getActiveMigration);
// Recent runs for a server (the "Migrations" tab list, like project deployments).
r.get("/runs", { tag: "server:read", collection: true, mcp: { description: "List up to 50 recent migration summaries for query.serverId or query.projectId. Read a specific run for logs, prompts and cutover details." }, query: MigrationRequestSchemas.runs }, migration.getMigrationRuns);

export const migrationRoutes = r.hono;
