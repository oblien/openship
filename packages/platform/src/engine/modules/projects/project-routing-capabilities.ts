import {
  AppError,
  normalizeProjectEdgePages,
  resolveProjectEdgePages,
  type RoutingConfig,
} from "@repo/core";
import type { Project } from "@repo/db";
import { isDeepStrictEqual } from "node:util";
import { resolveProjectDeployTarget } from "./project-deploy-target";

/** Refuse a move before provisioning a destination that cannot enforce these pages. */
export function assertProjectEdgePagesTarget(
  project: Pick<Project, "routingConfig">,
  target: string | null | undefined,
) {
  if (target !== "cloud" && target !== "cluster") return;
  const pages = project.routingConfig?.edgePages;
  if (
    resolveProjectEdgePages(pages, "") ||
    Object.keys(pages?.hosts ?? {}).some((host) => resolveProjectEdgePages(pages, host))
  )
    throw new AppError(
      "This project uses maintenance or custom error pages. Remove their assignments before moving it to a destination without a self-hosted edge.",
      409,
      "EDGE_PAGES_UNSUPPORTED",
    );
}

export function assertCloudRoutingCapabilities(
  routing: RoutingConfig | null | undefined,
  isCloud: boolean,
): void {
  if (routing?.edgePages) {
    routing.edgePages = normalizeProjectEdgePages(routing.edgePages);
    if (isCloud)
      throw new AppError(
        "Custom edge pages require a self-hosted edge.",
        400,
        "EDGE_PAGES_UNSUPPORTED",
      );
  }
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
  if (routing?.edgePages) {
    routing.edgePages = normalizeProjectEdgePages(routing.edgePages);
    if (!isDeepStrictEqual(routing.edgePages, project.routingConfig?.edgePages ?? {}))
      throw new AppError(
        "Save maintenance and custom pages through the project's edge-pages settings.",
        409,
        "EDGE_PAGES_DEDICATED_UPDATE_REQUIRED",
      );
    const { deployTarget } = await resolveProjectDeployTarget(project);
    if (project.clusterId || project.workspaceId || deployTarget === "cloud")
      throw new AppError(
        "Custom edge pages require a self-hosted edge.",
        400,
        "EDGE_PAGES_UNSUPPORTED",
      );
  }
  if (!routing?.proxy || Object.keys(routing.proxy).length === 0) return;
  if (isDeepStrictEqual(routing.proxy, project.routingConfig?.proxy)) return;
  const { deployTarget } = await resolveProjectDeployTarget(project);
  assertCloudRoutingCapabilities(routing, deployTarget === "cloud");
}
