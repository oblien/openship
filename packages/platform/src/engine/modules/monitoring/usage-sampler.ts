/** Historical resource samples run at fixed intervals, independently of health
 * events. Reuse one read runtime per server/runtime/project scope, with a shared
 * sampling budget for all projects on the same physical server. */

import { activeDeploymentForProject } from "@repo/platform/engine/lib/active-deployment";
import {
  repos,
  SINGLE_APP_SERVICE_KEY,
  RESOURCE_BUCKET_MINUTES,
  type NewResourceUsage,
} from "@repo/db";
import { safeErrorMessage } from "@repo/core";
import type { RuntimeAdapter } from "@repo/adapters";
import {
  resolveDeploymentRuntimeForRead,
  disposeRuntime,
  type DeploymentMeta,
} from "@repo/platform/engine/lib/deployment-runtime";
import { mapWithLimit } from "@repo/platform/engine/lib/map-with-limit";
import { systemDebug, formatDuration } from "@repo/platform/engine/lib/system-debug";
import {
  loadUsageServiceConfig,
  resolveUsageTargets,
  usageRuntimeParts,
  type UsagePart,
  type UsageServiceConfig,
} from "./usage-targets";
import { isManagedServerIdle } from "./health-watch-policy";
import { watchGroupKey } from "@repo/platform/engine/modules/monitoring/health-watch";

function debug(msg: string): void {
  systemDebug("usage-sampler", msg);
}

/** Concurrent stats calls per server. Matches the health watch's INSPECT_CONCURRENCY
 *  so the two pollers present a comparable load profile to the same daemon. */
const SAMPLE_CONCURRENCY = 8;

/**
 * Hard ceiling on stats calls per server per tick.
 *
 * At ~1s each and 8 at a time, 120 containers is ~15s for one box. Past that the
 * sweep is doing more harm than the history is worth, so the remainder is skipped and
 * REPORTED in the job summary — never silently dropped, which would read as "those
 * containers were idle".
 */
const MAX_SAMPLES_PER_SERVER = 120;

export interface UsageSampleSummary {
  /** Index signature so this doubles as the job runner's JobSummary. */
  [key: string]: number;
  servers: number;
  projects: number;
  samples: number;
  /** Containers passed over because the per-server budget ran out. */
  skipped: number;
  /** Servers whose daemon would not answer this tick. */
  unreachable: number;
}

interface Candidate {
  projectId: string;
  slug: string;
  name: string;
  organizationId: string;
  serverId: string | null;
  deploymentId: string;
  deploymentContainerId: string | null;
  meta: DeploymentMeta;
  part: UsagePart;
  config: UsageServiceConfig;
}

/**
 * Bucket key for this tick: epoch minutes floored to RESOURCE_BUCKET_MINUTES.
 *
 * Flooring rather than using the raw minute is what makes the sweep idempotent — a
 * re-run inside the same window lands on the same key and the insert's
 * `onConflictDoNothing` turns it into a no-op instead of a second row.
 */
export function bucketMinuteFor(nowMs: number): number {
  const minute = Math.floor(nowMs / 60_000);
  return Math.floor(minute / RESOURCE_BUCKET_MINUTES) * RESOURCE_BUCKET_MINUTES;
}

interface SampleTarget {
  projectId: string;
  serviceKey: string;
  containerId: string;
}

async function targetsForGroup(
  runtime: RuntimeAdapter,
  candidates: Candidate[],
): Promise<SampleTarget[]> {
  const live =
    runtime.supports("hostContainerQuery") && runtime.listAllContainers
      ? await runtime.listAllContainers().catch(() => null)
      : null;
  const targets: SampleTarget[] = [];
  for (const candidate of candidates) {
    const resolved = await resolveUsageTargets(
      runtime,
      { id: candidate.projectId, slug: candidate.slug, name: candidate.name },
      { containerId: candidate.deploymentContainerId, meta: candidate.meta },
      candidate.config,
      candidate.part,
      live,
    );
    for (const target of resolved) {
      if (target.status === "running" && target.containerId)
        targets.push({
          projectId: candidate.projectId,
          serviceKey: target.serviceId ?? SINGLE_APP_SERVICE_KEY,
          containerId: target.containerId,
        });
    }
  }
  return targets;
}

/**
 * Sample every project's running containers into `resource_usage`.
 *
 * Never throws: a box that won't answer contributes nothing for this tick and is
 * counted as `unreachable`, exactly as the health watch treats one.
 */
