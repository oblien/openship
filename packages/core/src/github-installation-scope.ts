import { ValidationError } from "./errors";

export type GitHubInstallationPermissions = Record<string, "read" | "write">;
export interface GitHubInstallationScope {
  repositories: string[];
  permissions: GitHubInstallationPermissions;
}

/** Repository permissions only. Account/installation administration is never delegated to a workflow. */
const allowed = new Set([
  "actions",
  "checks",
  "contents",
  "deployments",
  "discussions",
  "issues",
  "packages",
  "pull_requests",
  "repository_projects",
  "security_events",
  "statuses",
]);
export function validateGitHubInstallationScope(
  repositories: unknown,
  permissions: unknown,
): GitHubInstallationScope {
  if (
    !Array.isArray(repositories) ||
    !repositories.length ||
    repositories.length > 20 ||
    repositories.some((repo) => typeof repo !== "string" || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo))
  )
    throw new ValidationError("A scoped GitHub token requires explicit repository names");
  if (!permissions || typeof permissions !== "object" || Array.isArray(permissions))
    throw new ValidationError("Invalid GitHub token permissions");
  for (const [name, value] of Object.entries(permissions))
    if (!allowed.has(name) || !["read", "write"].includes(String(value)))
      throw new ValidationError(`Unsupported GitHub repository permission: ${name}`);
  return {
    repositories: [...new Set(repositories.map((repo) => repo.toLowerCase()))].sort(),
    permissions: { ...permissions } as GitHubInstallationPermissions,
  };
}

/** An older proxy or unexpected provider response must not widen a job's token. */
export function matchesGitHubInstallationScope(
  expected: GitHubInstallationScope,
  actual: unknown,
): boolean {
  if (!actual || typeof actual !== "object") return false;
  const value = actual as GitHubInstallationScope;
  if (
    !Array.isArray(value.repositories) ||
    !value.permissions ||
    typeof value.permissions !== "object" ||
    Array.isArray(value.permissions)
  )
    return false;
  const repos = value.repositories
    .map((repo) => (typeof repo === "string" ? repo.toLowerCase() : ""))
    .sort();
  if (JSON.stringify(repos) !== JSON.stringify(expected.repositories)) return false;
  for (const [name, access] of Object.entries(value.permissions)) {
    if (name === "metadata" && access === "read") continue;
    if (expected.permissions[name] !== access) return false;
  }
  return Object.entries(expected.permissions).every(
    ([name, access]) => value.permissions[name] === access,
  );
}
