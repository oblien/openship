import { BackupDestinationCollectionSchemas, BackupDestinationResourceSchemas, type BackupDestinationOperations } from "@repo/contracts";
import type { HttpClient } from "./http";
import { createRemoteResourceOperations, createRemoteScopedOperations } from "./resource-client";

export function createRemoteBackupDestinationOperations(http: HttpClient): BackupDestinationOperations {
  const path = (id: string) => `/backup-destinations/${encodeURIComponent(id)}`;
  return Object.freeze({
    ...createRemoteScopedOperations(http, BackupDestinationCollectionSchemas, {
      list: { method: "GET", path: () => "/backup-destinations", envelope: "data" },
      history: { method: "GET", path: () => "/backup-destinations/history", envelope: "data" },
      create: { method: "POST", path: () => "/backup-destinations", envelope: "data" },
      preflightDraft: { method: "POST", path: () => "/backup-destinations/preflight", envelope: "data" },
    }),
    ...createRemoteResourceOperations(http, BackupDestinationResourceSchemas, {
      get: { method: "GET", path, envelope: "data" },
      usage: { method: "GET", path: id => path(id) + "/usage", envelope: "data" },
      runs: { method: "GET", path: id => path(id) + "/runs", envelope: "data" },
      update: { method: "PATCH", path, envelope: "data" },
      remove: { method: "DELETE", path, envelope: "data" },
      preflight: { method: "POST", path: id => path(id) + "/preflight", envelope: "data" },
    }),
  });
}
