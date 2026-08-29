/**
 * Deployment routes - mounted at /api/deployments in app.ts.
 *
 * Every route declares a permission tag enforced by secureRouter.
 */

import { Hono } from "hono";
import { secureRouter } from "../../lib/secure-router";
import { cloudDeploymentProxy, cloudProjectProxyByQuery } from "../../lib/cloud/project-router";
import * as ctrl from "./deployment.controller";
import { TriggerDeployBody, BuildAccessBody, PrepareDeployBody, BuildRespondBody } from "./deployment.schema";

const r = secureRouter(new Hono(), {
  module: "deployments",
  basePath: "/api/deployments",
});


/* ── CRUD + operations ─────────────────────────────────────────────── */
// ?projectId=<cloud project> proxies to the SaaS; org-wide list stays local.
r.get(
  "/",
  {
    tag: "deployment:list",
    mcp: { description: "List deployments in the org (optionally filter with query.projectId)." },
  },
  cloudProjectProxyByQuery,
  ctrl.list,
);
// Collection-scoped writes — no :id in the URL, controller resolves the
// project from the JSON body. `collection: true` tells the permission
// middleware to scope the check to the caller's org rather than demand
// a :id param it can't supply.
r.post(
  "/",
  {
    tag: "deployment:write",
    collection: true,
    // `ctrl.create` asserts {project, body.projectId, write} itself (projectId is
    // required by TriggerDeployBody), so the collection `"*"` pre-check is
    // redundant — and it was the reason a project-scoped token could never
    // redeploy a project it was granted.
    collectionProject: true,
    body: TriggerDeployBody,
    mcp: {
      description:
        "Git-based deploy — redeploy an already-linked project from its git source. To deploy a LOCAL FOLDER instead, use the folder-upload flow: projects folder/session → (upload) → folder/scan → projects/ensure → deployments/build/access.",
    },
  },
  ctrl.create,
);
r.post(
  "/prepare",
  {
    tag: "deployment:write",
    collection: true,
    body: PrepareDeployBody,
    mcp: { description: "Detect stack/build config for a git repo or local path before deploying." },
  },
  ctrl.prepare,
);

/* ── Build access (creates a new deployment - no ID yet) ───────────── */
r.post(
  "/build/access",
  {
    tag: "deployment:write",
    collection: true,
    // `ctrl.buildAccess` asserts {project, body.projectId, write} itself — see
    // the same flag on POST / above.
    collectionProject: true,
    body: BuildAccessBody,
    mcp: {
      description:
        "Deploy — the wizard 'Deploy' action. Starts the build + deployment. For a folder-upload deploy pass projectId (from projects/ensure) and uploadSessionId (from folder/session). Wizard settings (envVars, publicEndpoints, buildStrategy, runtimeMode, cloudResourceTier) are optional. Returns { success, deployment_id, project_id }. Do NOT set deployTarget:'cloud' on a self-hosted instance — it triggers promote-to-cloud; leave it unset and the upload session mode decides.",
    },
  },
  ctrl.buildAccess,
);

/* ── SSL ───────────────────────────────────────────────────────────── */
// Side-effect-free SSL status probe — uses POST only to carry hostname
// in body. Permission required is "read"; readOnly tells the scanner
// the POST + read combination is intentional.
r.post("/ssl/status", { tag: "deployment:read", readOnly: true, collection: true }, ctrl.sslStatus);
r.post("/ssl/renew", { tag: "deployment:write", collection: true }, ctrl.sslRenew);

