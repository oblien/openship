import type { BuildConfig } from "../types";
import { isValidEnvKey } from "@repo/core";

/** Built-in build argument carrying the commit this deployment builds (#1495). */
export const OPENSHIP_COMMIT_SHA_ARG = "OPENSHIP_COMMIT_SHA";

/**
 * The one build-argument resolver for every Docker execution path.
 *
 * Project build env remains backward-compatible, NODE_ENV keeps its historical
 * default, and an explicit per-service compose arg wins over both. Invalid legacy
 * project-env names are filtered; invalid explicit Compose arg names fail closed.
 *
 * OPENSHIP_COMMIT_SHA is the deployment's own commit and wins over any stored
 * value of the same name: a stored literal is exactly what goes stale when an
 * automatic redeploy builds a newer commit. It is omitted when the source has no
 * commit, so the Dockerfile's own ARG default applies.
 */
export function resolveDockerBuildArgs(
  config: Pick<BuildConfig, "envVars" | "buildArgs" | "commitSha">,
): Record<string, string> {
  const invalidExplicit = Object.keys(config.buildArgs ?? {}).filter((key) => !isValidEnvKey(key));
  if (invalidExplicit.length > 0) {
    throw new Error(`Invalid Docker build argument name(s): ${invalidExplicit.join(", ")}`);
  }

  const inherited = Object.fromEntries(
    Object.entries({
      ...config.envVars,
      NODE_ENV: "production",
    }).filter(([key]) => isValidEnvKey(key)),
  );
  const commit = config.commitSha?.trim();
  return {
    ...inherited,
    ...config.buildArgs,
    ...(commit && /^[0-9a-f]{7,64}$/i.test(commit) ? { [OPENSHIP_COMMIT_SHA_ARG]: commit } : {}),
  };
}
