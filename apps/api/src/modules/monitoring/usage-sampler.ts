/**
 * Resource usage sampler — the `resources:sample` system job.
 *
 * Probes every running container on the estate and files a CPU/memory sample into
 * `resource_usage`, so the Monitoring tab can show usage OVER TIME rather than only
 * the live 5-second stream (which discards everything the moment the tab closes).
 *
 * ── Why a separate job rather than extending services:health-watch ──────────
 *
 * The health watch is superficially the obvious host: it already runs every minute,
 * resolves one runtime per (server × org), holds the SSH bridge open, and has each
 * container's project/service identity resolved live. Three things rule it out:
 *
 *   1. It documents "no DB writes at all on a tick where nothing is wrong" — that is
 *      its central cost promise. A sampler writes every tick by definition.
 *   2. `container-events.ts` re-invokes it out of band via `onlyServerKeys` when a
 *      container transitions, so a redeploy fires several runs in a second. Samples
 *      would arrive in bursts at irregular intervals, which is precisely what a time
 *      series must not do.
 *   3. It is gated to `selfhosted` because Oblien exposes no stability probe — but
 *      `CloudRuntime` DOES implement `getUsage`, so riding that gate would deny cloud
 *      projects any history at all.
 *
 * Keeping them apart also means a slow stats sweep can't delay incident detection.
 *
 * ── Cost, which shapes everything below ─────────────────────────────────────
 *
 * `DockerRuntime.getUsage` is `container.stats({stream: false})`, and the daemon must
 * collect two CPU samples to compute a delta — roughly a SECOND per container,
 * against ~2ms for a `docker inspect`. Hence: one runtime and one container listing
 * per server (not per project), serial across servers, bounded fan-out within a
 * server, non-running containers skipped for free, and a hard per-server budget.
 */

import {
  repos,
  SINGLE_APP_SERVICE_KEY,
  RESOURCE_BUCKET_MINUTES,
  type NewResourceUsage,
} from "@repo/db";
import { safeErrorMessage } from "@repo/core";
import type { RuntimeAdapter } from "@repo/adapters";
import { resolveDeploymentRuntimeForRead } from "../../lib/deployment-runtime";
import { mapWithLimit } from "../../lib/map-with-limit";
import { systemDebug, formatDuration } from "../../lib/system-debug";
import { resolveLiveServiceState } from "../services/live-state";
import { watchGroupKey, parseWatchGroupKey } from "./health-watch";

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
  organizationId: string;
  serverId: string | null;
  deploymentId: string;
  deploymentContainerId: string | null;
  meta: unknown;
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

/**
 * Every container in this group worth sampling, with its project/service identity.
 *
 * Two identity paths, and the asymmetry is real rather than defensive — it is the
 * same precedence `project-usage.ts` and `liveContainerIdWithRuntime` already encode:
 *
 *   host can be enumerated (`hostContainerQuery`, i.e. Docker) → resolve LIVE. The
 *     recorded id goes stale on every redeploy and an adopted container never carried
 *     our labels, so trusting the record would sample the wrong thing or nothing.
 *   cannot (Oblien: services are workspaces, there is no `docker ps`) → the recorded
 *     `service_deployment.containerId` IS the workspace id, and is the only identity
 *     available.
 *
 * Gating the whole sweep on `hostContainerQuery` would have silently excluded every
 * cloud project — which is the exact reason this job doesn't ride the health watch.
 */
