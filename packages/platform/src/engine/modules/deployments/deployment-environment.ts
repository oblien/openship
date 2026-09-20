import { AppError } from "@repo/core";
import { parseOptionalEnvironmentScope } from "@repo/contracts";
import type { Project } from "@repo/db";

/**
 * The project id owns the runtime, routes and active-release pointer. The
 * deployment's environment selects an env_var set WITHIN that project; it cannot
 * turn the production project into an isolated preview (#195).
 *
 * Every project retains its default `production` variable set, including preview
 * projects edited through the dashboard. Alternate variable sets are allowed on
 * non-production targets only. Do not gate activation on this value: a successful
 * preview must still become active on its own project row.
 */
export function resolveDeploymentEnvironment(
  project: Pick<Project, "id" | "environmentType">,
  requested: string | undefined,
) {
  const environment = parseOptionalEnvironmentScope(requested) ?? "production";
  if (
    environment !== "production" &&
    project.environmentType !== "preview" &&
    project.environmentType !== "development"
  ) {
    throw new AppError(
      `The ${environment} variable set cannot deploy to production project ${project.id}. ` +
        "Select or create a separate non-production project environment and deploy its project ID.",
      400,
      "DEPLOYMENT_ENVIRONMENT_TARGET_MISMATCH",
    );
  }
  return environment;
}
