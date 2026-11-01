import { AppCollectionSchemas, AppResourceSchemas, isRecord, type AppOperations } from "@repo/contracts";
import type { HttpClient } from "./http";
import { createRemoteResourceOperations, createRemoteScopedOperations } from "./resource-client";

export function createRemoteAppOperations(http: HttpClient): AppOperations {
  return Object.freeze({
    ...createRemoteScopedOperations(http, AppCollectionSchemas, {
      listCatalog: { method: "GET", path: () => "/apps/catalog", envelope: "data" },
      listCustom: { method: "GET", path: () => "/apps/custom", envelope: "data" },
      saveCustom: { method: "POST", path: () => "/apps/custom", envelope: "data" },
      install: { method: "POST", path: () => "/apps", envelope: "data" },
    }),
    ...createRemoteResourceOperations(http, AppResourceSchemas, {
      getCatalogEntry: { method: "GET", path: id => `/apps/catalog/${encodeURIComponent(id)}`,
        response: body => isRecord(body) ? { template: body.data, draft: body.draft } : body },
      hostFit: { method: "GET", path: id => `/apps/catalog/${encodeURIComponent(id)}/host-fit`, envelope: "data" },
      removeCustom: { method: "DELETE", path: id => `/apps/custom/${encodeURIComponent(id)}`, envelope: "data" },
    }),
  });
}