/* ── Deployment by ID ──────────────────────────────────────────────── */
// cloudDeploymentProxy (after the permission middleware) forwards the request
// to the SaaS when the deployment belongs to a cloud project, else falls
// through to the local handler.
r.get(
  "/:id",
  {
    tag: "deployment:read",
    mcp: { description: "Get a deployment by id — status, urls, timing, error summary." },
  },
  cloudDeploymentProxy,
  ctrl.getById,
);
r.get(
  "/:id/logs",
  { tag: "deployment:read", mcp: { description: "Fetch a deployment's build/runtime logs." } },
  cloudDeploymentProxy,
  ctrl.logs,
);
r.get("/:id/stream", { tag: "deployment:read" }, cloudDeploymentProxy, ctrl.stream);
r.get(
  "/:id/build",
  {
    tag: "deployment:read",
    mcp: {
      description:
        "Live build/deploy status: progress, current step, per-service state, and — when the deploy is HELD waiting on a decision — `pendingPrompt` (its `actions[].id` is what the build-respond tool takes, and `expiresAt` is when the deploy gives up). Also carries `deploymentStatus` (the real persisted status, e.g. action_required), `errorCode`/`errorDetails` for a classified failure, `decisionPending` for a partial-failure release, and advisory `portCheck` results. Prefer the pending-actions tool when you want the resolution spelled out as a call.",
    },
  },
  cloudDeploymentProxy,
  ctrl.buildStatus,
);
r.get(
  "/:id/pending",
  {
    tag: "deployment:read",
    mcp: {
      description:
        "What this deploy is waiting on, each item carrying the concrete call that resolves it in `resolveWith` ({method, path, body}). Poll this when a deploy appears stuck: a blocking prompt (e.g. a port already in use) shows up here with its action ids and `expiresAt`, so you never have to guess how to answer it.",
    },
  },
  cloudDeploymentProxy,
  ctrl.pendingActions,
);
r.post("/:id/build", { tag: "deployment:write" }, cloudDeploymentProxy, ctrl.buildStart);
r.post(
  "/:id/redeploy",
  { tag: "deployment:write", mcp: { description: "Re-run the latest deployment for this project." } },
  cloudDeploymentProxy,
  ctrl.buildRedeploy,
);
r.get(
  "/:id/restore-plan",
  {
    tag: "deployment:read",
    mcp: {
      description:
        "How a rollback to this deployment would run: instant from its retained image, or a rebuild from its commit.",
    },
  },
  cloudDeploymentProxy,
  ctrl.restorePlan,
);
r.post(
  "/:id/rollback",
  { tag: "deployment:write", mcp: { description: "Roll back to this deployment's artifact/commit." } },
  cloudDeploymentProxy,
  ctrl.rollback,
);
r.post("/:id/pin", { tag: "deployment:write" }, cloudDeploymentProxy, ctrl.pin);
r.post("/:id/reject", { tag: "deployment:write", mcp: { description: "Reject a partial-failure deployment awaiting a decision (roll back the changed services)." } }, cloudDeploymentProxy, ctrl.reject);
r.post("/:id/keep", { tag: "deployment:write", mcp: { description: "Keep a partial-failure deployment awaiting a decision (accept the succeeded services)." } }, cloudDeploymentProxy, ctrl.keep);
r.post(
  "/:id/skip-port-check",
  {
    tag: "deployment:write",
    mcp: {
      description:
        "Dismiss the advisory 'nothing is listening on this port' warning for a target (service id, or the port as a string). Advisory-only — it never changes the deployment's status. Use when the app legitimately listens elsewhere.",
    },
  },
  cloudDeploymentProxy,
  ctrl.skipPortCheck,
);
r.post(
  "/:id/cancel",
  { tag: "deployment:write", mcp: { description: "Cancel an in-progress deployment." } },
  cloudDeploymentProxy,
  ctrl.cancel,
);
r.delete("/:id", { tag: "deployment:admin" }, cloudDeploymentProxy, ctrl.remove);
r.post("/:id/restart", { tag: "deployment:write", mcp: { description: "Restart the running container(s) for this deployment." } }, cloudDeploymentProxy, ctrl.restart);
r.post(
  "/:id/build/respond",
  {
    tag: "deployment:write",
    body: BuildRespondBody,
    mcp: {
      description:
        "Answer a decision the deploy is HELD on, unblocking the pipeline. `action` must be one of the ids the prompt itself offers (e.g. free_port / abort for a port conflict) — read them from the pending-actions or build-status tool rather than guessing; do not invent an id. The deploy aborts on its own if nobody answers before the prompt's `expiresAt`.",
    },
  },
  cloudDeploymentProxy,
  ctrl.buildRespond,
);
r.get("/:id/info", { tag: "deployment:read", mcp: { description: "Get container info for this deployment." } }, cloudDeploymentProxy, ctrl.containerInfo);
r.get("/:id/usage", { tag: "deployment:read", mcp: { description: "Get container CPU/memory usage for this deployment." } }, cloudDeploymentProxy, ctrl.containerUsage);

export const deploymentRoutes = r.hono;
