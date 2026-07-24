/**
 * Project routes - mounted at /api/projects in app.ts.
 *
 * Every route declares a permission tag enforced by secureRouter
 * middleware (check + audit emission). The boot scanner refuses to
 * start if any route lacks one.
 *
 * Cloud-as-source: per-`:id` project routes carry `cloudProjectProxy`
 * (mounted AFTER the permission middleware). For a project that is canonical
 * on the SaaS (no local row), it forwards the request to the SaaS as the org
 * owner and returns that response; for a local project it falls through to the
 * local handler. See lib/cloud/project-router.ts.
 */

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureRouter } from "../../lib/secure-router";
import { cloudProjectProxy } from "../../lib/cloud/project-router";
import * as ctrl from "./project.controller";
import * as folder from "./folder/folder.controller";
import * as transfer from "./transfer.controller";
import * as routeRules from "../route-rules/route-rule.controller";
import * as ensureEdgeCtrl from "../domains/ensure-edge.controller";
import {
  CreateProjectBody,
  EnsureProjectBody,
  FolderSessionBody,
  UpdateProjectBody,
  CreateProjectEnvironmentBody,
  MergeEnvVarsBody,
  UpdateResourcesBody,
} from "./project.schema";

const r = secureRouter(new Hono(), {
  module: "projects",
  basePath: "/api/projects",
});

/* All project routes require authentication. The route-level
   `requirePermission` middleware (mounted automatically by secureRouter)
   loads each resource and validates org membership via the resource's
   own `organization_id` — no session-mutating auto-switch needed. */

/* ─── Local-only routes (hidden in cloud mode) ─────────────────────────── */
r.get("/local", { tag: "project:list", localOnly: true }, ctrl.listLocal);
// Collection-scoped writes: org from request (X-Organization-Id or
// session default); no :id in the URL — the controller resolves the
// project from the JSON body. `collection: true` keeps the existing
// :id-required default safe for per-resource routes below.
r.post("/scan", { tag: "project:write", collection: true, localOnly: true }, ctrl.scanLocal);
r.post("/import", { tag: "project:write", collection: true, localOnly: true }, ctrl.importLocal);

/* ─── Route rules (self-hosted OpenResty edge: rate-limit · ban · allow/deny) ── */
r.get("/:id/route-rules", { tag: "project:read", localOnly: true }, routeRules.listRouteRules);
r.post("/:id/route-rules", { tag: "project:write", localOnly: true }, routeRules.createRouteRule);
r.patch("/:id/route-rules/:ruleId", { tag: "project:write", localOnly: true }, routeRules.updateRouteRule);
r.delete("/:id/route-rules/:ruleId", { tag: "project:write", localOnly: true }, routeRules.deleteRouteRule);

/* ─── Folder upload → deploy ─────────────────────────────────────────────
 * Browser-based folder deploy for clients with no filesystem-shared API.
 * `session` returns an opaque upload target: an Oblien workspace token (SaaS,
 * the browser uploads DIRECTLY to Oblien) or a relay path (self-hosted). The
 * binary /folder/upload route is excluded from MCP (see mcp-tools). */
// session + scan run on BOTH SaaS and self-hosted (session provisions the
// Oblien workspace / staging dir; scan detects on the uploaded source).
r.post(
  "/folder/session",
  {
    tag: "project:write",
    collection: true,
    mcp: {
      description:
        "Folder-upload deploy — STEP 1/4. Opens an upload session for a local source folder and returns `upload` = { url, method, headers }. NEXT, upload the gzipped tarball yourself: POST it to `upload.url` with the returned headers and Content-Type: application/gzip. That byte upload is NOT an MCP tool (raw binary can't cross JSON-RPC) — use an HTTP client. Then call folder/scan. Sequence: session → (out-of-band tarball upload) → folder/scan → projects/ensure → deployments/build/access.",
      body: FolderSessionBody,
    },
  },
  folder.createSession,
);
r.post(
  "/folder/scan/:sessionId",
  {
    tag: "project:write",
    collection: true,
    mcp: {
      description:
        "Folder-upload deploy — STEP 2/4. Run AFTER the tarball is uploaded. Detects the uploaded source's framework/build config (stack, packageManager, install/build/start commands, outputDirectory, productionPaths, port). Body may be empty ({}). Feed the result into projects/ensure (STEP 3).",
    },
  },
  folder.scanSession,
);
// The relay upload is SELF-HOSTED ONLY: on the SaaS the browser uploads
// straight to the Oblien workspace, so the API never receives bytes. localOnly
// 404s this in CLOUD_MODE; the 300MB bodyLimit only runs once localOnly passes.
r.post(
  "/folder/upload/:sessionId",
  { tag: "project:write", collection: true, localOnly: true },
  bodyLimit({
    maxSize: 300_000_000,
    onError: (c) => c.json({ error: "Upload exceeds the 300MB limit.", code: "PAYLOAD_TOO_LARGE" }, 413),
  }),
  folder.uploadRelay,
);

