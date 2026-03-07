import { api } from "./client";
import { endpoints } from "./endpoints";

/* ------------------------------------------------------------------ */
/*  Sandbox API                                                       */
/* ------------------------------------------------------------------ */

export const sandboxApi = {
  /** Update sandbox resources (CPU, RAM, storage) */
  updateResources: (
    id: string | number,
    resources: { cpu: number; ram: number; storage: number },
  ) => api.put<any>(endpoints.sandbox.resources(id), resources),
};
