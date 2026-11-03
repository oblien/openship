/** Canonical MCP endpoint and its existing dashboard-proxy alias. */
export const MCP_RESOURCE_PATH = "/api/mcp";
export const MCP_PROXY_RESOURCE_PATH = "/api/proxy/api/mcp";
export const MCP_RESOURCE_PATHS: readonly string[] = [MCP_RESOURCE_PATH, MCP_PROXY_RESOURCE_PATH];

/** The bare origin is retained for clients using the legacy discovery document. */
export function allowedMcpResources(origin: string): string[] {
  const base = origin.replace(/\/+$/, "");
  return [...MCP_RESOURCE_PATHS.map((path) => `${base}${path}`), base];
}
