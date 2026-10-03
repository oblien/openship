/** Live project usage uses the same runtime selection and identity matching as
 * historical samples. Docker sidecars remain Docker workloads when the main app
 * uses BareRuntime. A stream keeps these read transports open until closed. */

import { findActiveDeployment } from "@repo/platform/engine/lib/active-deployment";
import { repos, type Project, type Deployment } from "@repo/db";
import { NotFoundError, safeErrorMessage } from "@repo/core";
import type { ResourceUsage, RuntimeAdapter } from "@repo/adapters";
import {
  resolveDeploymentRuntimeForRead,
  disposeRuntime,
  type DeploymentMeta,
} from "@repo/platform/engine/lib/deployment-runtime";
import { getHostCapacity } from "@repo/platform/engine/lib/host-capacity";
import { mapWithLimit } from "@repo/platform/engine/lib/map-with-limit";
import type { LiveServiceStatus } from "../services/live-state";
import {
  loadUsageServiceConfig,
  resolveUsageTargets,
  usageRuntimeParts,
  type UsagePart,
  type UsageTarget,
} from "./usage-targets";
import { systemDebug } from "@repo/platform/engine/lib/system-debug";
import type { ExecutionContext as RequestContext } from "@repo/platform";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ServiceUsage {
  /** Service row id, or null for the single-container app itself. */
  serviceId: string | null;
  name: string;
  containerId: string | null;
  status: LiveServiceStatus;
  /** Null when the container is gone or the runtime couldn't answer for it. */
  usage: ResourceUsage | null;
}

export interface ProjectUsage {
  /**
   * False when no application runtime can measure resource usage.
   * The UI must say "unavailable" rather than render the zeros a stub returns —
   * zeros are indistinguishable from an idle container.
   */
  supported: boolean;
  /** Why, when `supported` is false. */
  reason?: string;
  /** Sum across services (or the single container). */
  overall: ResourceUsage;
  services: ServiceUsage[];
  /** Denominators, so a percentage means something. Null when unknown. */
  capacity: { cpuCores: number | null; memoryMb: number | null };
  timestamp: string;
}

const ZERO: ResourceUsage = {
  cpuPercent: 0,
  memoryMb: 0,
  diskMb: 0,
  networkRxBytes: 0,
  networkTxBytes: 0,
};

function emptyUsage(reason: string): ProjectUsage {
  return {
    supported: false,
    reason,
    overall: { ...ZERO },
    services: [],
    capacity: { cpuCores: null, memoryMb: null },
    timestamp: new Date().toISOString(),
  };
}

function sum(usages: (ResourceUsage | null)[]): ResourceUsage {
  const total = { ...ZERO };
  for (const u of usages) {
    if (!u) continue;
    total.cpuPercent += u.cpuPercent;
    total.memoryMb += u.memoryMb;
    total.diskMb += u.diskMb;
    total.networkRxBytes += u.networkRxBytes;
    total.networkTxBytes += u.networkTxBytes;
  }
  // Sub-cent precision is noise on a summed gauge.
  total.cpuPercent = Math.round(total.cpuPercent * 100) / 100;
  total.memoryMb = Math.round(total.memoryMb * 100) / 100;
  total.diskMb = Math.round(total.diskMb * 100) / 100;
  return total;
}

/**
 * How many containers to sample at once.
 *
 * `getUsage` is NOT cheap: `container.stats({stream: false})` makes the daemon
 * collect two CPU samples to compute a delta, so each call occupies it for roughly
 * a second — ~500x a `docker inspect`. An unbounded fan-out over a 20-service stack
 * therefore fired 20 concurrent second-long requests at one daemon every 5 seconds
 * for a single open tab, and could push a tick past its own interval.
 *
 * 8 matches the health watch's INSPECT_CONCURRENCY, so the two pollers present a
 * comparable load profile to the same daemon.
 */
const SAMPLE_CONCURRENCY = 8;

/**
 * Sample every target, at bounded concurrency.
 *
 * `allSettled` semantics by hand: a container that vanished between the host
 * listing and the stats call yields `usage: null` rather than rejecting, so one
 * dead service can't blank the whole card.
 */
