import { GIT_PROVIDERS, DEFAULT_GIT_PROVIDER, gitProviderDefinition } from "@repo/core";
import type { GitRepositorySummary } from "@repo/contracts";
import { api, getApiErrorCode } from "./client";
import type { BranchPageResponse, RepoListQuery, RepoPageResponse, RepoTreeEntry } from "./github";

/** Provider identity is part of URLs and refresh events, including request deduplication. */
export const gitSourcesChangedEvent = (provider: string) => `openship:${provider}-sources-changed`;

export function gitApi(provider = DEFAULT_GIT_PROVIDER) {
  if (!gitProviderDefinition(provider)) throw new Error(`Unsupported Git provider: ${provider}`);
  const base = `/git/${encodeURIComponent(provider)}/repos`;
  const repository = (owner: string, repo: string) =>
    `${base}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  return {
    getUserRepos: (owner?: string, params?: RepoListQuery, force = false) =>
      api.get<RepoPageResponse<GitRepositorySummary>>(base, {
        params: { owner, ...params },
        dedupe: !force,
      }),
    getRepoTree: (owner: string, repo: string, branch?: string, serverId?: string) =>
      api.get<{ data: RepoTreeEntry[] }>(`${repository(owner, repo)}/tree`, {
        params: { branch, serverId },
      }),
    listBranches: (owner: string, repo: string, page = 1, serverId?: string) =>
      api.get<BranchPageResponse>(`${repository(owner, repo)}/branches`, {
        params: { page, serverId },
      }),
  };
}

/** Provider-owned connection transport, also usable on public consent screens. */
const connections: Record<string, { namespaces(): Promise<string[]> }> = {
  gitlab: {
    async namespaces() {
      try {
        const { data } = await gitApi("gitlab").getUserRepos();
        return [...new Set(data.map((row) => row.owner))];
      } catch (error) {
        if (getApiErrorCode(error) === "GIT_CONNECTION_REQUIRED") return [];
        throw error;
      }
    },
  },
  github: {
    async namespaces() {
      const { githubApi } = await import("./github");
      const home: { accounts?: Array<{ login?: unknown }> } | null = await githubApi.getUserHome();
      return (home?.accounts ?? [])
        .map((account) => account.login)
        .filter((login): login is string => typeof login === "string" && login.length > 0);
    },
  },
};

export async function authorizedGitNamespaces(): Promise<
  Array<{ provider: string; namespace: string }>
> {
  return (
    await Promise.all(
      GIT_PROVIDERS.map(async (definition) => {
        const connection = connections[definition.id];
        if (!connection) throw new Error(`Unsupported Git connection: ${definition.id}`);
        return (await connection.namespaces()).map((namespace) => ({
          provider: definition.id,
          namespace,
        }));
      }),
    )
  ).flat();
}
