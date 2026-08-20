import { api } from "./client";
import { endpoints } from "./endpoints";

export interface AzureStatus {
  connected: boolean;
  oauth: boolean;
  pat: boolean;
  oauthConfigured: boolean;
  orgs: string[];
}

export interface AzureRepo {
  id: string;
  name: string;
  org: string;
  project: string;
  full_name: string;
  default_branch?: string;
  html_url?: string;
  private: boolean;
}

export const azureApi = {
  getStatus: () => api.get<AzureStatus>(endpoints.azure.status),

  connect: () =>
    api.post<{ connected: boolean; flow: "redirect" | "token"; error?: string }>(
      endpoints.azure.connect,
    ),

  disconnect: () => api.post<{ success: boolean }>(endpoints.azure.disconnect),

  setInstanceToken: (token: string | null) =>
    api.post<{ success: boolean; cleared?: boolean }>(endpoints.azure.instanceToken, {
      token,
    }),

  listOrgs: () => api.get<{ orgs: string[] }>(endpoints.azure.orgs),

  listRepos: (org: string) =>
    api.get<{ repos: AzureRepo[] }>(endpoints.azure.orgRepos(org)),
};
