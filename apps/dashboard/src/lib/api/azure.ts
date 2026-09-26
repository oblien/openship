import { api } from "./client";
import { endpoints } from "./endpoints";

export interface AzureConnectionInfo {
  adoOrg: string;
  status: string;
  patSetAt: string;
}

export interface AzureStatus {
  connected: boolean;
  connections: AzureConnectionInfo[];
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

  /** Save a PAT for one Azure DevOps organization (validated before storage). */
  saveToken: (token: string, organization: string) =>
    api.post<{ success: boolean; adoOrg: string }>(endpoints.azure.saveToken, {
      token,
      organization,
    }),

  deleteConnection: (org: string) =>
    api.delete<{ success: boolean; deleted: boolean }>(endpoints.azure.deleteConnection(org)),

  listOrgs: () => api.get<{ orgs: string[] }>(endpoints.azure.orgs),

  listRepos: (org: string) =>
    api.get<{ repos: AzureRepo[] }>(endpoints.azure.orgRepos(org)),
};