async function sampleTargets(
  runtime: RuntimeAdapter,
  targets: UsageTarget[],
  onError?: (t: UsageTarget, err: unknown) => void,
): Promise<ServiceUsage[]> {
  const out: ServiceUsage[] = targets.map((t) => ({ ...t, usage: null }));

  // Only ask about containers the host says are RUNNING. Free — the state came
  // back with the container listing — and it avoids paying a full second for a
  // stopped container that has no stats to give.
  const askable = targets
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => !!t.containerId && t.status === "running");

  await mapWithLimit(askable, SAMPLE_CONCURRENCY, async ({ t, i }) => {
    try {
      out[i] = { ...t, usage: await runtime.getUsage(t.containerId!) };
    } catch (err) {
      onError?.(t, err);
    }
  });

  return out;
}

async function usageContext(ctx: RequestContext, projectId: string) {
  const project = await repos.project.findById(projectId);
  if (!project || project.organizationId !== ctx.organizationId)
    throw new NotFoundError("Project", projectId);
  return { project, dep: await findActiveDeployment(project) };
}

async function usageCapacity(dep: Deployment, serverId: string | null) {
  const meta = (dep.meta ?? {}) as DeploymentMeta;
  if (meta.managedServer) {
    const { readCloudWorkspaceHost } = await import("../../lib/cloud-workspace-host");
    const { provider } = await readCloudWorkspaceHost(
      dep.organizationId,
      meta.managedServer.ownerWorkspaceId,
    );
    return provider?.allocation ?? null;
  }
  return getHostCapacity(serverId ?? undefined, dep.organizationId, { localFallback: !serverId });
}

interface ProjectUsageSampler {
  serverId: string | null;
  sample(): Promise<ProjectUsage>;
  close(): Promise<void>;
}

async function createSampler(
  project: Project,
  dep: Deployment,
): Promise<ProjectUsageSampler | { error: string }> {
  const config = await loadUsageServiceConfig(project.id, dep.id);
  const handles: Array<{ runtime: RuntimeAdapter; part: UsagePart; meta: DeploymentMeta }> = [];
  let serverId: string | null = null;
  const close = async () => {
    for (const { runtime } of handles) disposeRuntime(runtime);
  };
  try {
    for (const selection of usageRuntimeParts(
      (dep.meta ?? {}) as DeploymentMeta,
      config.services.length,
    )) {
      const resolved = await resolveDeploymentRuntimeForRead({ ...dep, meta: selection.meta });
      serverId = resolved.serverId;
      handles.push({ runtime: resolved.runtime, ...selection });
    }
  } catch (error) {
    await close();
    throw error;
  }
  if (!handles.some(({ runtime }) => runtime.supports("usage"))) {
    await close();
    return { error: "Resource usage is not available for this deployment" };
  }
  const capacityPromise = usageCapacity(dep, serverId).catch(() => null);
  return {
    serverId,
    sample: async (): Promise<ProjectUsage> => {
      const services: ServiceUsage[] = [];
      for (const { runtime, part, meta } of handles) {
        if (!runtime.supports("usage")) continue;
        const targets = await resolveUsageTargets(
          runtime,
          project,
          { containerId: dep.containerId, meta },
          config,
          part,
        );
        services.push(
          ...(await sampleTargets(runtime, targets, (target, error) =>
            systemDebug(
              "project-usage",
              `getUsage failed project=${project.id} service=${target.name}: ${safeErrorMessage(error)}`,
            ),
          )),
        );
      }
      const capacity = await capacityPromise;
      return {
        supported: true,
        overall: sum(services.map((service) => service.usage)),
        services,
        capacity: { cpuCores: capacity?.cpuCores ?? null, memoryMb: capacity?.memoryMb ?? null },
        timestamp: new Date().toISOString(),
      };
    },
    close: async () => {
      await capacityPromise;
      await close();
    },
  };
}

export async function collectProjectUsage(
  ctx: RequestContext,
  projectId: string,
): Promise<ProjectUsage> {
  const { project, dep } = await usageContext(ctx, projectId);
  if (!dep) return emptyUsage("No active deployment");
  const sampler = await createSampler(project, dep);
  if ("error" in sampler) return emptyUsage(sampler.error!);
  try {
    return await sampler.sample();
  } finally {
    await sampler.close();
  }
}

export async function openProjectUsageSampler(
  ctx: RequestContext,
  projectId: string,
): Promise<ProjectUsageSampler | { error: string }> {
  let context;
  try {
    context = await usageContext(ctx, projectId);
  } catch (error) {
    if (error instanceof NotFoundError) return { error: "Project not found" };
    throw error;
  }
  if (!context.dep) return { error: "No active deployment" };
  return createSampler(context.project, context.dep);
}
