import type { ServerDetail } from "@repo/contracts";

/** Both IDs identify the same host; the local execution link is never a second
 * destination. Cloud-owned project and checkout responses keep canonical IDs. */
export const matchesServer = (server: ServerDetail, id: string | null | undefined) =>
  !!id && (server.id === id || server.cloudReference?.serverId === id);

export const matchesWorkspace = (server: ServerDetail, id: string | null | undefined) =>
  !!id && (server.managed?.id === id || server.cloudReference?.workspaceId === id);
