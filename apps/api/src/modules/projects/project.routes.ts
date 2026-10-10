/**
 * Project routes - mounted at /api/projects in app.ts.
 *
 * Every route declares a permission tag enforced by secureRouter
 * middleware (check + audit emission). The boot scanner refuses to
 * start if any route lacks one.
 *
 * Cloud-as-source: per-`:id` project routes use the shared Cloud resource gateway
 * (mounted AFTER the permission middleware). For a project that is canonical
 * on the SaaS (no local row), it forwards the request to the SaaS as the org
 * owner and returns that response; for a local project it falls through to the
 * local handler. See lib/cloud/project-router.ts.
 */

import { Hono } from "hono";
import {
  WebhookPageInputSchema,
  RecentServerLogsInputSchema,
  ListProjectsSchema,
  RemoveProjectSchema,
  ScanLocalProjectBody,
  ImportLocalProjectBody,
  ProjectControlSchemas,
  RouteRuleInputSchema,
  ConnectProjectDomainInputSchema,
  SourceScanOptionsSchema,
  UpdateCloneTokenSchema,
  ProjectClusterSchemas,
  ProjectDatabaseSchemas,
  ProjectVolumeSchemas,
  CreateProjectBody,
  CreateExternalProjectBody,
  EnsureProjectBody,
  FolderSessionBody,
  UpdateProjectBody,
  CreateProjectEnvironmentBody,
  MergeEnvVarsBody,
  UpdateResourcesBody,
  LinkRepoBody,
  SetReleaseSourceBody,
  SetAutoDeployBody,
  SetBranchBody,
  SetSleepModeBody,
  SetOptionsBody,
  CreateIncomingWebhookBody,
  UpdateIncomingWebhookBody,
} from "@repo/contracts";
import { bodyLimit } from "hono/body-limit";
import { secureRouter } from "../../lib/secure-router";
import { requireInstanceAdmin } from "../../middleware/instance-admin";
import * as ctrl from "./project.controller";
import * as folder from "./folder/folder.controller";
import * as transfer from "./transfer.controller";
import * as routeRules from "../route-rules/route-rule.controller";
import * as edgeConfig from "./edge-config.controller";
import * as incidents from "../monitoring/incident.controller";
import * as ensureEdgeCtrl from "../domains/ensure-edge.controller";
import * as incomingWebhooks from "../incoming-webhooks/incoming.controller";

const r = secureRouter(new Hono(), {
  module: "projects",
  basePath: "/api/projects",
});

/* All project routes require authentication. The route-level
   `requirePermission` middleware (mounted automatically by secureRouter)
   loads each resource and validates org membership via the resource's
   own `organization_id` — no session-mutating auto-switch needed. */

/* ─── Local-only routes (hidden in cloud mode) ─────────────────────────── */
r.get(
  "/local",
  {
    tag: "project:list",
    localOnly: true,
    mcp: {
      description:
        "List projects registered from directories on this Openship controller. These paths are not on the MCP client machine.",
    },
  },
  ctrl.listLocal,
);
// Collection-scoped writes: org from request (X-Organization-Id or
// session default); no :id in the URL — the controller resolves the
// project from the JSON body. `collection: true` keeps the existing
// :id-required default safe for per-resource routes below.
r.post(
  "/scan",
  {
    tag: "project:write",
    collection: true,
    localOnly: true,
    auditHandledByOperation: true,
    mcp: {
      description:
        "Inspect a source directory accessible to the Openship controller and detect build or Compose configuration. For a folder on the MCP client machine, use the folder-upload workflow.",
    },
    body: ScanLocalProjectBody,
  },
  ctrl.scanLocal,
);
r.post(
  "/import",
  {
    tag: "project:write",
    collection: true,
    projectCreate: true,
    localOnly: true,
    auditHandledByOperation: true,
    mcp: {
      description:
        "Register a project from a source directory accessible to the Openship controller. On desktop, use localPath and an accessible managed serverId to deploy that folder to Cloud without an out-of-band upload. This creates project configuration; deploy the returned projectId separately with buildStrategy:'server' for a managed server. Source location does not choose build location.",
    },
    body: ImportLocalProjectBody,
  },
  ctrl.importLocal,
);

/* ─── Live edge config read-back (saved vs. served, per hostname) ───────── */
r.get(
  "/:id/edge-config",
  {
    tag: "project:read",
    localOnly: true,
    mcp: {
      description:
        "Compare saved project routes with the configuration currently served by the self-hosted edge. Use this to investigate routing drift before retrying.",
    },
  },
  edgeConfig.getEdgeConfig,
);

