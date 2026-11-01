import type { ProjectCluster, ProjectClusterSchemas } from "@repo/contracts";
import type { Static } from "@sinclair/typebox";
import { api } from "./client";
const path = (id: string) => `projects/${encodeURIComponent(id)}/cluster`;
export const projectClusterApi = {
  get: (id: string) =>
    api.get<{ data: ProjectCluster }>(path(id)).then((response) => response.data),
  set: (id: string, input: Static<typeof ProjectClusterSchemas.setClusterTarget.input>) =>
    api.patch<{ data: ProjectCluster }>(path(id), input).then((response) => response.data),
  scale: (id: string, input: Static<typeof ProjectClusterSchemas.scaleClusterWorkload.input>) =>
    api
      .post<{ data: { deploymentId: string } }>(path(id) + "/scale", input)
      .then((response) => response.data),
};
