import type {
  ProjectAutoscalePolicy,
  ProjectAutoscaleSchemas,
  AutoscaleEvent,
} from "@repo/contracts";
import type { Static } from "@sinclair/typebox";
import { api } from "./client";
const path = (id: string) => `projects/${encodeURIComponent(id)}/autoscale`;
export const projectAutoscaleApi = {
  get: (id: string) =>
    api.get<{ data: ProjectAutoscalePolicy }>(path(id)).then((response) => response.data),
  set: (id: string, input: Static<typeof ProjectAutoscaleSchemas.setAutoscalePolicy.input>) =>
    api.put<{ data: ProjectAutoscalePolicy }>(path(id), input).then((response) => response.data),
  events: (id: string) =>
    api
      .get<{ data: { events: AutoscaleEvent[] } }>(path(id) + "/events")
      .then((response) => response.data),
};