/* ─── Route rules (self-hosted OpenResty edge: rate-limit · ban · allow/deny) ── */
r.get(
  "/:id/route-rules",
  {
    tag: "project:read",
    localOnly: true,
    mcp: {
      description:
        "List project edge rules for rate limits, access restrictions and traffic filtering.",
    },
  },
  routeRules.listRouteRules,
);
r.post(
  "/:id/route-rules",
  {
    tag: "project:write",
    localOnly: true,
    body: RouteRuleInputSchema,
    auditHandledByOperation: true,
    mcp: {
      description:
        "Create an edge traffic rule for this project, optionally scoped to a domain or path. A rule can block live traffic; read the existing rules before changing access.",
    },
  },
  routeRules.createRouteRule,
);
r.patch(
  "/:id/route-rules/:ruleId",
  {
    tag: "project:write",
    localOnly: true,
    auditHandledByOperation: true,
    mcp: {
      description:
        "Update this project’s edge traffic rule. Supply the complete replacement rule spec when changing it; omitted top-level fields are preserved.",
    },
    body: RouteRuleInputSchema,
  },
  routeRules.updateRouteRule,
);
r.delete(
  "/:id/route-rules/:ruleId",
  {
    tag: "project:write",
    localOnly: true,
    auditHandledByOperation: true,
    mcp: {
      description:
        "Delete this project’s edge traffic rule and synchronize routing. Removing a restriction changes which traffic is allowed.",
    },
  },
  routeRules.deleteRouteRule,
);

/* ─── Health (container incidents recorded by the health watch) ─────────── */
r.get(
  "/:id/incidents",
  {
    tag: "project:read",
    localOnly: true,
    mcp: {
      description:
        "Container runtime health for this project: OPEN incidents (a workload the health watch found `unhealthy`, `crash_loop`, or `down`, each with its reason, exit code, restart count, OOM flag and a log excerpt) plus recently-resolved ones. Two fields decide whether an empty list means anything, so always read them: `watching` is false when health monitoring is turned OFF — with it off, the absence of incidents is NOT evidence of health; `serverUnreachable` is non-null when the box itself is unreachable, in which case this project's rows are frozen and stale (nothing is being observed). Read this whenever a project looks unhealthy, or a deploy that reported success still isn't serving — it reports the RUNTIME state and complements the pending-actions tool (which covers deploy/domain/routing items that each carry a concrete fix). Incidents auto-resolve when the workload recovers; the usual move for an open one is to redeploy or inspect its `logExcerpt`. Self-hosted only.",
    },
  },
  incidents.listProjectIncidents,
);

/* ─── Folder upload → deploy ─────────────────────────────────────────────
 * Browser-based folder deploy for clients with no filesystem-shared API.
 * `session` returns an authenticated upload target for private source staging.
 * Builds transfer that source to the selected connected or managed server. The
 * binary /folder/upload route is excluded from MCP (see mcp-tools). */
// Session, upload and scan share the same path on SaaS and self-hosted installs.
r.post(
  "/folder/session",
  {
    tag: "project:write",
    collection: true,
    collectionProject: true,
    auditHandledByOperation: true,
    body: FolderSessionBody,
    mcp: {
      description:
        "Open a folder-upload session for projectId. Credentials limited to their own projects must create a project first and pass its id; omitting projectId requires wildcard project write access. Returns upload = { url, absoluteUrl, method, headers, requiresAuth }. An authenticated HTTP uploader must POST the gzipped tarball with the returned headers and the same API credential. Binary upload is not an MCP tool and MCP does not expose its OAuth bearer. For a folder on the desktop controller's machine, use projects/import with localPath instead. After upload: folder/scan → projects/ensure (explicit projectId) → deployments/build/access.",
    },
  },
  folder.createSession,
);
r.post(
  "/folder/scan/:sessionId",
  {
    tag: "project:write",
    collection: true,
    collectionProject: true,
    auditHandledByOperation: true,
    body: SourceScanOptionsSchema,
    mcp: {
      description:
        "Folder-upload deploy — STEP 2/4. Run AFTER the tarball is uploaded. Detects the uploaded source's framework/build config (stack, packageManager, install/build/start commands, outputDirectory, productionPaths, port) and, for a docker-compose folder, the `services` array. Body may be empty ({}). Feed the result into projects/ensure (STEP 3) — including `services` verbatim when present.",
    },
  },
  folder.scanSession,
);
r.post(
  // #336: real (unmasked) compose env for the folder-scan wizard's reveal
  // toggle — one service, only the keys the body names. Write-gated
  // (project:write); no mcp — reveal is a dashboard action.
  "/folder/scan/:sessionId/env-reveal",
  {
    tag: "project:write",
    collection: true,
    collectionProject: true,
    auditHandledByOperation: true,
    mcpExcluded:
      "Explicit dashboard secret reveal. MCP passes uploadSessionId to project ensure so real values stay server-side.",
  },
  folder.revealSessionEnv,
);
// Source bytes are staged privately on either installation; only the selected
// execution server runs builds. The operation checks ownership and its ticket.
r.post(
  "/folder/upload/:sessionId",
  {
    tag: "project:write",
    collection: true,
    collectionProject: true,
    auditHandledByOperation: true,
    mcpExcluded:
      "Binary tarball upload; use the authenticated upload URL from folder/session outside JSON-RPC.",
  },
  bodyLimit({
    maxSize: 300_000_000,
    onError: (c) =>
      c.json({ error: "Upload exceeds the 300MB limit.", code: "PAYLOAD_TOO_LARGE" }, 413),
  }),
  folder.uploadRelay,
);

