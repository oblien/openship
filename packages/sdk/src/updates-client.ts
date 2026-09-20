import { UpdateCollectionSchemas, UpdateProjectSchemas, type UpdateOperations } from "@repo/contracts";
import type { HttpClient } from "./http";
import { createRemoteResourceOperations, createRemoteScopedOperations } from "./resource-client";
export function createRemoteUpdateOperations(http: HttpClient): UpdateOperations {
  return Object.freeze({
    ...createRemoteScopedOperations(http, UpdateCollectionSchemas, {
      list: { method: "GET", path: input => `/updates?behind=${(input as { behindOnly?: boolean })?.behindOnly ? "1" : "0"}`, inputLocation: "path", envelope: "data" },
      scan: { method: "POST", path: () => "/updates/scan", envelope: "data" },
    }),
    ...createRemoteResourceOperations(http, UpdateProjectSchemas, { apply: { method: "POST", path: id => `/updates/${encodeURIComponent(id)}/apply`, envelope: "data" } }),
  });
}