export async function runUsageSampleSweep(): Promise<UsageSampleSummary> {
  const startedAt = Date.now();
  const summary: UsageSampleSummary = {
    servers: 0,
    projects: 0,
    samples: 0,
    skipped: 0,
    unreachable: 0,
  };

  const projects = await repos.project.listAllForScan();
  const active = projects.filter((p) => p.activeDeploymentId && !p.disabledAt);
  if (active.length === 0) return summary;

  const deployments = await repos.deployment.findManyById(active.map((p) => p.activeDeploymentId!));

  const serviceMap = await repos.service.listByProjects(active.map((project) => project.id));
  const groups = new Map<string, Candidate[]>();
  for (const p of active) {
    const candidate = deployments.get(p.activeDeploymentId!);
    const dep = activeDeploymentForProject(p, candidate);
    if (!dep) {
      summary.skipped++;
      if (candidate)
        console.warn(
          `[usage-sampler] Ignoring invalid active-deployment binding for project ${p.id}`,
        );
      continue;
    }
    const config = await loadUsageServiceConfig(p.id, dep.id, serviceMap.get(p.id) ?? []);
    for (const { part, meta } of usageRuntimeParts(
      (dep.meta ?? {}) as DeploymentMeta,
      config.services.length,
    )) {
      const key = JSON.stringify([
        watchGroupKey(meta.serverId ?? null, dep.organizationId),
        meta.runtimeMode ?? "docker",
        meta.managedServer?.projectId ?? null,
      ]);
      const list = groups.get(key) ?? [];
      list.push({
        projectId: p.id,
        slug: p.slug,
        name: p.name,
        organizationId: dep.organizationId,
        serverId: meta.serverId ?? null,
        deploymentId: dep.id,
        deploymentContainerId: dep.containerId,
        meta,
        part,
        config,
      });
      groups.set(key, list);
    }
  }

  const minute = bucketMinuteFor(Date.now());
  const rows: NewResourceUsage[] = [];
  const sampledByServer = new Map<string, number>();
  const seenServers = new Set<string>();
  const sampledProjects = new Set<string>();
  const unreachableServers = new Set<string>();

  // SERIAL across servers, deliberately. Each group means an SSH connect plus up to
  // ~15s of daemon-occupying stats calls; starting every box at once on a 50-server
  // control plane is how a metrics sweep becomes an outage. Nothing waits on this.
  for (const [key, candidates] of groups) {
    const { organizationId, serverId } = candidates[0];
    const serverKey = watchGroupKey(serverId, organizationId);
    seenServers.add(serverKey);
    summary.servers = seenServers.size;
    let runtime: RuntimeAdapter | null = null;

    try {
      const resolved = await resolveDeploymentRuntimeForRead({
        meta: candidates[0].meta,
        organizationId,
      });
      runtime = resolved.runtime;

      if (!runtime.supports("usage")) continue;

      const targets = await targetsForGroup(runtime, candidates);
      for (const target of targets) sampledProjects.add(target.projectId);
      summary.projects = sampledProjects.size;

      const spent = sampledByServer.get(serverKey) ?? 0;
      const budgeted = targets.slice(0, Math.max(0, MAX_SAMPLES_PER_SERVER - spent));
      sampledByServer.set(serverKey, spent + budgeted.length);
      const overflow = targets.length - budgeted.length;
      if (overflow > 0) {
        summary.skipped += overflow;
        debug(`sweep:budget server=${key} sampled=${budgeted.length} skipped=${overflow}`);
      }

      const rt = runtime;
      await mapWithLimit(budgeted, SAMPLE_CONCURRENCY, async (t) => {
        try {
          const u = await rt.getUsage(t.containerId);
          rows.push({
            projectId: t.projectId,
            serviceKey: t.serviceKey,
            minute,
            cpuPercent: u.cpuPercent,
            memoryMb: u.memoryMb,
            networkRxBytes: u.networkRxBytes,
            networkTxBytes: u.networkTxBytes,
          });
        } catch (err) {
          // A container that vanished between the listing and the stats call. One
          // missing sample, not a failed sweep.
          debug(`sweep:usage-failed container=${t.containerId} ${safeErrorMessage(err)}`);
        }
      });
    } catch (err) {
      if (isManagedServerIdle(err)) continue;
      // Anything above the per-container loop means the daemon is unreachable, not
      // that something on it is broken.
      unreachableServers.add(serverKey);
      summary.unreachable = unreachableServers.size;
      debug(`sweep:unreachable server=${key} ${safeErrorMessage(err)}`);
    } finally {
      disposeRuntime(runtime);
    }
  }

  // ONE batched insert for the whole sweep, not one per container.
  if (rows.length > 0) {
    await repos.resourceUsage.insertSamples(rows);
    summary.samples = rows.length;
  }

  debug(
    `sweep:done servers=${summary.servers} projects=${summary.projects} ` +
      `samples=${summary.samples} skipped=${summary.skipped} ` +
      `unreachable=${summary.unreachable} bucket=${minute} (${formatDuration(startedAt)})`,
  );
  return summary;
}
