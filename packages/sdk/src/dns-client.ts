import { DnsOperationSchemas, type DnsOperations } from "@repo/contracts";
import type { HttpClient } from "./http";
import { createRemoteScopedOperations } from "./resource-client";

export function createRemoteDnsOperations(http: HttpClient): DnsOperations {
  return createRemoteScopedOperations(http, DnsOperationSchemas, {
    listIngressConnections: {
      redactInvalidResponse: true,
      method: "GET",
      path: () => "/dns/ingress",
      inputLocation: "query",
    },
    discoverIngress: {
      redactInvalidResponse: true,
      method: "POST",
      path: () => "/dns/ingress/discover",
    },
    connectIngress: { redactInvalidResponse: true, method: "POST", path: () => "/dns/ingress" },
    updateIngress: {
      redactInvalidResponse: true,
      method: "PUT",
      path: (input) => `/dns/ingress/${encodeURIComponent((input as { id: string }).id)}`,
      body: (input) => {
        const { id, ...body } = input as {
          id: string;
          defaultForDomains: boolean;
          defaultAccessPolicyId: string | null;
        };
        return body;
      },
    },
    retryIngress: {
      redactInvalidResponse: true,
      method: "POST",
      path: (id) => `/dns/ingress/${encodeURIComponent(id as string)}/retry`,
      inputLocation: "path",
    },
    removeIngress: {
      redactInvalidResponse: true,
      method: "DELETE",
      path: (id) => `/dns/ingress/${encodeURIComponent(id as string)}`,
      inputLocation: "path",
    },
    getDomainIngress: {
      redactInvalidResponse: true,
      method: "GET",
      path: (input) =>
        `/dns/ingress/domains/${encodeURIComponent((input as { domainId: string }).domainId)}`,
      inputLocation: "path",
    },
    setDomainIngress: {
      redactInvalidResponse: true,
      method: "PUT",
      path: (input) =>
        `/dns/ingress/domains/${encodeURIComponent((input as { domainId: string }).domainId)}`,
      body: (input) => {
        const { domainId, ...body } = input as {
          domainId: string;
          connectionId: string | null;
          accessPolicyId?: string | null;
        };
        return body;
      },
    },
    listProviders: { method: "GET", path: () => "/dns/providers", envelope: "data" },
    listCredentials: { method: "GET", path: () => "/dns/credentials", envelope: "data" },
    getCredential: {
      method: "GET",
      path: (id) => `/dns/credentials/${encodeURIComponent(id as string)}`,
      inputLocation: "path",
      envelope: "data",
    },
    addCredential: { method: "POST", path: () => "/dns/credentials", envelope: "data" },
    removeCredential: {
      method: "DELETE",
      path: (id) => `/dns/credentials/${encodeURIComponent(id as string)}`,
      inputLocation: "path",
    },
    verifyZone: { method: "POST", path: () => "/dns/verify-zone" },
  });
}
