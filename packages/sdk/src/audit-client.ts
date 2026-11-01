import { AuditOperationSchemas, type AuditOperations } from "@repo/contracts";
import type { HttpClient } from "./http";
import { createRemoteScopedOperations } from "./resource-client";
export function createRemoteAuditOperations(http: HttpClient): AuditOperations {
  return createRemoteScopedOperations(http, AuditOperationSchemas, {
    list: { method: "GET", path: () => "/audit", response: value => {
      const { data, ...rest } = (value ?? {}) as Record<string, unknown>;
      return { ...rest, items: data };
    } },
    facets: { method: "GET", path: () => "/audit/facets" },
    getSettings: { method: "GET", path: () => "/audit/settings" },
    updateSettings: { method: "PATCH", path: () => "/audit/settings" },
  });
}
