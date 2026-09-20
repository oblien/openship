import { DnsOperationSchemas, type DnsOperations } from "@repo/contracts";
import type { HttpClient } from "./http";
import { createRemoteScopedOperations } from "./resource-client";

export function createRemoteDnsOperations(http: HttpClient): DnsOperations {
  return createRemoteScopedOperations(http, DnsOperationSchemas, {
    listProviders: { method: "GET", path: () => "/dns/providers", envelope: "data" },
    listCredentials: { method: "GET", path: () => "/dns/credentials", envelope: "data" },
    getCredential: { method: "GET", path: id => `/dns/credentials/${encodeURIComponent(id as string)}`, inputLocation: "path", envelope: "data" },
    addCredential: { method: "POST", path: () => "/dns/credentials", envelope: "data" },
    removeCredential: { method: "DELETE", path: id => `/dns/credentials/${encodeURIComponent(id as string)}`, inputLocation: "path" },
    verifyZone: { method: "POST", path: () => "/dns/verify-zone" },
  });
}
