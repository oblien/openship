import crypto from "node:crypto";
import { AppError, NotFoundError, OperationError, ValidationError } from "@repo/contracts";
import { safeErrorMessage } from "@repo/core";
import { repos } from "@repo/db";
import type { ExecutionContext } from "../../../context";
import type { BackupDependencies } from "../../../backups";
import { runEvents } from "../../lib/run-events";
import { audit, operationAuditContext } from "../../lib/audit-emitter";
import { authorization } from "../../lib/authorization";
import { assertResourceInOrg } from "../../lib/resource-access";
import { backupRunBus, type BackupRunEvent } from "./backup.sse";
import { restoreRunBus, type RestoreRunEvent } from "./restore.sse";
import { restoreOrchestrator } from "./restore.orchestrator";
import { triggerManualBackup } from "./triggers/manual";
import { withBackupRunLock } from "./backup-lock";
import { presentBackupRun, presentBackupRestore, presentBackupArtifacts } from "./backup.presenters";
import * as service from "./backup.service";

async function result<T>(work: () => Promise<T>, status = 400): Promise<T> {
  try { return await work(); }
  catch (error) {
    if (error instanceof AppError) throw error;
    throw new OperationError(safeErrorMessage(error), status, "BACKUP_OPERATION_FAILED");
  }
}
function record(ctx: ExecutionContext, type: "backup_policy" | "backup_run" | "backup_restore", id: string, operation: string, after: object = {}) {
  audit.recordAsync(operationAuditContext(ctx), { eventType: `backup_destination:${type}:write`, resourceType: type, resourceId: id, after: { operation, ...after } });
}
async function authorize(ctx: ExecutionContext, resourceType: "project" | "server" | "backup_destination", resourceId: string, action: "write" | "admin") {
  return authorization.authorize({ ...ctx, scopeMode: "fixed" }, { resourceType, resourceId, action });
}
async function policyAccess(ctx: ExecutionContext, id: string, action: "write" | "admin") {
  const policy = await repos.backupPolicy.findById(id);
  if (!policy) throw new NotFoundError("Backup policy", id);
  if (policy.projectId) await authorize(ctx, "project", policy.projectId, action);
  else if (policy.mailServerId) await authorize(ctx, "server", policy.mailServerId, action);
  return policy;
}
async function run(ctx: ExecutionContext, id: string) {
  const row = await repos.backupRun.findById(id);
  assertResourceInOrg(row, "Backup run", ctx.organizationId, id);
  return row;
}
async function restore(ctx: ExecutionContext, id: string) {
  const row = await repos.backupRestore.findById(id);
  assertResourceInOrg(row, "Restore", ctx.organizationId, id);
  return row;
}
async function targetAccess(ctx: ExecutionContext, source: { projectId: string | null; mailServerId: string | null }, forkMailServerId?: string | null) {
  if (source.projectId) await authorize(ctx, "project", source.projectId, "admin");
  if (source.mailServerId) await authorize(ctx, "server", forkMailServerId ?? source.mailServerId, "admin");
}
const terminal = new Set(["succeeded", "failed", "cancelled", "server_error"]);

