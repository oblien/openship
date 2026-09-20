import { interpolate } from "@/components/i18n-provider";
import type { Dictionary } from "@/i18n";

/**
 * WHERE this deploy lands and WHERE it builds, as display strings.
 *
 * One resolver for both progress screens. The single-app view
 * (`DeploymentProcessing`) owned these inline and the compose view
 * (`ComposeSidebar`) showed neither — so a compose deploy never told the operator
 * which machine it was going to, which is the one fact a wizard-driven deploy
 * can't be inferred from anything else on the page. Shared rather than copied
 * because the two screens describe the SAME config object; two copies would let
 * "Server · box-1" and "Server" drift apart per screen.
 *
 * The value strings live under `importProject.deploymentProcessing` (where they
 * started); only the row LABELS are per-screen.
 */
export function describeBuildTarget(
  config: { deployTarget: string; serverName?: string },
  t: Dictionary,
): string {
  const dp = t.importProject.deploymentProcessing;
  if (config.deployTarget === "cloud") return dp.targetOpenshipCloud;
  if (config.deployTarget === "server") {
    return config.serverName
      ? interpolate(dp.targetServerNamed, { name: config.serverName })
      : dp.targetServer;
  }
  if (config.deployTarget === "local") return dp.targetLocal;
  return "—";
}

/** Where the build runs (vs where it deploys, shown by the target above).
 *  Concise so it fits the narrow info column without truncating. */
export function describeBuildStrategy(
  config: { deployTarget: string; buildStrategy: string },
  t: Dictionary,
): string {
  const dp = t.importProject.deploymentProcessing;
  if (config.buildStrategy === "local") return dp.strategyLocal;
  if (config.deployTarget === "cloud") return dp.strategyCloud;
  if (config.deployTarget === "server") return dp.strategyServer;
  return dp.strategyHost;
}
