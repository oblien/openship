import type { ServerInfo } from "@/lib/api/system";

/** Legacy API rows predate this field and are deployment-capable by default. */
export function isManagedServer(server: Pick<ServerInfo, "managementMode">): boolean {
  return (server.managementMode ?? "managed") === "managed";
}

export function deployableServers<T extends Pick<ServerInfo, "managementMode">>(servers: T[]): T[] {
  return servers.filter(isManagedServer);
}
