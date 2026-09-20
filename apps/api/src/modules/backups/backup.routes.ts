/**
 * Backup HTTP routes — mounted at /api by app.ts.
 *
 * Policy + run paths are scoped under projects to match the existing
 * dashboard URL structure. Webhook + scheduled triggers land in Chunk 2.
 */

import { Hono } from "hono";
import { CreateBackupPolicySchema, UpdateBackupPolicySchema, ProtectBackupRunSchema, PrepareBackupRestoreSchema, ApplyBackupRestoreSchema } from "@repo/contracts";
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
r.post("/projects/:projectId/backup-policies", { tag: "project:write", ids: { project: "projectId" }, body: CreateBackupPolicySchema, auditHandledByOperation: true }, cloudProjectProxy, ctrl.createProjectPolicy);
r.patch("/backup-policies/:policyId", { tag: "backup_destination:backup_policy:write", body: UpdateBackupPolicySchema, auditHandledByOperation: true }, ctrl.patchPolicy);
r.delete("/backup-policies/:policyId", { tag: "backup_destination:backup_policy:write", auditHandledByOperation: true }, ctrl.removePolicy);

// Manual trigger
r.post("/backup-policies/:policyId/run", { tag: "backup_destination:backup_policy:write", auditHandledByOperation: true }, ctrl.triggerManual);

// Runs
r.get("/projects/:projectId/backup-runs", { tag: "project:write", ids: { project: "projectId" }, mcp: { description: "List a project's backup runs (history, status)." } }, cloudProjectProxy, ctrl.listRuns);
r.get("/backup-runs/:runId", { tag: "backup_destination:backup_run:read", mcp: { description: "Get one backup run's details/status." } }, ctrl.getOneRun);
r.get("/backup-runs/:runId/stream", { tag: "backup_destination:backup_run:read" }, ctrl.streamRun);

// Protect-from-retention
r.post("/backup-runs/:runId/protect", { tag: "backup_destination:backup_run:write", body: ProtectBackupRunSchema, auditHandledByOperation: true }, ctrl.protectRun);

// Restore
r.post("/backup-runs/:runId/restore/prepare", { tag: "backup_destination:backup_run:admin", body: PrepareBackupRestoreSchema, auditHandledByOperation: true }, ctrl.prepareRestore);
r.post("/backup-restores/:restoreId/apply", { tag: "backup_destination:backup_restore:admin", body: ApplyBackupRestoreSchema, auditHandledByOperation: true }, ctrl.applyRestore);
r.post("/backup-restores/:restoreId/cancel", { tag: "backup_destination:backup_restore:admin", auditHandledByOperation: true }, ctrl.cancelRestore);
r.get("/backup-restores/:restoreId", { tag: "backup_destination:backup_restore:read", mcp: { description: "Get one backup restore's status." } }, ctrl.getOneRestore);
r.get("/backup-restores/:restoreId/stream", { tag: "backup_destination:backup_restore:read" }, ctrl.streamRestore);

export const backupRoutes = r.hono;