/* ─── Top-level project operations ─────────────────────────────────────── */
// getHome merges local + cloud projects server-side; create/ensure stay local
// for now (promote-to-cloud lives on /:id/transfer/to-cloud).
r.get(
  "/home",
  {
    tag: "project:list",
    mcp: {
      description:
        "Read the combined local and connected-Cloud project overview, including project groups and hosting location. Individual operations still enforce each project’s scope.",
    },
  },
  ctrl.getHome,
);
r.post(
  "/ensure",
  {
    tag: "project:write",
    collection: true,
    body: EnsureProjectBody,
    collectionProject: true,
    auditHandledByOperation: true,
    mcp: {
      description:
        "Folder-upload deploy — STEP 3/4. Create or update the project that carries the build config — deployments/build/access reads config from the PROJECT ROW, not the upload session, so this must run first. Map the folder/scan fields in (framework = the scan's stack id) and set gitProvider:'upload'. For a docker-compose folder, pass the scan's `services` array through too — that persists the project's service set — AND pass `uploadSessionId` with it, since the scan masks env values (`••••••••`) and that is what restores them. Pass projectId to update an existing project. Returns the project id for STEP 4.",
    },
  },
  ctrl.ensure,
);
r.get(
  "/",
  {
    tag: "project:list",
    mcp: { description: "List projects in the org." },
    query: ListProjectsSchema,
  },
  ctrl.list,
);
r.post(
  "/",
  {
    tag: "project:write",
    collection: true,
    projectCreate: true,
    body: CreateProjectBody,
    auditHandledByOperation: true,
    mcp: {
      description:
        "Create a project from a git or local source (build config baked into the project). For a folder-upload deploy use projects/ensure instead (it accepts the folder/scan config and gitProvider:'upload').",
    },
  },
  ctrl.create,
);

r.post(
  "/external",
  {
    tag: "project:write",
    collection: true,
    projectCreate: true,
    body: CreateExternalProjectBody,
    auditHandledByOperation: true,
    mcp: {
      description:
        "Link an app deployed by another tool (Kamal, docker run) as an observe-only project. Openship reads logs and status of the containers matched by name or labels on the given server, and never deploys, stops, or routes them.",
    },
  },
  ctrl.createExternal,
);

/* ─── Projects CRUD ────────────────────────────────────────────────────── */
r.get(
  "/:id",
  {
    tag: "project:read",
    mcp: { description: "Get a project by id — config, source, routes, status." },
  },
  ctrl.getById,
);
r.patch(
  "/:id",
  {
    tag: "project:write",
    body: UpdateProjectBody,
    auditHandledByOperation: true,
    mcp: { description: "Update a project's configuration (build config, source, options)." },
  },
  ctrl.update,
);
r.delete(
  "/:id",
  {
    auditHandledByOperation: true,
    tag: "project:admin",
    mcp: {
      description:
        "Delete this project and its owned deployment resources. Inspect deletion-preview first. Volumes are preserved unless query.wipeVolumes is explicitly true; force-orphan and record-only options can leave remote resources behind.",
    },
    query: RemoveProjectSchema,
  },
  ctrl.remove,
);
r.get(
  "/:id/info",
  {
    tag: "project:read",
    mcp: { description: "Get a project's detailed info (runtime, build, source)." },
  },
  ctrl.getInfo,
);
r.get(
  "/:id/environments",
  {
    tag: "project:read",
    mcp: { description: "List a project's environments (production / previews)." },
  },
  ctrl.listEnvironments,
);
r.post(
  "/:id/environments",
  {
    auditHandledByOperation: true,
    tag: "project:write",
    body: CreateProjectEnvironmentBody,
    mcp: { description: "Create a project environment (e.g. a preview)." },
  },
  ctrl.createEnvironment,
);
r.get(
  "/:id/deletion-preview",
  {
    tag: "project:read",
    mcp: { description: "Preview what deleting this project would remove (read-only)." },
  },
  ctrl.deletionPreview,
);

/* ─── Build options ────────────────────────────────────────────────────── */
r.post(
  "/:id/options",
  {
    auditHandledByOperation: true,
    tag: "project:write",
    body: SetOptionsBody,
    mcp: { description: "Set build/deploy options for a project." },
  },
  ctrl.setOptions,
);
r.post(
  "/:id/port-check",
  {
    tag: "project:read",
    readOnly: true,
    mcp: {
      description: "Live port-reachability check for the project's active deployment (advisory).",
    },
  },
  ctrl.portCheck,
);
r.post(
  "/:id/output-check",
  {
    tag: "project:read",
    readOnly: true,
    mcp: {
      description:
        "Live static-output check for the project's active deployment (advisory; static apps).",
    },
  },
  ctrl.outputCheck,
);
r.post(
  "/:id/clear-build",
  {
    auditHandledByOperation: true,
    tag: "project:admin",
    localOnly: true,
    mcp: {
      description:
        "Clear all unused Docker build cache on the project's self-hosted Docker server. Build cache is host-wide, so other projects on that server may rebuild dependencies on their next deployment. Returns reclaimed bytes.",
    },
  },
  requireInstanceAdmin(),
  ctrl.clearBuildCache,
);

