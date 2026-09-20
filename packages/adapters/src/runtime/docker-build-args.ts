import type { BuildConfig } from "../types";
import { isValidEnvKey } from "@repo/core";

/**
 * The one build-argument resolver for every Docker execution path.
 *
 * Project build env remains backward-compatible, NODE_ENV keeps its historical
 * default, and an explicit per-service compose arg wins over both. Invalid legacy
 * project-env names are filtered; invalid explicit Compose arg names fail closed.
 */
export function resolveDockerBuildArgs(
  config: Pick<BuildConfig, "envVars" | "buildArgs">,
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
  return { ...inherited, ...config.buildArgs };
}
