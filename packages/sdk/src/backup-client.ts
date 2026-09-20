import { BackupProjectSchemas, BackupPolicySchemas, BackupRunSchemas, BackupRestoreSchemas, ResourceIdSchema, parseInput, type BackupOperations } from "@repo/contracts";
import type { HttpClient } from "./http";
import { createRemoteResourceOperations } from "./resource-client";

export function createRemoteBackupOperations(http: HttpClient): BackupOperations {
  const project = (id: string) => `/projects/${encodeURIComponent(id)}`;
  const policy = (id: string) => `/backup-policies/${encodeURIComponent(id)}`;
  const run = (id: string) => `/backup-runs/${encodeURIComponent(id)}`;
  const restore = (id: string) => `/backup-restores/${encodeURIComponent(id)}`;
  return Object.freeze({
    ...createRemoteResourceOperations(http, BackupProjectSchemas, {
      listPolicies: { method: "GET", path: id => project(id) + "/backup-policies", envelope: "data" },
      createPolicy: { method: "POST", path: id => project(id) + "/backup-policies", envelope: "data" },
      listRuns: { method: "GET", path: id => project(id) + "/backup-runs", envelope: "data" },
    }),
    ...createRemoteResourceOperations(http, BackupPolicySchemas, {
      updatePolicy: { method: "PATCH", path: policy, envelope: "data" },
      removePolicy: { method: "DELETE", path: policy, envelope: "data" },
      run: { method: "POST", path: id => policy(id) + "/run", envelope: "data" },
    }),
    ...createRemoteResourceOperations(http, BackupRunSchemas, {
      getRun: { method: "GET", path: run, envelope: "data" },
      protectRun: { method: "POST", path: id => run(id) + "/protect", envelope: "data" },
      prepareRestore: { method: "POST", path: id => run(id) + "/restore/prepare", envelope: "data" },
    }),
    ...createRemoteResourceOperations(http, BackupRestoreSchemas, {
      getRestore: { method: "GET", path: restore, envelope: "data" },
      applyRestore: { method: "POST", path: id => restore(id) + "/apply", envelope: "data" },
      cancelRestore: { method: "POST", path: id => restore(id) + "/cancel", envelope: "data" },
    }),
    async *streamRun(id, options = {}) { yield* http.events(run(parseInput(ResourceIdSchema, id)) + "/stream", { signal: options.signal }); },
    async *streamRestore(id, options = {}) { yield* http.events(restore(parseInput(ResourceIdSchema, id)) + "/stream", { signal: options.signal }); },
  } satisfies BackupOperations);
}