/* ─── Enable / Disable ─────────────────────────────────────────────────── */
r.post(
  "/:id/enable",
  {
    auditHandledByOperation: true,
    tag: "project:write",
    mcp: { description: "Enable a project (allow deploys / bring online)." },
  },
  ctrl.enable,
);
r.post(
  "/:id/disable",
  {
    auditHandledByOperation: true,
    tag: "project:write",
    mcp: { description: "Disable a project (pause deploys / take offline)." },
  },
  ctrl.disable,
);

/* ─── Retry routing and domain checks (no rebuild) ──────────────────────── */
r.get(
  "/:id/routing/retry/stream",
  {
    tag: "project:read",
    mcpExcluded: "Read-only SSE replay of an existing routing repair session.",
  },
  ctrl.retryRoutingStream,
);
r.post(
  "/:id/routing/retry/stream",
  {
    auditHandledByOperation: true,
    tag: "project:write",
    mcpExcluded:
      "SSE transport for live progress. Use the resource’s JSON status/log tools over MCP, or an authenticated HTTP client for streaming.",
  },
  ctrl.retryRoutingStream,
);

r.post(
  "/:id/routing/retry",
  {
    auditHandledByOperation: true,
    tag: "project:write",
    mcp: {
      description:
        "Repair project routes and verify pending domains and HTTPS without rebuilding; clears the routing warning only when all checks succeed.",
    },
  },
  ctrl.retryRouting,
);

/* ─── Set up / take over the self-hosted edge (OpenResty on 80/443) + apply
      the project's routes, WITHOUT a container redeploy. SSE so the port-80/443
      takeover consent can be prompted mid-flight (answered via .../respond). ── */
r.get(
  "/:id/routing/edge-status",
  {
    tag: "project:read",
    mcp: {
      description:
        "Check whether the project's server edge (OpenResty on 80/443) is already set up.",
    },
  },
  ensureEdgeCtrl.edgeStatus,
);
r.post(
  "/:id/routing/ensure-edge/stream",
  {
    tag: "project:write",
    mcpExcluded:
      "SSE transport for live progress. Use the resource’s JSON status/log tools over MCP, or an authenticated HTTP client for streaming.",
  },
  ensureEdgeCtrl.ensureEdgeStream,
);
r.post(
  "/:id/routing/ensure-edge/respond",
  {
    tag: "project:write",
    mcpExcluded:
      "Response to the browser’s ensure-edge SSE session. Use routing/retry and the project pending-actions tool for routing repair; interactive edge setup and proxy takeover remain in the dashboard.",
  },
  ensureEdgeCtrl.ensureEdgeRespond,
);

/* ─── Environment variables ────────────────────────────────────────────── */
// Project-scoped bulk routes (no per-env_var id in the URL) → gate on the
// project, matching what the controllers already assert (permission.assert
// project:read/write) and how /:id/options works. The previous
// project:env_var:* tags required a :envVarId param these routes don't have,
// so the permission middleware 400'd before the handler. Secret VALUES stay
// protected by masking in listEnvVars, not by the route tag.
r.get(
  "/:id/env",
  {
    tag: "project:read",
    mcp: { description: "List a project's environment variables (secret values masked)." },
    query: ProjectControlSchemas.listEnvVars.input,
  },
  ctrl.listEnvVars,
);
// Project env edits go through the MERGE path (PATCH) only — the old destructive
// full-replace PUT was removed (it could wipe/corrupt masked secrets and had no
// remaining caller; the editor sends a diff via mergeEnvVars).
r.patch(
  "/:id/env",
  {
    auditHandledByOperation: true,
    tag: "project:write",
    // Validated by the auto-wired tbValidator (spec.body) → a wrong-shape body
    // is a 400, not a 500 in the service's data.upserts.map. #231
    body: MergeEnvVarsBody,
    mcp: {
      description: "Merge env var changes (upserts + deletes); untouched vars are preserved.",
    },
  },
  ctrl.mergeEnvVars,
);

/* ─── Per-project clone token (git credential override) ────────────────── */
r.get(
  "/:id/clone-token",
  {
    tag: "project:read",
    mcpExcluded:
      "Git credential management is kept in the authenticated dashboard; MCP deploys through the configured credentials.",
  },
  ctrl.getCloneToken,
);
r.patch(
  "/:id/clone-token",
  {
    auditHandledByOperation: true,
    body: UpdateCloneTokenSchema,
    tag: "project:admin",
    mcpExcluded:
      "Git credential management is kept in the authenticated dashboard; MCP deploys through the configured credentials.",
  },
  ctrl.updateCloneToken,
);

/* ─── Git ──────────────────────────────────────────────────────────────── */
r.get(
  "/:id/git",
  { tag: "project:read", mcp: { description: "Get the project's linked git repository info." } },
  ctrl.getGitInfo,
);
r.get(
  "/:id/commit-status",
  {
    tag: "project:read",
    mcp: { description: "Compare the deployed commit against the remote HEAD." },
  },
  ctrl.getCommitStatus,
);

