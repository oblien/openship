import { api } from "./client";

export interface ContainerRegistry {
  id: string;
  name: string;
  registryUrl: string;
  repositoryPrefix: string | null;
  username: string | null;
  hasCredentials: boolean;
  insecure: boolean;
  lastVerifiedAt: string | null;
  lastVerifyError: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ContainerRegistryInput = {
  name: string;
  registryUrl: string;
  repositoryPrefix?: string | null;
  username?: string | null;
  /** Write-only; registry reads expose only `hasCredentials`. */
  credentials?: string | null;
  insecure?: boolean;
};

export const registriesApi = {
  list: () => api.get<{ registries: ContainerRegistry[] }>("registries").then((result) => result.registries),
  create: (input: ContainerRegistryInput) =>
    api.post<{ registry: ContainerRegistry }>("registries", input).then((result) => result.registry),
  update: (id: string, input: Partial<ContainerRegistryInput>) =>
    api.patch<{ registry: ContainerRegistry }>(`registries/${id}`, input).then((result) => result.registry),
  test: (id: string) =>
    api.post<{ registry: ContainerRegistry; ok: true }>(`registries/${id}/test`, {}).then((result) => result.registry),
  remove: (id: string) => api.delete(`registries/${id}`),
};
