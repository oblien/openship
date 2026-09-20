/**
 * Pure GitHub response mappers — raw GitHub API shapes → the clean Mapped*
 * shapes the dashboard consumes. No I/O, no mode branching, no App/gh/cloud
 * knowledge, so every source adapter can import these without pulling in the
 * heavier service/auth modules.
 *
 * Re-exported from github.service.ts (mapRepositories) and github.auth.ts
 * (mapAccounts) for back-compat with existing call sites.
 */

import type {
  GitHubInstallation,
  GitHubRepository,
  MappedAccount,
  MappedRepository,
} from "@repo/contracts";

export function mapRepositories(repos: GitHubRepository[]): MappedRepository[] {
  if (!Array.isArray(repos)) return [];

  return repos.map((r) => ({
    full_name: r.full_name,
    name: r.name,
    owner: r.owner?.login ?? r.full_name?.split("/")?.[0] ?? "",
    description: r.description,
    html_url: r.html_url,
    private: r.private,
    visibility: r.visibility,
    default_branch: r.default_branch,
    language: r.language,
    size: r.size,
    forks: r.forks,
    watchers: r.watchers,
    stars: r.stargazers_count ?? 0,
    license: r.license,
    created_at: r.created_at,
    updated_at: r.updated_at,
    pushed_at: r.pushed_at,
  }));
}

export function mapAccounts(installations: GitHubInstallation[]): MappedAccount[] {
  const accounts = new Map<string, MappedAccount>();
  for (const installation of installations) {
    const key = installation.account.login.toLowerCase();
    if (accounts.has(key)) continue;
    accounts.set(key, {
      login: installation.account.login,
      id: installation.account.id,
      avatar_url: installation.account.avatar_url,
      type: installation.account.type,
    });
  }
  return [...accounts.values()];
}
