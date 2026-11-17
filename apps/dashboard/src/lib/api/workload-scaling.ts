import type { Static } from "@sinclair/typebox";
import type { WorkloadScaling, WorkloadScalingSchemas } from "@repo/contracts";
import { api } from "./client";
const path = (id: string) => `projects/${encodeURIComponent(id)}/scaling`;
export const workloadScalingApi = {
  get: (id: string, serviceId?: string) =>
    api
      .get<{ data: WorkloadScaling }>(
        path(id) + (serviceId ? `?serviceId=${encodeURIComponent(serviceId)}` : ""),
      )
      .then((response) => response.data),
  scale: (id: string, input: Static<typeof WorkloadScalingSchemas.scaleWorkload.input>) =>
    api.post<{ data: { deploymentId: string } }>(path(id), input).then((response) => response.data),
};
