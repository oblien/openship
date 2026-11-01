import type { ClusterDatabase, ProjectDatabaseSchemas } from "@repo/contracts";
import type { Static } from "@sinclair/typebox";
import { api } from "./client";
const path = (id: string) => `projects/${encodeURIComponent(id)}/cluster/databases`;
export const clusterDatabasesApi = {
  list: (id: string) =>
    api.get<{ data: ClusterDatabase[] }>(path(id)).then((response) => response.data),
  imports: (id: string) =>
    api
      .get<{
        data: Static<typeof ProjectDatabaseSchemas.listClusterDatabaseImports.output>;
      }>(path(id) + "/imports")
      .then((response) => response.data),
  inspect: (id: string, databaseId: string) =>
    api
      .post<{
        data: ClusterDatabase;
      }>(path(id) + "/inspect", { databaseId, observe: true }, { timeout: 45_000 })
      .then((response) => response.data),
  create: (id: string, input: Static<typeof ProjectDatabaseSchemas.createClusterDatabase.input>) =>
    api.post<{ data: ClusterDatabase }>(path(id), input).then((response) => response.data),
  update: (id: string, input: Static<typeof ProjectDatabaseSchemas.updateClusterDatabase.input>) =>
    api.patch<{ data: ClusterDatabase }>(path(id), input).then((response) => response.data),
  retry: (id: string, database: ClusterDatabase) =>
    api
      .post<{
        data: ClusterDatabase;
      }>(path(id) + "/retry", { databaseId: database.id, expectedSequence: database.sequence })
      .then((response) => response.data),
  backup: (id: string, database: ClusterDatabase) =>
    api
      .post<{
        data: ClusterDatabase;
      }>(path(id) + "/backup", { databaseId: database.id, expectedSequence: database.sequence })
      .then((response) => response.data),
  remove: (id: string, database: ClusterDatabase, name: string, deleteData: boolean) =>
    api
      .delete<{
        data: ClusterDatabase;
      }>(path(id), {
        body: { databaseId: database.id, expectedSequence: database.sequence, name, deleteData },
      })
      .then((response) => response.data),
  connect: (
    id: string,
    database: ClusterDatabase,
    envKey: string | null,
    replace?: { databaseId: string; expectedSequence: number },
    readEnvKey?: string | null,
  ) =>
    api
      .post<{
        data: ClusterDatabase;
      }>(path(id) + "/connect", {
        databaseId: database.id,
        expectedSequence: database.sequence,
        envKey,
        ...(readEnvKey === undefined ? {} : { readEnvKey }),
        ...(replace ? { replace } : {}),
      })
      .then((response) => response.data),
};
