import {
  UpdateCollectionSchemas,
  UpdateProjectSchemas,
  type UpdateOperations,
} from "@repo/contracts";
import type { HttpClient } from "./http";
import { createRemoteResourceOperations, createRemoteScopedOperations } from "./resource-client";
export function createRemoteUpdateOperations(http: HttpClient): UpdateOperations {
  return Object.freeze({
    ...createRemoteScopedOperations(http, UpdateCollectionSchemas, {
      advisories: { method: "GET", path: () => "/updates/advisories", envelope: "data" },
      list: {
        method: "GET",
        path: (input) =>
          `/updates?behind=${(input as { behindOnly?: boolean })?.behindOnly ? "1" : "0"}`,
        inputLocation: "path",
        envelope: "data",
      },
      scan: { method: "POST", path: () => "/updates/scan", envelope: "data" },
    }),
    ...createRemoteResourceOperations(http, UpdateProjectSchemas, {
      checkSecurity: {
        method: "POST",
        path: (id) => `/updates/${encodeURIComponent(id)}/security/check`,
        envelope: "data",
      },
      security: {
        method: "GET",
        path: (id) => `/updates/${encodeURIComponent(id)}/security`,
        envelope: "data",
      },
      securityPolicy: {
        method: "PUT",
        path: (id) => `/updates/${encodeURIComponent(id)}/security/policy`,
        envelope: "data",
      },
      applySecurity: {
        method: "POST",
        path: (id) => `/updates/${encodeURIComponent(id)}/security/apply`,
        envelope: "data",
      },
      apply: {
        method: "POST",
        path: (id) => `/updates/${encodeURIComponent(id)}/apply`,
        envelope: "data",
      },
      updateRuntime: {
        method: "POST",
        path: (id) => `/updates/${encodeURIComponent(id)}/runtime`,
        envelope: "data",
      },
      checkRuntime: {
        method: "POST",
        path: (id) => `/updates/${encodeURIComponent(id)}/runtime/check`,
        envelope: "data",
      },
    }),
  });
}
