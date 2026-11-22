import type { GitRepositorySummary } from "@repo/contracts";
export interface RepositorySummary {
  id: string | number;
  full_name: string;
  name: string;
  description: string;
  private: boolean;
  stars: number;
  stargazers_count?: number;
  forks: number;
  forks_count?: number;
  language: string;
  updated_at: string;
  default_branch: string;
  owner: { login: string; avatar_url: string } | string;
  html_url?: string;
  /**
   * Which credential source listed this repository (App, CLI, both, or personal
   * token). This is provenance, not a deployment restriction: preflight resolves
   * access for the chosen target, including server credentials and desktop relay.
   */
  source?: GitRepositorySummary["source"];
}

export function repositorySummary(row: GitRepositorySummary): RepositorySummary {
  return { ...row, id: row.full_name, language: row.language ?? "", description: row.description ?? "" };
}
