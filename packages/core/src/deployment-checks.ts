/** Project-level reporting preferences. These never gate deployment execution. */
export interface GitHubDeploymentChecks {
  enabled: boolean;
  deployment: boolean;
  /** Service names, scoped to this project. `all` also includes future services. */
  services: "all" | string[];
  includeErrors: boolean;
}

export const DEFAULT_GITHUB_DEPLOYMENT_CHECKS: Readonly<GitHubDeploymentChecks> = {
  enabled: true,
  deployment: true,
  services: "all",
  includeErrors: true,
};

export function resolveGitHubDeploymentChecks(
  value?: GitHubDeploymentChecks | null,
): GitHubDeploymentChecks {
  return { ...DEFAULT_GITHUB_DEPLOYMENT_CHECKS, ...value };
}

/** Captured at admission; editing a project's source never redirects an old report. */
export interface DeploymentCheckSource {
  owner: string;
  repo: string;
  name: string;
  checks: GitHubDeploymentChecks;
  services: Array<{ name: string; targeted: boolean }>;
}

export function deploymentCheckName(projectSlug: string, environment: string): string {
  return `Openship / ${projectSlug.slice(0, 80)} / ${environment.slice(0, 40)}`;
}
