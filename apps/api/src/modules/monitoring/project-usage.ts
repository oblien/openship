/**
 * Live resource usage for a project — one overall figure plus a per-service
 * breakdown, from a single pass over the host.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * The previous usage read (`analytics.service.getContainerUsage`) took
 * `deployment.containerId` and stopped. For a compose project that id is the
 * PRIMARY service's container, so a five-service stack reported one container's
 * CPU as though it were the project's, and the other four were invisible.
 *
 * ── The two-adapter handoff ─────────────────────────────────────────────────
 *
 * There is no new adapter layer here, because the right boundary already exists:
 * `RuntimeAdapter.getUsage()`, implemented by `DockerRuntime` (dockerode stats)
 * and `CloudRuntime` (Oblien `metrics.stats()`). This module resolves ONE runtime
 * and fans out over containers; which backend answers is the adapter's problem.
 *
 * What does differ per mode is how a service maps to a container, and that
 * asymmetry is real rather than incidental:
 *
 *   self-hosted → the host can be enumerated (`hostContainerQuery`), so identity
 *                 is resolved LIVE via resolveLiveServiceState. Necessary, not
 *                 belt-and-braces: the recorded id goes stale on every redeploy,
 *                 and an ADOPTED container never carried our labels at all.
 *   cloud       → services are Oblien workspaces; there is no host to enumerate,
 *                 so the recorded `service_deployment.containerId` (the workspace
 *                 id) IS the identity. Same precedence liveContainerIdWithRuntime
 *                 already encodes, applied to every service in one shot.
 *
 * ── Read-path discipline ────────────────────────────────────────────────────
 *
 * Resolution goes through `resolveDeploymentRuntimeForRead`, NOT
 * `resolveDeploymentRuntime`. The latter builds a full platform, which on a bare
 * self-hosted box runs `detectOpenRestyPaths` and re-asserts the edge Lua inside
 * the provision lock — fine once per deploy, wrong on a path polled every few
 * seconds. That contention is the documented cause of service reads timing out
 * and rendering "unknown" while the containers were up, and the old
 * `usageStream` was doing exactly it on a 5s loop.
 */

import { repos } from "@repo/db";
import { NotFoundError, safeErrorMessage } from "@repo/core";
import type { ResourceUsage, RuntimeAdapter } from "@repo/adapters";
import { resolveDeploymentRuntimeForRead } from "../../lib/deployment-runtime";
import { getHostCapacity } from "../../lib/host-capacity";
import { mapWithLimit } from "../../lib/map-with-limit";
import { resolveLiveServiceState, type LiveServiceStatus } from "../services/live-state";
import { systemDebug } from "../../lib/system-debug";
import type { RequestContext } from "../../lib/request-context";

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
   * False when this runtime cannot measure usage at all (bare deployments).
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

// ─── Target resolution ───────────────────────────────────────────────────────

interface UsageTarget {
  serviceId: string | null;
  name: string;
  containerId: string | null;
  status: LiveServiceStatus;
}

/**
 * The DB half of target resolution: which services exist and which container each
 * was recorded as. Read ONCE per stream, not per tick.
 *
 * Service rows and their recorded container ids change on a DEPLOY, not between
 * two ticks five seconds apart. Reading them every tick meant an open Monitoring
 * tab issued two Postgres queries every five seconds — ~24/min per viewer, ~120/min
 * with five people watching — for a result that is the same every time.
 *
 * The HOST half deliberately stays per-tick: a container starting, stopping, or
 * being replaced mid-stream is exactly what the dots exist to show.
 */
