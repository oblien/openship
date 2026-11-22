/** Normalized repository catalog row. Field names remain compatible with existing clients. */
export interface GitRepositorySummary {
  full_name: string;
  name: string;
  owner: string;
  description: string | null;
  html_url: string;
  private: boolean;
  visibility: string;
  default_branch: string;
  language: string | null;
  size: number;
  forks: number;
  watchers: number;
  stars: number;
  license: unknown;
  created_at: string;
  updated_at: string;
  pushed_at: string;
  /**
   * Where openship learned about this repo:
   *   - "app"  → covered by a provider App installation. Deployable anywhere
   *              (local + remote) via short-lived install tokens.
   *   - "cli"  → seen by the local provider CLI but NOT covered by an App
   *              installation. Deployable for LOCAL builds only; remote
   *              builds will be refused by clone-auth.
   *   - "both" → visible to both. Same capabilities as "app".
   *   - "token" → visible through the user's saved personal token, usable
   *               for local and remote builds.
   *
   * Used by the dashboard repo picker to render a "Local builds only"
   * chip + install-App-on-this-owner prompt where appropriate.
   */
  source?: "app" | "cli" | "both" | "token";
}

/** Shared repository details; preserve the existing preparation response fields. */
export interface GitRepositoryInfo {
  id: string | number;
  name: string;
  full_name: string;
  owner: string;
  private: boolean;
  default_branch: string;
  clone_url: string;
  ssh_url: string;
  html_url: string;
  branches?: Array<{ name: string }>;
  branches_has_more?: boolean;
}
