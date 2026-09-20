import type { JobDependencies } from "../../../jobs";
import type { ExecutionContext } from "../../../context";
import { repos } from "@repo/db";
import { audit, operationAuditContext } from "../../lib/audit-emitter";
import { runEvents } from "../../lib/run-events";
import { assertSelfHosted } from "../system/server-access";
import { assertJobWritable, assertJobRunnable, assertJobServersWritable, assertJobReferences, canReadJob, canReadRun, requireReadableJob, requireReadableRun } from "./job-access";
import { jobRunBus, type JobRunEvent } from "./job-run.sse";
import { JOB_TRIGGER_EVENTS } from "./job-events";
import { resolveServerIds } from "./job.types";
import * as service from "./job.service";

function record(ctx: ExecutionContext, key: string, operation: string, after: object = {}) {
  // Commands, environment values, secrets and notification credentials never enter audit data.
  audit.recordAsync(operationAuditContext(ctx), { eventType: "job:write", resourceType: "job", resourceId: key, after: { operation, ...after } });
}

async function present(ctx: ExecutionContext, view: service.JobView) {
  const recentRuns = [];
  for (const run of view.recentRuns) if (await canReadRun(ctx, run)) recentRuns.push(run);
  return { ...view, recentRuns, lastRun: recentRuns[0] ?? null };
}

export const jobDependencies: JobDependencies = {
  collection: {
    async list(ctx) {
      assertSelfHosted();
      const visible = [];
      for (const row of await service.listJobs()) if (await canReadJob(ctx, row)) visible.push(await present(ctx, row));
      return visible;
    },
    async create(ctx, input) {
      assertSelfHosted();
      await assertJobServersWritable(ctx, resolveServerIds(input));
      await assertJobReferences(ctx, input);
      const job = await service.createCustomJob({ ...input, createdBy: ctx.userId });
      record(ctx, job.key, "create");
      return present(ctx, await service.getJob(job.key));
    },
    async triggerEvents() { assertSelfHosted(); return JOB_TRIGGER_EVENTS; },
    async backupSchedules(ctx) { assertSelfHosted(); return service.listBackupSchedules(ctx.organizationId); },
  },
  resources: {
    async get(ctx, key) { await requireReadableJob(ctx, key); return present(ctx, await service.getJob(key)); },
    async update(ctx, key, input) {
      await assertJobWritable(ctx, key, input, { allowMissingRegisteredSystem: true });
      await assertJobReferences(ctx, input);
      await service.updateJob(key, input);
      record(ctx, key, "update", { fields: Object.keys(input) });
      return present(ctx, await service.getJob(key));
    },
    async remove(ctx, key) {
      await assertJobWritable(ctx, key);
      await service.deleteCustomJob(key);
      record(ctx, key, "remove");
      return { success: true };
    },
    async run(ctx, key) {
      await assertJobRunnable(ctx, key);
      const result = await service.runJobNow(key);
      record(ctx, key, "run", { runId: result.runId });
      return result;
    },
    async listRuns(ctx, key, input = {}) {
      await requireReadableJob(ctx, key);
      const visible = [];
      for (const run of await repos.jobRun.listRecent({ jobId: key, limit: input.limit ?? 50 })) {
        // A job may have been moved to new targets since an older run was recorded.
        if (await canReadRun(ctx, run)) visible.push(run);
      }
      return visible;
    },
    getRun: requireReadableRun,
  },
  async openRunStream(ctx, id, signal) {
    await requireReadableRun(ctx, id);
    return runEvents<JobRunEvent, Awaited<ReturnType<typeof requireReadableRun>>>({
      bus: jobRunBus, id, signal, load: () => requireReadableRun(ctx, id),
      snapshot: run => ({ type: "snapshot", run }),
      complete: run => run.status === "success" || run.status === "failed" ? { type: "complete", status: run.status, error: run.error } : null,
    });
  },
};
