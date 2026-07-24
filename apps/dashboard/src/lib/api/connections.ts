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
  targetProjectId: string;
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

export const connectionsApi = {
  /** Connections wired INTO a project (`projectId` = the consumer). */
  list: (projectId: string) =>
    api.get<{ data: ProjectConnection[] }>(endpoints.projects.connections(projectId)),

  /** Wire a source database app into `projectId` (injects a secret env var). */
  create: (projectId: string, body: CreateConnectionBody) =>
    api.post<{ data: { connection: ProjectConnection; requiresRedeploy: true } }>(
      endpoints.projects.connections(projectId),
      body,
    ),

  /** Remove a connection + its injected env var. */
  remove: (projectId: string, linkId: string) =>
    api.delete<{ data: { requiresRedeploy: true } }>(
      endpoints.projects.connection(projectId, linkId),
    ),
};
