import { AppError, type RoutingConfig } from "@repo/core";
import type { Project } from "@repo/db";
import { isDeepStrictEqual } from "node:util";
import { resolveProjectDeployTarget } from "./project-deploy-target";

export function assertCloudRoutingCapabilities(
  routing: RoutingConfig | null | undefined,
  isCloud: boolean,
): void {
  if (isCloud && routing?.proxy && Object.keys(routing.proxy).length > 0) {
    throw new AppError(
      "Proxy settings are only supported on self-hosted edges. Remove routingConfig.proxy to save routing rules on Openship Cloud.",
      400,
      "CLOUD_PROXY_SETTINGS_UNSUPPORTED",
    );
  }
}

/** Reject changed unsupported settings, without blocking legacy config carry-forward. */
export async function assertProjectRoutingCapabilities(
  project: Project,
  routing: RoutingConfig | null | undefined,
): Promise<void> {
  if (!routing?.proxy || Object.keys(routing.proxy).length === 0) return;
  if (isDeepStrictEqual(routing.proxy, project.routingConfig?.proxy)) return;
  const { deployTarget } = await resolveProjectDeployTarget(project);
  assertCloudRoutingCapabilities(routing, deployTarget === "cloud");
}
