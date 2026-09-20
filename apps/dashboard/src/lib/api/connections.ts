import { api } from "./client";
import { endpoints } from "./endpoints";

/** How the consumer reaches the linked database. */
export type ConnectionMode = "internal" | "public";

/** A database/app connection wired into a consumer project. */
export interface ProjectConnection {
  id: string;
  sourceProjectId: string;
  sourceName: string;
  sourceAppTemplateId: string | null;
  sourceServiceId?: string | null;
  sourceServiceName?: string | null;
  targetProjectId: string;
  outputId: string;
  envKey: string;
  mode: ConnectionMode;
}

/** A project that CONSUMES this app — the reverse of {@link ProjectConnection}. */
export interface ConnectionConsumer {
  id: string;
  sourceServiceId?: string | null;
  targetProjectId: string;
  targetName: string;
  targetSlug: string | null;
  outputId: string;
  envKey: string;
  mode: ConnectionMode;
}

export interface CreateConnectionBody {
  sourceProjectId: string;
  outputId: string;
  envKey: string;
  mode: ConnectionMode;
}

export const CONNECTIONS_CHANGED = "openship:connections-changed";
async function notifyConnections<T>(request: Promise<T>): Promise<T> {
  const result = await request;
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CONNECTIONS_CHANGED));
  return result;
}

export const connectionsApi = {
  candidates: (projectId: string) => api.get<{ data: Array<{ id: string; name: string; description: string; appTemplateId: string | null }> }>(
    `${endpoints.projects.connections(projectId)}/candidates`,
  ),
  /** Connections wired INTO a project (`projectId` = the consumer). */
  list: (projectId: string) =>
    api.get<{ data: ProjectConnection[] }>(endpoints.projects.connections(projectId)),

  /** Projects consuming THIS app (`projectId` = the shared source). Many for a
   *  shared database — one Postgres can back any number of apps. */
  consumers: (projectId: string) =>
    api.get<{ data: ConnectionConsumer[] }>(
      `${endpoints.projects.connections(projectId)}/consumers`,
    ),

  /** Wire a source database app into `projectId` (injects a secret env var). */
  create: (projectId: string, body: CreateConnectionBody) =>
    notifyConnections(api.post<{ data: { connection: ProjectConnection; requiresRedeploy: true } }>(
      endpoints.projects.connections(projectId),
      body,
    )),

  /** Wire several outputs from one source app into `projectId` atomically. */
  bundle: (
    projectId: string,
    body: { sourceProjectId: string; items: { outputId: string; envKey: string }[]; mode?: ConnectionMode },
  ) =>
    notifyConnections(api.post<{ data: { connections: ProjectConnection[]; requiresRedeploy: true } }>(
      `${endpoints.projects.connections(projectId)}/bundle`,
      body,
    )),

  /** Remove a connection + its injected env var. */
  remove: (projectId: string, linkId: string) =>
    notifyConnections(api.delete<{ data: { requiresRedeploy: true } }>(
      endpoints.projects.connection(projectId, linkId),
    )),
};
