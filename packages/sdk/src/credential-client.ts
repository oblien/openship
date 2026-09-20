import { CredentialCollectionSchemas, CredentialResourceSchemas, type CredentialOperations } from "@repo/contracts";
import type { HttpClient } from "./http";
import { createRemoteResourceOperations, createRemoteScopedOperations } from "./resource-client";

export function createRemoteCredentialOperations(http: HttpClient): CredentialOperations {
  const path = (id: string) => `/credentials/${encodeURIComponent(id)}`;
  return Object.freeze({
    ...createRemoteScopedOperations(http, CredentialCollectionSchemas, {
      listProviders: { method: "GET", path: () => "/credentials/providers", envelope: "data" },
      list: { method: "GET", path: () => "/credentials", envelope: "data" },
      create: { method: "POST", path: () => "/credentials", envelope: "data" },
    }),
    ...createRemoteResourceOperations(http, CredentialResourceSchemas, {
      get: { method: "GET", path, envelope: "data" },
      update: { method: "PATCH", path, envelope: "data" },
      remove: { method: "DELETE", path },
      verify: { method: "POST", path: id => path(id) + "/verify", envelope: "data" },
    }),
  });
}
