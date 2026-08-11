/**
 * Job routes — mounted at /api/jobs in app.ts.
 *
 * Self-hosted only (localOnly): the generic scheduled-jobs control plane. Jobs
 * have their own org-singleton `job:*` permission tags (read = list; write =
 * edit schedule / toggle / run now).
 */

import { Hono } from "hono";
import { localOnly } from "../../middleware";
import { secureRouter } from "../../lib/secure-router";
import * as ctrl from "./job.controller";
import { UpdateJobBody, CreateJobBody } from "./job.schema";

const r = secureRouter(new Hono(), {
  module: "jobs",
  basePath: "/api/jobs",
});

r.use("*", localOnly);

r.get("/", { tag: "job:read", mcp: { description: "List system + custom jobs with cron, next run, and recent run history." } }, ctrl.list);
r.post(
  "/",
  { tag: "job:write", body: CreateJobBody, mcp: { description: "Create a custom job that runs a command on one or more servers (cron / one-time / manual), with retry, env, secrets, dependencies, triggers, and notifications." } },
  ctrl.create,
);
// Literal GET routes are registered before `/:key` so they don't get captured
// as a job key. `/runs/:id` can't collide with `/:key/runs` (segment order).
r.get("/trigger-events", { tag: "job:read", mcp: { description: "List the events a job can be triggered on." } }, ctrl.triggerEvents);
r.get("/backup-schedules", { tag: "job:read", mcp: { description: "List scheduled backup policies (read-only), surfaced alongside jobs." } }, ctrl.backupSchedules);
r.get("/runs/:runId", { tag: "job:read", mcp: { description: "Get one job run incl. captured output." } }, ctrl.getRun);
r.get("/runs/:runId/stream", { tag: "job:read", mcp: { description: "Stream a job run's live output (SSE)." } }, ctrl.streamRun);
r.get("/:key/runs", { tag: "job:read", mcp: { description: "List a job's run history." } }, ctrl.listRuns);
r.get("/:key", { tag: "job:read", mcp: { description: "Get one job's config, schedule, and recent runs." } }, ctrl.get);
r.patch(
  "/:key",
  { tag: "job:write", body: UpdateJobBody, mcp: { description: "Update a job's schedule/enabled (any job) or full config (custom jobs)." } },
  ctrl.update,
);
r.delete("/:key", { tag: "job:write", mcp: { description: "Delete a custom job (system jobs can't be deleted)." } }, ctrl.remove);
r.post("/:key/run", { tag: "job:write", mcp: { description: "Run a job immediately (custom jobs stream live; returns a runId)." } }, ctrl.run);

export const jobRoutes = r.hono;