/* ─── Pending actions (everything waiting on a human) ───────────────────── */
r.get(
  "/:id/pending-actions",
  {
    tag: "project:read",
    mcp: {
      description:
        "What is waiting on a human for this project, and how to resolve each item. Covers a deploy blocked on a named cause (e.g. a port already in use), a deploy HELD right now on a decision (answer it with the build-respond tool — the exact action id and body are in the item's resolveWith, and `expiresAt` is when the deploy gives up), a partial-failure release awaiting keep/reject, unsynced routing, unverified domains, and failed/expired certificates. Each item carries `resolveWith`, an array of concrete {method, path, body} calls — use those rather than guessing. Call this after starting a deploy that seems stuck, and whenever a project reads as Action Required. This covers deploy/domain/routing items only — for container-runtime health (crash loops, unhealthy or down containers) read the project's incidents instead. Scoped to ONE project: to ask what is broken across the whole installation (these items for every project, plus runtime incidents, unreachable servers and edge/mail state, ranked by severity), read the issues feed instead.",
    },
  },
  ctrl.getPendingActions,
);
r.post(
  "/:id/git/link",
  {
    auditHandledByOperation: true,
    tag: "project:write",
    body: LinkRepoBody,
    mcp: { description: "Link a git repository to the project." },
  },
  ctrl.linkRepo,
);
r.put(
  "/:id/release-image-source",
  {
    auditHandledByOperation: true,
    tag: "project:write",
    body: SetReleaseSourceBody,
    mcp: {
      description:
        "Atomically configure this single-app project to track and deploy a prebuilt container image from GitHub releases or a version URL.",
    },
  },
  ctrl.setReleaseImageSource,
);
r.get(
  "/:id/branches",
  {
    tag: "project:read",
    mcp: { description: "List the linked repository's branches." },
    query: ProjectControlSchemas.listBranches.input,
  },
  ctrl.listBranches,
);
r.post(
  "/:id/auto-deploy",
  {
    auditHandledByOperation: true,
    tag: "project:write",
    body: SetAutoDeployBody,
    mcp: { description: "Enable/disable auto-deploy on push." },
  },
  ctrl.setAutoDeploy,
);
r.post(
  "/:id/webhook-domain",
  {
    auditHandledByOperation: true,
    tag: "project:write",
    mcp: {
      description:
        "Choose or clear a verified public webhook domain for the project’s GitHub auto-deploy endpoint. This configures webhook delivery; it does not add a site route.",
    },
    body: ProjectControlSchemas.setWebhookDomain.input,
  },
  ctrl.setWebhookDomain,
);
r.post(
  "/:id/branch",
  {
    auditHandledByOperation: true,
    tag: "project:write",
    body: SetBranchBody,
    mcp: { description: "Set the project's deploy branch." },
  },
  ctrl.setBranch,
);

/* ─── Incoming webhooks (generic per-project trigger hooks) ─────────────── */
r.get(
  "/:id/incoming-webhooks",
  {
    tag: "project:read",
    mcp: { description: "List a project's incoming webhooks (dynamic trigger URLs)." },
  },
  incomingWebhooks.list,
);
r.post(
  "/:id/incoming-webhooks",
  {
    tag: "project:write",
    auditHandledByOperation: true,
    body: CreateIncomingWebhookBody,
    mcp: {
      description: "Create an incoming webhook that fires a deploy or job when its URL is called.",
    },
  },
  incomingWebhooks.create,
);
r.patch(
  "/:id/incoming-webhooks/:hookId",
  {
    tag: "project:write",
    auditHandledByOperation: true,
    body: UpdateIncomingWebhookBody,
    mcp: { description: "Update an incoming webhook (name/enabled/action/auth)." },
  },
  incomingWebhooks.update,
);
r.post(
  "/:id/incoming-webhooks/:hookId/rotate",
  {
    tag: "project:write",
    auditHandledByOperation: true,
    mcp: { description: "Rotate an incoming webhook's token / HMAC secret." },
  },
  incomingWebhooks.rotate,
);
r.delete(
  "/:id/incoming-webhooks/:hookId",
  {
    tag: "project:write",
    auditHandledByOperation: true,
    mcp: { description: "Delete an incoming webhook." },
  },
  incomingWebhooks.remove,
);
r.get(
  "/:id/incoming-webhooks/:hookId/deliveries",
  {
    tag: "project:read",
    mcp: { description: "List one incoming webhook's recent deliveries (paginated)." },
    query: WebhookPageInputSchema,
  },
  incomingWebhooks.hookDeliveries,
);
r.get(
  "/:id/webhook-deliveries",
  {
    tag: "project:read",
    mcp: {
      description:
        "List a project's webhook delivery feed — GitHub pushes + custom hooks (paginated).",
    },
    query: WebhookPageInputSchema,
  },
  incomingWebhooks.deliveries,
);

r.post(
  "/:id/incoming-webhooks/:hookId/invoke",
  {
    tag: "project:write",
    auditHandledByOperation: true,
    mcp: {
      description:
        "Invoke an enabled incoming webhook with the current and saved actor's permissions.",
    },
  },
  incomingWebhooks.invoke,
);

