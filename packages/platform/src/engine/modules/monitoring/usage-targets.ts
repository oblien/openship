import type { RuntimeAdapter } from "@repo/adapters";
import { repos } from "@repo/db";
import type { DeploymentMeta } from "../../lib/deployment-runtime";
import { isArtifactRef, usableRef } from "../../lib/container-ref";
import {
  liveContainerStatus,
  liveMatchTiersForDeployment,
  resolveLiveServiceState,
  type LiveContainerLike,
  type LiveServiceStatus,
} from "../services/live-state";

export type UsagePart = "all" | "main" | "services";
export interface UsageTarget {
  serviceId: string | null;
  name: string;
  containerId: string | null;
  status: LiveServiceStatus;
}
export interface UsageServiceConfig {
  services: Array<{ id: string; name: string }>;
  trackedIds: Record<string, string | null>;
}

/** Sidecars always use Docker, even when the main application is a host process. */
export function usageRuntimeParts(meta: DeploymentMeta, serviceCount: number) {
  return meta.runtimeMode === "bare" && serviceCount > 0
    ? [
        { part: "main" as const, meta },
        { part: "services" as const, meta: { ...meta, runtimeMode: "docker" as const } },
      ]
    : [{ part: "all" as const, meta }];
}

export async function loadUsageServiceConfig(
  projectId: string,
  deploymentId: string,
  services?: UsageServiceConfig["services"],
): Promise<UsageServiceConfig> {
  services ??= await repos.service.listByProject(projectId);
  const rows = services.length ? await repos.service.listByDeployment(deploymentId) : [];
  const byService = new Map(rows.map((row) => [row.serviceId, row.containerId]));
  return {
    services: services.map(({ id, name }) => ({ id, name })),
    trackedIds: Object.fromEntries(
      services.map((service) => [service.id, byService.get(service.id) ?? null]),
    ),
  };
}

/** One identity resolver for the live chart and historical sampler. No stored
 * deployment status is treated as evidence that an application is running. */
export async function resolveUsageTargets(
  runtime: RuntimeAdapter,
  project: { id: string; slug: string; name: string },
  deployment: { containerId: string | null; meta: DeploymentMeta },
  config: UsageServiceConfig,
  part: UsagePart = "all",
  inventory?: LiveContainerLike[] | null,
): Promise<UsageTarget[]> {
  const live =
    inventory !== undefined
      ? inventory
      : runtime.supports("hostContainerQuery") && runtime.listAllContainers
        ? await runtime.listAllContainers().catch(() => null)
        : null;
  const inspectStatus = async (containerId: string | null): Promise<LiveServiceStatus> => {
    if (!containerId) return "unknown";
    try {
      const info = await runtime.getContainerInfo(containerId);
      if (info.status === "running") return "running";
      if (info.status === "failed") return "failed";
      if (["queued", "building", "deploying"].includes(info.status)) return "starting";
      return "stopped";
    } catch {
      return "unknown";
    }
  };
  const targets: UsageTarget[] = [];
  if (part !== "main") {
    const matches = live
      ? resolveLiveServiceState({
          services: config.services,
          live,
          projectId: project.id,
          slug: project.slug,
          trackedIds: config.trackedIds,
          tiers: liveMatchTiersForDeployment({ ...deployment.meta }),
        })
      : null;
    for (const service of config.services) {
      const match = matches?.get(service.id);
      const containerId = match?.containerId ?? (live ? null : (config.trackedIds[service.id] ?? null));
      targets.push({
        serviceId: service.id,
        name: service.name,
        containerId,
        status: match?.status ?? (live ? "stopped" : await inspectStatus(containerId)),
      });
    }
  }

  const id = usableRef(deployment.containerId);
  const includeMain =
    part === "main" ||
    (part === "all" &&
      (config.services.length === 0 || deployment.meta.serviceDeploymentMode === "single"));
  if (
    includeMain &&
    id &&
    !isArtifactRef(id) &&
    !targets.some((target) => target.containerId === id)
  ) {
    let status: LiveServiceStatus;
    if (live) {
      const container = live.find((item) => item.id === id);
      status = container ? liveContainerStatus(container) : "stopped";
    } else {
      status = await inspectStatus(id);
    }
    targets.unshift({ serviceId: null, name: project.name, containerId: id, status });
  }
  return targets;
}
