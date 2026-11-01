/**
 * Job routes — mounted at /api/jobs in app.ts.
 *
 * Custom commands run on authorized connected or managed servers. Cloud never
 * exposes control-plane maintenance jobs. `job:*` permissions are combined
 * with administration of every stored execution target.
 */

import { Hono } from "hono";
import { UpdateJobBody, CreateJobBody, JobResourceSchemas } from "@repo/contracts";
import { secureRouter } from "../../lib/secure-router";
import * as ctrl from "./job.controller";

const r = secureRouter(new Hono(), {
  module: "jobs",
  basePath: "/api/jobs",
});

r.get("/", { tag: "job:read", mcp: { description: "List your authorized command jobs with schedule, next run, and recent history. Self-hosted installations also show their built-in maintenance jobs; Cloud keeps platform maintenance private." } }, ctrl.list);
r.post(
  "/",
  { tag: "job:write", auditHandledByOperation: true, body: CreateJobBody, mcp: { description: "Create a command job on one or more servers you administer, using cron, one-time or manual scheduling, retries, env, secrets, dependencies, triggers and notifications. Cloud jobs reuse a subscribed managed server selected by serverId; they share its resources and metered allowance." } },
  ctrl.create,
);
// Literal GET routes are registered before `/:key` so they don't get captured
// as a job key. `/runs/:id` can't collide with `/:key/runs` (segment order).
r.get("/trigger-events", { tag: "job:read", mcp: { description: "List the events a job can be triggered on." } }, ctrl.triggerEvents);
r.get("/backup-schedules", { tag: "job:read", mcp: { description: "List scheduled backup policies (read-only), surfaced alongside jobs." } }, ctrl.backupSchedules);
r.get("/runs/:runId", { tag: "job:read", mcp: { description: "Get one job run incl. captured output." } }, ctrl.getRun);
r.get("/runs/:runId/stream", { tag: "job:read", mcpExcluded: "Live SSE output can remain open. Poll GET /api/jobs/runs/:runId for captured output and completion over MCP." }, ctrl.streamRun);
r.get("/:key/runs", { tag: "job:read", mcp: { description: "List a job's run history." }, query: JobResourceSchemas.listRuns.input }, ctrl.listRuns);
r.get("/:key", { tag: "job:read", mcp: { description: "Get one job's config, schedule, and recent runs." } }, ctrl.get);
r.patch(
  "/:key",
  { tag: "job:write", auditHandledByOperation: true, body: UpdateJobBody, mcp: { description: "Update a job's schedule/enabled (any job) or full config (custom jobs)." } },
  ctrl.update,
);
r.delete("/:key", { tag: "job:write", auditHandledByOperation: true, mcp: { description: "Delete a custom job (system jobs can't be deleted)." } }, ctrl.remove);
r.post("/:key/run", { tag: "job:write", auditHandledByOperation: true, mcp: { description: "Run a job immediately (custom jobs stream live; returns a runId)." } }, ctrl.run);

export const jobRoutes = r.hono;