/* ─── Resources ────────────────────────────────────────────────────────── */
r.get(
  "/:id/cluster",
  {
    tag: "project:read",
    localOnly: true,
    mcp: {
      description:
        "Read the project’s selected cluster, desired replicas, activeDeploymentId, updatedAt and observed pod readiness. Use those exact IDs/timestamps as scaling preconditions. error means runtime observation failed; saved desired replicas are not proof of running replicas.",
    },
  },
  ctrl.getClusterWorkload,
);
r.get(
  "/:id/cluster/volumes",
  {
    tag: "project:read",
    localOnly: true,
    mcp: {
      description:
        "List the project's shared volumes, current attachment health and backups. Observe this status after a mutation.",
    },
  },
  ctrl.listClusterVolumes,
);
r.get(
  "/:id/cluster/volumes/backups",
  {
    tag: "project:read",
    localOnly: true,
    mcp: {
      description:
        "List project file backups, including archives whose source volume was deleted. Restore a completed archive into a new volume.",
    },
  },
  ctrl.listClusterVolumeBackups,
);
r.patch(
  "/:id/cluster/volumes/backups",
  {
    tag: "project:write",
    localOnly: true,
    auditHandledByOperation: true,
    body: ProjectVolumeSchemas.scheduleClusterVolumeBackups.input,
    mcp: {
      description:
        "Schedule hourly or daily file backups with a retained archive count, or select manual to stop the schedule. The native storage controller runs accepted schedules independently.",
    },
  },
  ctrl.clusterVolumeCommand("scheduleClusterVolumeBackups"),
);
r.delete(
  "/:id/cluster/volumes/backups",
  {
    tag: "project:write",
    localOnly: true,
    auditHandledByOperation: true,
    body: ProjectVolumeSchemas.removeClusterVolumeBackup.input,
    mcp: {
      description:
        "Permanently delete a project file backup archive. Confirm the exact backupName using confirmName; the source volume is preserved.",
    },
  },
  ctrl.clusterVolumeCommand("removeClusterVolumeBackup"),
);
r.get(
  "/:id/cluster/volumes/stream",
  {
    tag: "project:read",
    localOnly: true,
    mcpExcluded: "SSE transport for live volume status. Use the JSON list tool over MCP.",
  },
  ctrl.clusterVolumeStream,
);
r.post(
  "/:id/cluster/volumes",
  {
    tag: "project:write",
    localOnly: true,
    auditHandledByOperation: true,
    body: ProjectVolumeSchemas.createClusterVolume.input,
    mcp: {
      description:
        "Create a replicated shared volume, optionally restored into a new volume from a completed project backup. Reuse a stable requestId after a lost response. Attach it using the project's cluster config mounts and deploy.",
    },
  },
  ctrl.clusterVolumeCommand("createClusterVolume"),
);
r.patch(
  "/:id/cluster/volumes",
  {
    tag: "project:write",
    localOnly: true,
    auditHandledByOperation: true,
    body: ProjectVolumeSchemas.resizeClusterVolume.input,
    mcp: {
      description:
        "Grow a project shared volume using its current resourceVersion. Volumes cannot shrink; inspect status until expansion finishes.",
    },
  },
  ctrl.clusterVolumeCommand("resizeClusterVolume"),
);
r.post(
  "/:id/cluster/volumes/backup",
  {
    tag: "project:write",
    localOnly: true,
    auditHandledByOperation: true,
    body: ProjectVolumeSchemas.backupClusterVolume.input,
    mcp: {
      description:
        "Create a file-volume backup at the cluster's configured external destination. Use a stable requestId and inspect progress; application-consistent snapshots may require pausing writes.",
    },
  },
  ctrl.clusterVolumeCommand("backupClusterVolume"),
);
r.delete(
  "/:id/cluster/volumes",
  {
    tag: "project:write",
    localOnly: true,
    auditHandledByOperation: true,
    body: ProjectVolumeSchemas.removeClusterVolume.input,
    mcp: {
      description:
        "Permanently delete an unmounted project volume with its resourceVersion, matching confirmName and deleteData:true. Disconnect and redeploy first. External backups are preserved.",
    },
  },
  ctrl.clusterVolumeCommand("removeClusterVolume"),
);
r.get(
  "/:id/cluster/databases",
  {
    tag: "project:read",
    localOnly: true,
    mcp: {
      description:
        "List this project’s managed cluster databases with saved lifecycle progress and connections. Database replication has a separate lifecycle from stateless application replicas.",
    },
  },
  ctrl.listClusterDatabases,
);
r.get(
  "/:id/cluster/databases/imports",
  {
    tag: "project:read",
    localOnly: true,
    mcp: {
      description:
        "List completed PostgreSQL and Redis backups eligible for import into a new database on a server cluster. Requires source-project administrator access; returns reviewed backup identities, never archive paths or credentials.",
    },
  },
  ctrl.listClusterDatabaseImports,
);
r.get(
  "/:id/cluster/databases/stream",
  {
    tag: "project:read",
    localOnly: true,
    mcpExcluded:
      "SSE transport for live progress. Use the resource’s JSON status/log tools over MCP, or an authenticated HTTP client for streaming.",
  },
  ctrl.clusterDatabaseStream,
);
r.post(
  "/:id/cluster/databases/inspect",
  {
    tag: "project:read",
    readOnly: true,
    localOnly: true,
    body: ProjectDatabaseSchemas.getClusterDatabase.input,
    mcp: {
      description:
        "Read a managed database by databaseId. Set observe:true for fresh native-operator, instance, volume and backup observations; inspect timestamps and errors before claiming readiness.",
    },
  },
  ctrl.clusterDatabaseCommand("getClusterDatabase"),
);
r.post(
  "/:id/cluster/databases",
  {
    tag: "project:write",
    localOnly: true,
    auditHandledByOperation: true,
    body: ProjectDatabaseSchemas.createClusterDatabase.input,
    mcp: {
      description:
        "Create PostgreSQL or Redis on a ready cluster using a stable requestId. Optional clusterId prepares data before moving a Docker application. Choose only one source: restoreFrom a managed backup, importFrom a listed project backup, or copyFrom a ready PostgreSQL database for a reviewed copy or major upgrade. The original is preserved; switching application connections and deployment are separate actions. Redis cluster mode requires clusterAwareClient:true. Inspect saved progress until ready.",
    },
  },
  ctrl.clusterDatabaseCommand("createClusterDatabase"),
);
r.patch(
  "/:id/cluster/databases",
  {
    tag: "project:write",
    localOnly: true,
    auditHandledByOperation: true,
    body: ProjectDatabaseSchemas.updateClusterDatabase.input,
    mcp: {
      description:
        "Update database resources and replica count using its latest expectedSequence. Redis partition changes require a previously configured backup destination and confirmRedisRebalance:true; a backup is verified before moving data. Major PostgreSQL upgrades use a separate copy, not an in-place edit. Inspect progress for completion.",
    },
  },
  ctrl.clusterDatabaseCommand("updateClusterDatabase"),
);
r.post(
  "/:id/cluster/databases/retry",
  {
    tag: "project:write",
    localOnly: true,
    auditHandledByOperation: true,
    body: ProjectDatabaseSchemas.retryClusterDatabase.input,
    mcp: {
      description:
        "Resume a failed or interrupted database operation using its latest expectedSequence. Retains the saved intent, including deletion; inspect its error and progress before retrying.",
    },
  },
  ctrl.clusterDatabaseCommand("retryClusterDatabase"),
);
r.post(
  "/:id/cluster/databases/backup",
  {
    tag: "project:write",
    localOnly: true,
    auditHandledByOperation: true,
    body: ProjectDatabaseSchemas.backupClusterDatabase.input,
    mcp: {
      description:
        "Save a PostgreSQL or Redis backup using the latest expectedSequence and configured destination. Inspect until the backup completes. Redis snapshots are consistent per partition, with no cross-partition transaction guarantee.",
    },
  },
  ctrl.clusterDatabaseCommand("backupClusterDatabase"),
);
r.delete(
  "/:id/cluster/databases",
  {
    tag: "project:write",
    localOnly: true,
    auditHandledByOperation: true,
    body: ProjectDatabaseSchemas.removeClusterDatabase.input,
    mcp: {
      description:
        "Stop a managed database and retain its volumes when deleteData:false, or permanently delete owned database data when true. Requires its exact name and latest expectedSequence. Retained data continues to block project/runtime cleanup; poll inspection until the operation finishes.",
    },
  },
  ctrl.clusterDatabaseCommand("removeClusterDatabase"),
);
r.post(
  "/:id/cluster/databases/connect",
  {
    tag: "project:write",
    localOnly: true,
    auditHandledByOperation: true,
    body: ProjectDatabaseSchemas.connectClusterDatabase.input,
    mcp: {
      description:
        "Save this database’s application connection under envKey, or remove its managed connection with envKey:null. Requires latest expectedSequence and refuses overwriting an unrelated variable. Redeploy the application separately to apply environment changes.",
    },
  },
  ctrl.clusterDatabaseCommand("connectClusterDatabase"),
);
r.patch(
  "/:id/cluster",
  {
    tag: "project:write",
    localOnly: true,
    auditHandledByOperation: true,
    body: ProjectClusterSchemas.setClusterTarget.input,
    mcp: {
      description:
        "Select a ready k3s compute cluster for one stateless application or worker, or clear its selection with clusterId:null. Requires expectedUpdatedAt from the latest cluster read and stateless:true. Source builds need a reachable imageRepository. Saves the target only; deploy separately. Compose projects, persistent app mounts and live worker changes are unsupported.",
    },
  },
  ctrl.setClusterTarget,
);
r.post(
  "/:id/cluster/scale",
  {
    tag: "project:write",
    localOnly: true,
    auditHandledByOperation: true,
    body: ProjectClusterSchemas.scaleClusterWorkload.input,
    mcp: {
      description:
        "Scale an already deployed k3s application to 1–100 replicas using expectedDeploymentId and expectedUpdatedAt from a fresh cluster read. Starts a configuration deployment with the active immutable image, without rebuilding. Poll the returned deploymentId, then verify observed ready/available replicas. This is manual replica scaling, not a metrics-driven autoscaling policy.",
    },
  },
  ctrl.scaleClusterWorkload,
);
r.get(
  "/:id/resources",
  { tag: "project:read", mcp: { description: "Get the project's CPU/RAM/disk resource config." } },
  ctrl.getResources,
);
r.get(
  "/:id/rollback-capacity",
  {
    tag: "project:read",
    mcp: {
      description:
        "Get the rollback retention window in force (explicit or disk-sized), the measured per-release size, and the deploy host's free disk.",
    },
  },
  ctrl.getRollbackCapacity,
);
r.patch(
  "/:id/resources",
  {
    auditHandledByOperation: true,
    tag: "project:write",
    body: UpdateResourcesBody,
    mcp: { description: "Update the project's CPU/RAM/disk, sleep mode, or port." },
  },
  ctrl.updateResources,
);
r.post(
  "/:id/resources",
  {
    auditHandledByOperation: true,
    tag: "project:write",
    mcpExcluded: "Compatibility alias; use PATCH /api/projects/:id/resources.",
  },
  ctrl.updateResources,
);

