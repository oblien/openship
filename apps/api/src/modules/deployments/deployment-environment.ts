import type { Project } from "@repo/db";

export type EnvironmentProject = Pick<
  Project,
  "id" | "environmentSlug" | "environmentType" | "gitBranch"
>;

export type EnvironmentProjectSelection<T extends EnvironmentProject> =
  | { status: "matched"; project: T }
  | { status: "missing" }
  | { status: "ambiguous"; candidates: T[] };

function normalizeEnvironment(environment: string): string {
  return environment.trim().toLowerCase();
}

export function projectMatchesDeploymentEnvironment(
  project: EnvironmentProject,
  requestedEnvironment: string,
): boolean {
  const environment = normalizeEnvironment(requestedEnvironment);
  return (
    project.environmentSlug.toLowerCase() === environment ||
    project.environmentType.toLowerCase() === environment
  );
}

/**
 * Resolve a CLI/API environment selector to the isolated project row that owns
 * that runtime. Exact environment slugs win; for class selectors such as
 * "preview", the source branch disambiguates multiple preview rows.
 */
export function selectDeploymentEnvironmentProject<T extends EnvironmentProject>(
  base: T,
  siblings: T[],
  requestedEnvironment: string,
  requestedBranch?: string,
): EnvironmentProjectSelection<T> {
  const environment = normalizeEnvironment(requestedEnvironment);
  const branch = requestedBranch?.trim();

  // Production's --branch is a source override, not an environment selector.
  // For non-production environments, a matching branch identifies the correct
  // sibling when an app has multiple preview/development rows.
  if (
    projectMatchesDeploymentEnvironment(base, environment) &&
    (environment === "production" || !branch || base.gitBranch === branch)
  ) {
    return { status: "matched", project: base };
  }

  const byId = new Map<string, T>();
  byId.set(base.id, base);
  for (const sibling of siblings) byId.set(sibling.id, sibling);

  const candidates = [...byId.values()].filter((project) =>
    projectMatchesDeploymentEnvironment(project, environment),
  );

  if (branch) {
    const branchMatches = candidates.filter((project) => project.gitBranch === branch);
    if (branchMatches.length === 1) {
      return { status: "matched", project: branchMatches[0]! };
    }
    if (branchMatches.length > 1) {
      return { status: "ambiguous", candidates: branchMatches };
    }
  }

  const exactSlugMatches = candidates.filter(
    (project) => project.environmentSlug.toLowerCase() === environment,
  );
  if (exactSlugMatches.length === 1) {
    return { status: "matched", project: exactSlugMatches[0]! };
  }
  if (exactSlugMatches.length > 1) {
    return { status: "ambiguous", candidates: exactSlugMatches };
  }

  if (candidates.length === 1) {
    return { status: "matched", project: candidates[0]! };
  }
  if (candidates.length === 0) {
    return { status: "missing" };
  }
  return { status: "ambiguous", candidates };
}

/**
 * Legacy deployments use "production" as the default value even when their
 * project row is a preview environment. An explicit non-production selector,
 * however, may only promote a project row that represents that environment.
 * This prevents a misrouted preview deploy from replacing production's active
 * pointer while preserving existing preview-row deployments.
 */
export function deploymentMayBecomeActive(
  project: EnvironmentProject,
  deploymentEnvironment: string | null | undefined,
): boolean {
  const environment = normalizeEnvironment(deploymentEnvironment || "production");
  return environment === "production" || projectMatchesDeploymentEnvironment(project, environment);
}
