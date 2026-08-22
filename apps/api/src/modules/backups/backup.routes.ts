/**
 * Backup HTTP routes — mounted at /api by app.ts.
 *
 * Policy + run paths are scoped under projects to match the existing
 * dashboard URL structure. Webhook + scheduled triggers land in Chunk 2.
 */

import { Hono } from "hono";
import { authMiddleware } from "../../middleware/auth";
import { secureRouter } from "../../lib/secure-router";
import { cloudProjectProxy } from "../../lib/cloud/project-router";
import * as ctrl from "./backup.controller";

const r = secureRouter(new Hono(), {
  module: "backups",
  basePath: "/api",
});

// ⚠ This sub-app is mounted at `/api` (app.ts:62). Using `.use("*", …)`
// here would apply authMiddleware to EVERY /api/* request in Hono v4 —
// including unrelated sibling sub-apps mounted at /api/cloud, etc. —
// which would 401 the cloud `exchange-code` endpoint among others.
// Scope the auth middleware to the actual backup paths instead.
r.use("/projects/*", authMiddleware);
r.use("/backup-policies/*", authMiddleware);
r.use("/backup-runs/*", authMiddleware);
r.use("/backup-restores/*", authMiddleware);

// Policies — project-scoped routes proxy to the SaaS for cloud projects.
r.get("/projects/:projectId/backup-policies", { tag: "project:write", ids: { project: "projectId" }, mcp: { description: "List a project's backup policies (schedules/retention)." } }, cloudProjectProxy, ctrl.listProjectPolicies);
r.post("/projects/:projectId/backup-policies", { tag: "project:write", ids: { project: "projectId" } }, cloudProjectProxy, ctrl.createProjectPolicy);
r.post("/projects/:projectId/backup-policies/apply-defaults", { tag: "project:write", ids: { project: "projectId" }, mcp: { description: "Set a project's backups up from its app template's defaults, one policy per stateful service. Idempotent; skips services that already have a policy." } }, cloudProjectProxy, ctrl.applyProjectPolicyDefaults);
r.patch("/backup-policies/:policyId", { tag: "backup_destination:backup_policy:write" }, ctrl.patchPolicy);
r.delete("/backup-policies/:policyId", { tag: "backup_destination:backup_policy:write" }, ctrl.removePolicy);

// Manual trigger
r.post("/backup-policies/:policyId/run", { tag: "backup_destination:backup_policy:write" }, ctrl.triggerManual);

// Runs
r.get("/projects/:projectId/backup-runs", { tag: "project:write", ids: { project: "projectId" }, mcp: { description: "List a project's backup runs (history, status)." } }, cloudProjectProxy, ctrl.listRuns);
r.get("/backup-runs/:runId", { tag: "backup_destination:backup_run:read", mcp: { description: "Get one backup run's details/status." } }, ctrl.getOneRun);
r.get("/backup-runs/:runId/stream", { tag: "backup_destination:backup_run:read" }, ctrl.streamRun);

// Protect-from-retention
r.post("/backup-runs/:runId/protect", { tag: "backup_destination:backup_run:write" }, ctrl.protectRun);

// Restore
r.post("/backup-runs/:runId/restore/prepare", { tag: "backup_destination:backup_run:write" }, ctrl.prepareRestore);
r.post("/backup-restores/:restoreId/apply", { tag: "backup_destination:backup_restore:write" }, ctrl.applyRestore);
r.post("/backup-restores/:restoreId/cancel", { tag: "backup_destination:backup_restore:write" }, ctrl.cancelRestore);
r.get("/backup-restores/:restoreId", { tag: "backup_destination:backup_restore:read", mcp: { description: "Get one backup restore's status." } }, ctrl.getOneRestore);
r.get("/backup-restores/:restoreId/stream", { tag: "backup_destination:backup_restore:read" }, ctrl.streamRestore);

export const backupRoutes = r.hono;