async function loadServiceConfig(
  projectId: string,
  deploymentId: string,
): Promise<{
  services: Array<{ id: string; name: string }>;
  trackedIds: Record<string, string | null>;
}> {
  const services = await repos.service.listByProject(projectId);
  if (services.length === 0) return { services: [], trackedIds: {} };

  const sdRows = await repos.service.listByDeployment(deploymentId);
  const trackedIds: Record<string, string | null> = {};
  for (const s of services) {
    trackedIds[s.id] = sdRows.find((r) => r.serviceId === s.id)?.containerId ?? null;
  }
  return { services: services.map((s) => ({ id: s.id, name: s.name })), trackedIds };
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

/**
 * Every container this project's usage should cover, with the live status of each.
 *
 * ONE host query for the whole project (not one per service): a compose stack
 * polled every few seconds would otherwise issue N `docker ps -a` calls per tick
 * over the same SSH connection.
 */
async function resolveTargets(
  runtime: RuntimeAdapter,
  project: { id: string; slug: string; name: string },
  dep: { containerId: string | null },
  config: Awaited<ReturnType<typeof loadServiceConfig>>,
): Promise<UsageTarget[]> {
  const { services, trackedIds } = config;

  // Single-container app: no service rows, so the deployment's container is it.
  if (services.length === 0) {
    return dep.containerId
      ? [{ serviceId: null, name: project.name, containerId: dep.containerId, status: "running" }]
      : [];
  }

  const canEnumerate = runtime.supports("hostContainerQuery") && !!runtime.listAllContainers;
  const live = canEnumerate ? await runtime.listAllContainers!().catch(() => null) : null;

  // Cloud, or a host that wouldn't answer: fall back to the recorded ids. Never
  // worse than before — same degradation liveContainerIdWithRuntime chose.
  if (!live) {
    return services.map((s) => ({
      serviceId: s.id,
      name: s.name,
      containerId: trackedIds[s.id],
      // The recorded id is a RECORD, not an observation: we have not seen this
      // container, so claiming "running" would be a guess. The usage read below is
      // what actually proves liveness.
      status: trackedIds[s.id] ? "running" : "stopped",
    }));
  }

  const matches = resolveLiveServiceState({
    services: services.map((s) => ({ id: s.id, name: s.name })),
    live,
    projectId: project.id,
    slug: project.slug,
    trackedIds,
  });

  return services.map((s) => {
    const m = matches.get(s.id);
    return {
      serviceId: s.id,
      name: s.name,
      containerId: m?.containerId ?? null,
      status: m?.status ?? "stopped",
    };
  });
}

// ─── Collection ──────────────────────────────────────────────────────────────

/**
 * Sample usage for every container in a project, once.
 *
 * Never throws for a per-container failure: a container that vanished between the
 * host listing and the stats call yields `usage: null`, so one dead service can't
 * blank the whole card. Only project-not-found is an error.
 */
export async function collectProjectUsage(
  ctx: RequestContext,
  projectId: string,
): Promise<ProjectUsage> {
  const project = await repos.project.findById(projectId);
  if (!project || project.organizationId !== ctx.organizationId) {
    throw new NotFoundError("Project", projectId);
  }
  if (!project.activeDeploymentId) return emptyUsage("No active deployment");

  const dep = await repos.deployment.findById(project.activeDeploymentId);
  if (!dep) return emptyUsage("No active deployment");

  const { runtime, serverId } = await resolveDeploymentRuntimeForRead(dep);
  try {
    if (!runtime.supports("usage")) {
      // BareRuntime returns zeros from a stub. Reporting them as data is worse
      // than reporting nothing: an idle app and an unmeasurable one look identical.
      return emptyUsage(`Resource usage is not available for ${runtime.name} deployments`);
    }

    const config = await loadServiceConfig(project.id, dep.id);
    const targets = await resolveTargets(
      runtime,
      { id: project.id, slug: project.slug, name: project.name },
      { containerId: dep.containerId },
      config,
    );

    const services = await sampleTargets(runtime, targets, (t, err) =>
      systemDebug(
        "project-usage",
        `getUsage failed project=${projectId} service=${t.name}: ${safeErrorMessage(err)}`,
      ),
    );

    // Cloud never probes host hardware (getHostCapacity hard-gates on CLOUD_MODE
    // and returns UNKNOWN), so this is null there rather than wrong.
    const capacity = await getHostCapacity(serverId ?? undefined, ctx.organizationId).catch(
      () => null,
    );

    return {
      supported: true,
      overall: sum(services.map((s) => s.usage)),
      services,
      capacity: {
        cpuCores: capacity?.cpuCores ?? null,
        memoryMb: capacity?.memoryMb ?? null,
      },
      timestamp: new Date().toISOString(),
    };
  } finally {
    // Tears down the SSH loopback bridge on the server transport.
    void Promise.resolve(runtime.dispose?.()).catch(() => {});
  }
}

/**
 * Sampler bound to ONE resolved runtime, for the SSE stream.
 *
 * The stream must not re-resolve the runtime (and re-open the SSH bridge) every
 * tick, so it resolves once and calls `sample()` on a loop. `close()` releases the
 * runtime; the caller owns it for the life of the stream.
 */
export async function openProjectUsageSampler(
  ctx: RequestContext,
  projectId: string,
): Promise<{
  serverId: string | null;
  sample: () => Promise<ProjectUsage>;
  close: () => Promise<void>;
} | { error: string }> {
  const project = await repos.project.findById(projectId);
  if (!project || project.organizationId !== ctx.organizationId) {
    return { error: "Project not found" };
  }
  if (!project.activeDeploymentId) return { error: "No active deployment" };

  const dep = await repos.deployment.findById(project.activeDeploymentId);
  if (!dep) return { error: "No active deployment" };

  const { runtime, serverId } = await resolveDeploymentRuntimeForRead(dep);
  if (!runtime.supports("usage")) {
    void Promise.resolve(runtime.dispose?.()).catch(() => {});
    return { error: `Resource usage is not available for ${runtime.name} deployments` };
  }

  // Both resolved ONCE for the life of the stream: capacity is hardware, and
  // service config changes on a deploy rather than between ticks.
  const capacityPromise = getHostCapacity(serverId ?? undefined, ctx.organizationId).catch(
    () => null,
  );
  const configPromise = loadServiceConfig(project.id, dep.id);

  return {
    serverId,
    sample: async () => {
      // The HOST is re-queried each tick on purpose: a service started, stopped, or
      // replaced mid-stream must show up, which is the whole point of dots that
      // track live state. The DB is not — see loadServiceConfig.
      const targets = await resolveTargets(
        runtime,
        { id: project.id, slug: project.slug, name: project.name },
        { containerId: dep.containerId },
        await configPromise,
      );
      const services = await sampleTargets(runtime, targets);
      // Capacity is hardware — resolved once, reused (and it's cached 5min anyway).
      const capacity = await capacityPromise;
      return {
        supported: true,
        overall: sum(services.map((s) => s.usage)),
        services,
        capacity: {
          cpuCores: capacity?.cpuCores ?? null,
          memoryMb: capacity?.memoryMb ?? null,
        },
        timestamp: new Date().toISOString(),
      };
    },
    close: async () => {
      await Promise.resolve(runtime.dispose?.()).catch(() => {});
    },
  };
}