/* ─── Sleep mode ───────────────────────────────────────────────────────── */
r.post(
  "/:id/sleep-mode",
  {
    auditHandledByOperation: true,
    tag: "project:write",
    body: SetSleepModeBody,
    mcp: { description: "Set the project's sleep mode (auto_sleep / always_on)." },
  },
  ctrl.setSleepMode,
);

/* ─── Deployments ──────────────────────────────────────────────────────── */
r.get(
  "/:id/deployments",
  {
    tag: "project:deployment:list",
    mcp: { description: "List a project's deployments (history, statuses)." },
    query: ProjectControlSchemas.listDeployments.input,
  },
  ctrl.listDeployments,
);
r.post(
  "/:id/deployment-session",
  {
    tag: "project:read",
    readOnly: true,
    mcpExcluded:
      "Browser deployment-session handoff. MCP starts deployments through /api/deployments/build/access.",
  },
  ctrl.deploymentSession,
);

/* ─── Custom domain ────────────────────────────────────────────────────── */
r.post(
  "/:id/connect",
  {
    tag: "project:write",
    body: ConnectProjectDomainInputSchema,
    auditHandledByOperation: true,
    mcp: {
      description:
        "Attach a custom domain to this project, with optional www alias or external ingress. Inspect the returned routing status and pending actions; attaching a hostname does not prove DNS or HTTPS readiness.",
    },
  },
  ctrl.connectDomain,
);

