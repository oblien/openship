import { TokenCollectionSchemas, TokenResourceSchemas, type TokenOperations } from "@repo/contracts";
import type { HttpClient } from "./http";
import { createRemoteScopedOperations, createRemoteResourceOperations } from "./resource-client";
export function createRemoteTokenOperations(http: HttpClient): TokenOperations {
  return Object.freeze({
    ...createRemoteScopedOperations(http, TokenCollectionSchemas, {
      list: { method: "GET", path: () => "/tokens", envelope: "data" },
      create: { method: "POST", path: () => "/tokens", envelope: "data" },
      authorizeMcpClient: { method: "POST", path: () => "/tokens/mcp-authorize", envelope: "data" },
      listMcpClients: { method: "GET", path: () => "/tokens/mcp-clients", envelope: "data" },
    }),
    ...createRemoteResourceOperations(http, TokenResourceSchemas, {
      revoke: { method: "DELETE", path: id => `/tokens/${encodeURIComponent(id)}`, envelope: "data" },
      getMcpClient: { method: "GET", path: id => `/tokens/mcp-clients/${encodeURIComponent(id)}`, envelope: "data" },
      disconnectMcpClient: { method: "DELETE", path: id => `/tokens/mcp-clients/${encodeURIComponent(id)}`, envelope: "data" },
    }),
  });
}