/** Existing CRUD and FSM services own persistence and execution in both interfaces. */
export const backupDependencies: BackupDependencies = {
  projects: {
    listPolicies: (ctx, id) => result(() => service.listPoliciesByProject(ctx, id), 404),
    async createPolicy(ctx, projectId, input) {
      await authorize(ctx, "backup_destination", input.destinationId, "write");
      if (input.serviceId) {
        const child = await repos.service.findById(input.serviceId);
        if (!child || child.projectId !== projectId) throw new NotFoundError("Service", input.serviceId);
      }
      const policy = await result(() => service.createPolicy(ctx, { ...input, projectId, serviceId: input.serviceId ?? null }));
      record(ctx, "backup_policy", policy.id, "create", { projectId, destinationId: input.destinationId });
      return policy;
    },
    async listRuns(ctx, id, input = {}) {
      return (await result(() => service.listRunsForProject(ctx, id, { ...input, limit: input.limit ?? 50 }), 404)).map(presentBackupRun);
    },
  },
  policies: {
    async updatePolicy(ctx, id, input) {
      await policyAccess(ctx, id, "write");
      if (input.destinationId) await authorize(ctx, "backup_destination", input.destinationId, "write");
      const policy = await result(() => service.updatePolicy(ctx, id, input));
      record(ctx, "backup_policy", id, "update", { fields: Object.keys(input) });
      return policy;
    },
    async removePolicy(ctx, id) {
      await policyAccess(ctx, id, "admin");
      await result(() => service.deletePolicy(ctx, id));
      record(ctx, "backup_policy", id, "remove");
      return { ok: true };
    },
    async run(ctx, id, input = {}) {
      await policyAccess(ctx, id, "write");
      const output = await result(() => triggerManualBackup(ctx, id, input.serviceId));
      record(ctx, "backup_policy", id, "run", { runId: output.runId });
      return output;
    },
  },
  runs: {
    getRun: async (ctx, id) => presentBackupRun(await result(() => service.getRun(ctx, id), 404)),
    async protectRun(ctx, id, input = {}) {
      return withBackupRunLock(id, async () => {
        const source = await run(ctx, id);
        if (source.deletedAt) throw new ValidationError("This backup has already been purged");
        const until = input.protected === false ? null : new Date(input.until ?? "2099-12-31T23:59:59.000Z");
        if (until && Number.isNaN(until.getTime())) throw new ValidationError("Invalid 'until' timestamp");
        await repos.backupRun.setRetentionLock(id, until);
        const retentionLockedUntil = until?.toISOString() ?? null;
        record(ctx, "backup_run", id, "protect", { retentionLockedUntil });
        return { ok: true, retentionLockedUntil };
      });
    },
    async prepareRestore(ctx, id, input = {}) {
      const source = await run(ctx, id);
      const mode = input.mode ?? "in_place";
      let forkMailServerId: string | null = null;
      if (mode === "to_fork") {
        if (source.sourceKind !== "mail_server") throw new ValidationError("Only mail-server backups can be migrated to another server");
        forkMailServerId = input.forkMailServerId ?? null;
        if (!forkMailServerId) throw new ValidationError("A target mail server is required to migrate");
        if (forkMailServerId === source.mailServerId) throw new ValidationError("Pick a different server than the source");
        await authorize(ctx, "server", forkMailServerId, "admin");
        const target = await repos.mailServer.get(forkMailServerId);
        if (!target?.installedAt) throw new ValidationError("Target must be a mail server that's already set up (install it first)");
      }
      await targetAccess(ctx, source, forkMailServerId);
      const output = await result(() => restoreOrchestrator.beginPrepare({
        runId: id, trigger: { source: "manual", userId: ctx.userId, clientIp: ctx.clientIp ?? undefined },
        confirmationToken: crypto.randomBytes(8).toString("hex"), mode, forkMailServerId,
      }));
      record(ctx, "backup_run", id, "prepareRestore", { restoreId: output.restoreId, mode, forkMailServerId });
      return output;
    },
  },
  restores: {
    getRestore: async (ctx, id) => presentBackupRestore(await restore(ctx, id)),
    async applyRestore(ctx, id, input) {
      const row = await restore(ctx, id);
      const source = await run(ctx, row.runId);
      await targetAccess(ctx, source, row.forkMailServerId);
      await result(() => restoreOrchestrator.apply(ctx, id, input.confirmationToken));
      record(ctx, "backup_restore", id, "apply");
      return { ok: true };
    },
    async cancelRestore(ctx, id) {
      const output = await result(() => restoreOrchestrator.cancel(ctx, id));
      record(ctx, "backup_restore", id, "cancel", output);
      return { ok: true, ...output };
    },
  },
  events(ctx, kind, id, signal) {
    if (kind === "run") return runEvents<BackupRunEvent, Awaited<ReturnType<typeof run>>>({
      bus: backupRunBus, id, signal, load: () => run(ctx, id),
      reconcile: { everyMs: 5_000 },
      snapshot: row => ({ type: "snapshot", run: row }),
      complete: row => terminal.has(row.status) ? { type: "complete", status: row.status as "succeeded" | "failed" | "cancelled" | "server_error", errorMessage: row.errorMessage } : null,
      present: event => event.type === "snapshot" ? { ...event, run: presentBackupRun(event.run) }
        : "artifacts" in event ? { ...event, artifacts: presentBackupArtifacts(event.artifacts) } : event,
    });
    return runEvents<RestoreRunEvent, Awaited<ReturnType<typeof restore>>>({
      bus: restoreRunBus, id, signal, load: () => restore(ctx, id),
      reconcile: { everyMs: 5_000, isTransient: event => event.type === "warning" },
      snapshot: row => ({ type: "snapshot", restore: row }),
      complete: row => terminal.has(row.status) ? { type: "complete", status: row.status as "succeeded" | "failed" | "cancelled" | "server_error", errorMessage: row.errorMessage } : null,
      present: event => event.type === "snapshot" ? { ...event, restore: presentBackupRestore(event.restore) } : event,
    });
  },
};