/* ─── Runtime logs ─────────────────────────────────────────────────────── */
r.get(
  "/:id/logs",
  {
    tag: "project:read",
    mcp: { description: "Fetch the project's runtime logs (non-streaming)." },
    query: ProjectControlSchemas.runtimeLogs.input,
  },
  ctrl.runtimeLogs,
);
r.get(
  "/:id/external/containers",
  {
    tag: "project:read",
    mcp: {
      description: "List the containers an external project's matchers select on its server.",
    },
  },
  ctrl.listExternalContainers,
);
r.get(
  "/:id/logs/stream",
  {
    tag: "project:read",
    mcpExcluded:
      "SSE transport for live progress. Use the resource’s JSON status/log tools over MCP, or an authenticated HTTP client for streaming.",
  },
  ctrl.runtimeLogStream,
);

/* ─── Server HTTP request logs ─────────────────────────────────────────── */
r.get(
  "/:id/server-logs/recent",
  {
    tag: "project:read",
    mcp: { description: "Fetch recent HTTP request logs for the project." },
    query: RecentServerLogsInputSchema,
  },
  ctrl.recentServerLogs,
);
r.get(
  "/:id/server-logs/stream-token",
  {
    tag: "project:read",
    mcpExcluded:
      "Browser streaming credential. MCP reads the bounded server-logs endpoint with its own bearer.",
  },
  ctrl.serverLogStreamToken,
);
r.get(
  "/:id/server-logs/stream",
  {
    tag: "project:read",
    mcpExcluded:
      "SSE transport for live progress. Use the resource’s JSON status/log tools over MCP, or an authenticated HTTP client for streaming.",
  },
  ctrl.serverLogStream,
);

/* ─── Project transfer / promote (local → cloud) ───────────────────────── */
// Self-hosted ONLY: promote pushes a LOCAL project to the SaaS, and bring-home
// pulls it back. Meaningless on the SaaS itself (it IS the cloud), so localOnly
// 404s them there — never proxied, never run in CLOUD_MODE.
r.post(
  "/:id/transfer/to-cloud",
  {
    tag: "project:admin",
    localOnly: true,
    auditHandledByOperation: true,
    mcp: {
      description:
        "Transfer this project’s control-plane records to the connected Openship Cloud. Inspect the returned deployment guidance: record transfer is not workload or volume migration. k3s projects cannot use this Docker/Cloud transfer path.",
    },
  },
  transfer.transferToCloud,
);
r.post(
  "/:id/transfer/to-self-hosted",
  {
    tag: "project:admin",
    localOnly: true,
    auditHandledByOperation: true,
    mcp: {
      description:
        "Transfer this Cloud project’s control-plane records to this self-hosted instance. Inspect returned guidance and deploy separately; this does not move database volumes. k3s workloads use their cluster lifecycle.",
    },
  },
  transfer.transferToSelfHosted,
);

export const projectRoutes = r.hono;
