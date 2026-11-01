import { JobCollectionSchemas, JobResourceSchemas, ResourceIdSchema, parseInput, type JobOperations } from "@repo/contracts";
import type { HttpClient } from "./http";
import { createRemoteResourceOperations, createRemoteScopedOperations } from "./resource-client";

export function createRemoteJobOperations(http: HttpClient): JobOperations {
  const job = (id: string) => `/jobs/${encodeURIComponent(id)}`;
  const run = (id: string) => `/jobs/runs/${encodeURIComponent(id)}`;
  return Object.freeze({
    ...createRemoteScopedOperations(http, JobCollectionSchemas, {
      list: { method: "GET", path: () => "/jobs", envelope: "data" },
      create: { method: "POST", path: () => "/jobs", envelope: "data" },
      triggerEvents: { method: "GET", path: () => "/jobs/trigger-events", envelope: "data" },
      backupSchedules: { method: "GET", path: () => "/jobs/backup-schedules", envelope: "data" },
    }),
    ...createRemoteResourceOperations(http, JobResourceSchemas, {
      get: { method: "GET", path: job, envelope: "data" },
      update: { method: "PATCH", path: job, envelope: "data" },
      remove: { method: "DELETE", path: job },
      run: { method: "POST", path: id => job(id) + "/run", envelope: "data" },
      listRuns: { method: "GET", path: id => job(id) + "/runs", envelope: "data" },
      getRun: { method: "GET", path: run, envelope: "data" },
    }),
    async *streamRun(id, options = {}) { yield* http.events(run(parseInput(ResourceIdSchema, id)) + "/stream", { signal: options.signal }); },
  } satisfies JobOperations);
}