/* ─── Top-level project operations ─────────────────────────────────────── */
// getHome merges local + cloud projects server-side; create/ensure stay local
// for now (promote-to-cloud lives on /:id/transfer/to-cloud).
r.get("/home", { tag: "project:list" }, ctrl.getHome);
r.post(
  "/ensure",
  {
    tag: "project:write",
    collection: true,
    mcp: {
      description:
        "Folder-upload deploy — STEP 3/4. Create or update the project that carries the build config — deployments/build/access reads config from the PROJECT ROW, not the upload session, so this must run first. Map the folder/scan fields in (framework = the scan's stack id) and set gitProvider:'upload'. Pass projectId to update an existing project. Returns the project id for STEP 4.",
      body: EnsureProjectBody,
    },
  },
  ctrl.ensure,
);
r.get(
  "/",
  { tag: "project:list", mcp: { description: "List projects in the org." } },
  ctrl.list,
);
r.post(
  "/",
  {
    tag: "project:write",
    collection: true,
    projectCreate: true,
    mcp: {
      description:
        "Create a project from a git or local source (build config baked into the project). For a folder-upload deploy use projects/ensure instead (it accepts the folder/scan config and gitProvider:'upload').",
      body: CreateProjectBody,
    },
  },
  ctrl.create,
);

/* ─── Projects CRUD ────────────────────────────────────────────────────── */
r.get(
  "/:id",
  { tag: "project:read", mcp: { description: "Get a project by id — config, source, routes, status." } },
  cloudProjectProxy,
  ctrl.getById,
);
r.patch(
  "/:id",
  {
    tag: "project:write",
    mcp: { description: "Update a project's configuration (build config, source, options).", body: UpdateProjectBody },
  },
  cloudProjectProxy,
  ctrl.update,
);
r.delete("/:id", { tag: "project:admin" }, cloudProjectProxy, ctrl.remove);
r.get("/:id/info", { tag: "project:read", mcp: { description: "Get a project's detailed info (runtime, build, source)." } }, cloudProjectProxy, ctrl.getInfo);
r.get("/:id/environments", { tag: "project:read", mcp: { description: "List a project's environments (production / previews)." } }, cloudProjectProxy, ctrl.listEnvironments);
r.post(
  "/:id/environments",
  {
    tag: "project:write",
    mcp: { description: "Create a project environment (e.g. a preview).", body: CreateProjectEnvironmentBody },
  },
  cloudProjectProxy,
  ctrl.createEnvironment,
);
r.get("/:id/deletion-preview", { tag: "project:read", mcp: { description: "Preview what deleting this project would remove (read-only)." } }, cloudProjectProxy, ctrl.deletionPreview);

/* ─── Build options ────────────────────────────────────────────────────── */
r.post("/:id/options", { tag: "project:write", mcp: { description: "Set build/deploy options for a project." } }, cloudProjectProxy, ctrl.setOptions);
r.post("/:id/port-check", { tag: "project:read", readOnly: true, mcp: { description: "Live port-reachability check for the project's active deployment (advisory)." } }, cloudProjectProxy, ctrl.portCheck);
r.post("/:id/output-check", { tag: "project:read", readOnly: true, mcp: { description: "Live static-output check for the project's active deployment (advisory; static apps)." } }, cloudProjectProxy, ctrl.outputCheck);

/* ─── Enable / Disable ─────────────────────────────────────────────────── */
r.post("/:id/enable", { tag: "project:write", mcp: { description: "Enable a project (allow deploys / bring online)." } }, cloudProjectProxy, ctrl.enable);
r.post("/:id/disable", { tag: "project:write", mcp: { description: "Disable a project (pause deploys / take offline)." } }, cloudProjectProxy, ctrl.disable);

/* ─── Retry free-domain edge routing (no rebuild) ──────────────────────── */
r.post("/:id/routing/retry", { tag: "project:write", mcp: { description: "Retry syncing the project's free .opsh.io edge route (no rebuild); clears the routing 'Action Required' warning on success." } }, cloudProjectProxy, ctrl.retryRouting);

/* ─── Set up / take over the self-hosted edge (OpenResty on 80/443) + apply
      the project's routes, WITHOUT a container redeploy. SSE so the port-80/443
      takeover consent can be prompted mid-flight (answered via .../respond). ── */
r.post("/:id/routing/ensure-edge/stream", { tag: "project:write" }, ensureEdgeCtrl.ensureEdgeStream);
r.post("/:id/routing/ensure-edge/respond", { tag: "project:write" }, ensureEdgeCtrl.ensureEdgeRespond);

/* ─── Environment variables ────────────────────────────────────────────── */
// Project-scoped bulk routes (no per-env_var id in the URL) → gate on the
// project, matching what the controllers already assert (permission.assert
// project:read/write) and how /:id/options works. The previous
// project:env_var:* tags required a :envVarId param these routes don't have,
// so the permission middleware 400'd before the handler. Secret VALUES stay
// protected by masking in listEnvVars, not by the route tag.
r.get("/:id/env", { tag: "project:read", mcp: { description: "List a project's environment variables (secret values masked)." } }, cloudProjectProxy, ctrl.listEnvVars);
// Project env edits go through the MERGE path (PATCH) only — the old destructive
// full-replace PUT was removed (it could wipe/corrupt masked secrets and had no
// remaining caller; the editor sends a diff via mergeEnvVars).
r.patch(
  "/:id/env",
  {
    tag: "project:write",
    mcp: { description: "Merge env var changes (upserts + deletes); untouched vars are preserved.", body: MergeEnvVarsBody },
  },
  cloudProjectProxy,
  ctrl.mergeEnvVars,
);