async function targetsForGroup(
  runtime: RuntimeAdapter,
  candidates: Candidate[],
): Promise<SampleTarget[]> {
  const canEnumerate = runtime.supports("hostContainerQuery") && !!runtime.listAllContainers;
  const live = canEnumerate ? await runtime.listAllContainers!() : null;
  const byId = live ? new Map(live.map((c) => [c.id, c])) : null;

  const serviceMap = await repos.service.listByProjects(candidates.map((c) => c.projectId));
  const out: SampleTarget[] = [];

  for (const candidate of candidates) {
    const services = serviceMap.get(candidate.projectId) ?? [];

    // Single-container project: no service rows, so the deployment's own container is
    // the whole workload, filed under the shared sentinel key.
    if (services.length === 0) {
      const id = candidate.deploymentContainerId;
      // When we can see the host, require RUNNING. When we can't (cloud), a recorded
      // id is all there is — a stopped workspace surfaces as a failed stats call,
      // which costs one skipped sample rather than a wrong one.
      if (id && (!byId || byId.get(id)?.state === "running")) {
        out.push({
          projectId: candidate.projectId,
          serviceKey: SINGLE_APP_SERVICE_KEY,
          containerId: id,
        });
      }
      continue;
    }

    const sdRows = await repos.service.listByDeployment(candidate.deploymentId);
    const trackedIds: Record<string, string | null> = {};
    for (const s of services) {
      trackedIds[s.id] = sdRows.find((r) => r.serviceId === s.id)?.containerId ?? null;
    }

    if (!live) {
      for (const s of services) {
        const id = trackedIds[s.id];
        if (id) out.push({ projectId: candidate.projectId, serviceKey: s.id, containerId: id });
      }
      continue;
    }

    const matches = resolveLiveServiceState({
      services: services.map((s) => ({ id: s.id, name: s.name })),
      live,
      projectId: candidate.projectId,
      slug: candidate.slug,
      trackedIds,
    });

    for (const s of services) {
      const m = matches.get(s.id);
      // Only RUNNING containers. Free (the state came with the listing) and it avoids
      // paying a full second for a container that has no stats to give.
      if (m?.containerId && m.status === "running") {
        out.push({ projectId: candidate.projectId, serviceKey: s.id, containerId: m.containerId });
      }
    }
  }

  return out;
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

  const deployments = await repos.deployment.findManyById(
    active.map((p) => p.activeDeploymentId!),
  );

  // Group by (server, org) — the same key the health watch groups on. This is what
  // makes one runtime and one container listing serve every project on a box, rather
  // than one SSH bridge per project.
  const groups = new Map<string, Candidate[]>();
  for (const p of active) {
    const dep = deployments.get(p.activeDeploymentId!);
    if (!dep) continue;
    const meta = (dep.meta ?? {}) as { serverId?: string };
    const key = watchGroupKey(meta.serverId ?? null, dep.organizationId);
    const list = groups.get(key) ?? [];
    list.push({
      projectId: p.id,
      slug: p.slug,
      organizationId: dep.organizationId,
      serverId: meta.serverId ?? null,
      deploymentId: dep.id,
      deploymentContainerId: dep.containerId,
      meta: dep.meta,
    });
    groups.set(key, list);
  }

  const minute = bucketMinuteFor(Date.now());
  const rows: NewResourceUsage[] = [];

  // SERIAL across servers, deliberately. Each group means an SSH connect plus up to
  // ~15s of daemon-occupying stats calls; starting every box at once on a 50-server
  // control plane is how a metrics sweep becomes an outage. Nothing waits on this.
  for (const [key, candidates] of groups) {
    summary.servers += 1;
    const { organizationId } = parseWatchGroupKey(key);
    let runtime: RuntimeAdapter | null = null;

    try {
      const resolved = await resolveDeploymentRuntimeForRead({
        meta: candidates[0].meta,
        organizationId,
      });
      runtime = resolved.runtime;

      // The ONLY capability gate: a runtime that can't measure has nothing to give.
      // Notably NOT gated on `hostContainerQuery` — that would exclude every cloud
      // project, since Oblien workspaces have no host to enumerate. targetsForGroup
      // handles both identity paths.
      if (!runtime.supports("usage")) continue;

      const targets = await targetsForGroup(runtime, candidates);
      summary.projects += new Set(targets.map((t) => t.projectId)).size;

      const budgeted = targets.slice(0, MAX_SAMPLES_PER_SERVER);
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
      // Anything above the per-container loop means the daemon is unreachable, not
      // that something on it is broken.
      summary.unreachable += 1;
      debug(`sweep:unreachable server=${key} ${safeErrorMessage(err)}`);
    } finally {
      await Promise.resolve(runtime?.dispose?.()).catch(() => {});
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
