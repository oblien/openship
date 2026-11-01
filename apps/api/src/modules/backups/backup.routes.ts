/**
 * Backup HTTP routes — mounted at /api by app.ts.
 *
 * Policy + run paths are scoped under projects to match the existing
 * dashboard URL structure. Webhook + scheduled triggers land in Chunk 2.
 */

import { Hono } from "hono";
import {
  ListBackupRunsSchema,
  CreateBackupPolicySchema,
  UpdateBackupPolicySchema,
  RunBackupPolicySchema,
  ProtectBackupRunSchema,
  PrepareBackupRestoreSchema,
  ApplyBackupRestoreSchema,
} from "@repo/contracts";
import { secureRouter } from "../../lib/secure-router";
import * as ctrl from "./backup.controller";

const r = secureRouter(new Hono(), {
  module: "backups",
  basePath: "/api",
});

// secureRouter authenticates each declared route before checking its permissions.

// Policies — project-scoped routes proxy to the SaaS for cloud projects.
r.get("/projects/:projectId/backup-policies", { tag: "project:write", ids: { project: "projectId" }, mcp: { description: "List a project's backup policies (schedules/retention)." } }, ctrl.listProjectPolicies);
r.post("/projects/:projectId/backup-policies", { tag: "project:write", ids: { project: "projectId" }, body: CreateBackupPolicySchema, auditHandledByOperation: true, mcp: { description: "Create a project or service backup policy with destination, schedule and retention. For one-click volume/data backup, use the existing policy payload defaults; source code remains in its repository. Run the policy separately to test it." } }, ctrl.createProjectPolicy);
r.patch("/backup-policies/:policyId", { tag: "backup_destination:backup_policy:write", body: UpdateBackupPolicySchema, auditHandledByOperation: true, mcp: { description: "Update a backup policy’s schedule, retention, payload or destination. Omitted fields are preserved. Changing retention can prune old unprotected backups." } }, ctrl.patchPolicy);
r.delete("/backup-policies/:policyId", { tag: "backup_destination:backup_policy:write", auditHandledByOperation: true, mcp: { description: "Disable and remove this backup policy. Existing backup history remains available according to its retention and destination state." } }, ctrl.removePolicy);

// Manual trigger
r.post("/backup-policies/:policyId/run", { tag: "backup_destination:backup_policy:write", body: RunBackupPolicySchema, auditHandledByOperation: true, mcp: { description: "Start an on-demand backup under this policy. Returns runId and possibly runIds for a multi-service batch; poll each run until succeeded or failed. Accepted work is not a completed backup." } }, ctrl.triggerManual);

// Runs
r.get("/projects/:projectId/backup-runs", { tag: "project:write", ids: { project: "projectId" }, mcp: { description: "List a project's backup runs (history, status)." }, query: ListBackupRunsSchema }, ctrl.listRuns);
r.get("/backup-runs/:runId", { tag: "backup_destination:backup_run:read", mcp: { description: "Get one backup run's details/status." } }, ctrl.getOneRun);
r.get("/backup-runs/:runId/stream", { tag: "backup_destination:backup_run:read", mcpExcluded: "SSE transport for live progress. Use the resource’s JSON status/log tools over MCP, or an authenticated HTTP client for streaming." }, ctrl.streamRun);

// Protect-from-retention
r.post("/backup-runs/:runId/protect", { tag: "backup_destination:backup_run:write", body: ProtectBackupRunSchema, auditHandledByOperation: true, mcp: { description: "Protect or unprotect this backup from retention cleanup, optionally until a specified time. Read the returned retention lock and backup status." } }, ctrl.protectRun);

// Restore
r.post("/backup-runs/:runId/restore/prepare", { tag: "backup_destination:backup_run:admin", body: PrepareBackupRestoreSchema, auditHandledByOperation: true, mcp: { description: "Prepare restoration from this backup without applying it. Returns restoreId and confirmationToken. Poll the restore until prepared, review its target and mode, then explicitly apply the returned token." } }, ctrl.prepareRestore);
r.post("/backup-restores/:restoreId/apply", { tag: "backup_destination:backup_restore:admin", body: ApplyBackupRestoreSchema, auditHandledByOperation: true, mcp: { description: "Apply a prepared restore using its returned confirmationToken. In-place restoration overwrites target data and can stop the service. Poll restore status until it finishes before reporting success." } }, ctrl.applyRestore);
r.post("/backup-restores/:restoreId/cancel", { tag: "backup_destination:backup_restore:admin", auditHandledByOperation: true, mcp: { description: "Request cancellation of this backup restore. Poll the restore’s returned status; accepted cancellation does not undo data already written during apply." } }, ctrl.cancelRestore);
r.get("/backup-restores/:restoreId", { tag: "backup_destination:backup_restore:read", mcp: { description: "Get one backup restore's status." } }, ctrl.getOneRestore);
r.get("/backup-restores/:restoreId/stream", { tag: "backup_destination:backup_restore:read", mcpExcluded: "SSE transport for live progress. Use the resource’s JSON status/log tools over MCP, or an authenticated HTTP client for streaming." }, ctrl.streamRestore);

export const backupRoutes = r.hono;
