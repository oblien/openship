import { api } from "./client";
import { endpoints } from "./endpoints";

export interface CloudStatus {
  connected: boolean;
  user?: { name: string; email: string; image?: string | null };
}

export const cloudApi = {
  /** Disconnect from Openship Cloud */
  disconnect: () => api.post<CloudStatus>(endpoints.cloud.disconnect),

  /** Check current cloud connection status */
  status: () => api.get<CloudStatus>(endpoints.cloud.status),
};