/* ─── Per-project clone token (git credential override) ────────────────── */
r.get("/:id/clone-token", { tag: "project:read" }, cloudProjectProxy, ctrl.getCloneToken);
r.patch("/:id/clone-token", { tag: "project:admin" }, cloudProjectProxy, ctrl.updateCloneToken);

/* ─── Git ──────────────────────────────────────────────────────────────── */
r.get("/:id/git", { tag: "project:read", mcp: { description: "Get the project's linked git repository info." } }, cloudProjectProxy, ctrl.getGitInfo);
r.get("/:id/commit-status", { tag: "project:read", mcp: { description: "Compare the deployed commit against the remote HEAD." } }, cloudProjectProxy, ctrl.getCommitStatus);
r.post("/:id/git/link", { tag: "project:write", mcp: { description: "Link a git repository to the project." } }, cloudProjectProxy, ctrl.linkRepo);
r.get("/:id/branches", { tag: "project:read", mcp: { description: "List the linked repository's branches." } }, cloudProjectProxy, ctrl.listBranches);
r.post("/:id/auto-deploy", { tag: "project:write", mcp: { description: "Enable/disable auto-deploy on push." } }, cloudProjectProxy, ctrl.setAutoDeploy);
r.post("/:id/webhook-domain", { tag: "project:write" }, cloudProjectProxy, ctrl.setWebhookDomain);
r.post("/:id/branch", { tag: "project:write", mcp: { description: "Set the project's deploy branch." } }, cloudProjectProxy, ctrl.setBranch);

/* ─── Resources ────────────────────────────────────────────────────────── */
r.get("/:id/resources", { tag: "project:read", mcp: { description: "Get the project's CPU/RAM/disk resource config." } }, cloudProjectProxy, ctrl.getResources);
r.patch(
  "/:id/resources",
  {
    tag: "project:write",
    mcp: { description: "Update the project's CPU/RAM/disk, sleep mode, or port.", body: UpdateResourcesBody },
  },
  cloudProjectProxy,
  ctrl.updateResources,
);
r.post("/:id/resources", { tag: "project:write" }, cloudProjectProxy, ctrl.updateResources);

/* ─── Sleep mode ───────────────────────────────────────────────────────── */
r.post("/:id/sleep-mode", { tag: "project:write", mcp: { description: "Set the project's sleep mode (auto_sleep / always_on)." } }, cloudProjectProxy, ctrl.setSleepMode);

/* ─── Deployments ──────────────────────────────────────────────────────── */
r.get("/:id/deployments", { tag: "project:deployment:list", mcp: { description: "List a project's deployments (history, statuses)." } }, cloudProjectProxy, ctrl.listDeployments);
r.post("/:id/deployment-session", { tag: "project:read", readOnly: true }, cloudProjectProxy, ctrl.deploymentSession);

/* ─── Custom domain ────────────────────────────────────────────────────── */
r.post("/:id/connect", { tag: "project:write" }, cloudProjectProxy, ctrl.connectDomain);

/* ─── Runtime logs ─────────────────────────────────────────────────────── */
r.get("/:id/logs", { tag: "project:read", mcp: { description: "Fetch the project's runtime logs (non-streaming)." } }, cloudProjectProxy, ctrl.runtimeLogs);
r.get("/:id/logs/stream", { tag: "project:read" }, cloudProjectProxy, ctrl.runtimeLogStream);

/* ─── Server HTTP request logs ─────────────────────────────────────────── */
r.get("/:id/server-logs/recent", { tag: "project:read", mcp: { description: "Fetch recent HTTP request logs for the project." } }, cloudProjectProxy, ctrl.recentServerLogs);
r.get("/:id/server-logs/stream-token", { tag: "project:read" }, cloudProjectProxy, ctrl.serverLogStreamToken);
r.get("/:id/server-logs/stream", { tag: "project:read" }, cloudProjectProxy, ctrl.serverLogStream);

/* ─── Project transfer / promote (local → cloud) ───────────────────────── */
// Self-hosted ONLY: promote pushes a LOCAL project to the SaaS, and bring-home
// pulls it back. Meaningless on the SaaS itself (it IS the cloud), so localOnly
// 404s them there — never proxied, never run in CLOUD_MODE.
r.post("/:id/transfer/to-cloud", { tag: "project:admin", localOnly: true }, transfer.transferToCloud);
r.post("/:id/transfer/to-self-hosted", { tag: "project:admin", localOnly: true }, transfer.transferToSelfHosted);

export const projectRoutes = r.hono;
