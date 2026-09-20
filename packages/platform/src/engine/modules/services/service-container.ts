import { repos } from "@repo/db";
import type { RuntimeAdapter } from "@repo/adapters";
import {
  resolveDeploymentPlatform,
  resolveDeploymentRuntimeForRead,
} from "../../lib/deployment-runtime";
import { resolveLiveServiceState } from "./live-state";
import { isRealContainerRef } from "../../lib/container-ref";
import { pickPrimaryServiceId } from "../../lib/public-endpoints";
import type { DeploymentConfigSnapshot } from "../deployments/build.service";

/**
 * The container id RECORDED for one service within a deployment — the DB's view.
 *
 * Authoritative source: the per-service `service_deployment` row (keyed by
 * deployment + service). Falls back to the compose meta matched by name for
 * older deploys that predate per-service rows.
 *
 * It NEVER falls back to `deployment.containerId`: for a compose deploy that is
 * the PRIMARY service's container (e.g. postgres), so a miss there would
 * silently resolve the WRONG container — wrong shell, wrong backup/restore
 * target. Returns null when the service has no container yet (still deploying).
 *
 * This is a RECORD, not a fact: the container it names can be gone (a redeploy
 * replaced it, an operator removed it), and then every consumer gets docker's
 * "no such container" 404. Prefer `liveContainerIdForService` wherever a runtime
 * can be resolved — it verifies the id against the host first.
 */
export async function containerIdForService(
  dep: { id: string; meta?: unknown },
  service: { id: string; name: string },
): Promise<string | null> {
  const sdRows = await repos.service.listByDeployment(dep.id);
  const sdRow = sdRows.find((r) => r.serviceId === service.id);
  const meta = (dep.meta ?? {}) as {
    composeServices?: Array<{ name: string; containerId?: string }>;
  };
  return (
    sdRow?.containerId ??
    meta.composeServices?.find((s) => s.name === service.name)?.containerId ??
    null
  );
}

/** A service is a CONTAINER (Docker, on a server/local target) or an Oblien
 *  WORKSPACE (cloud) — never the app's bare host process. Resolve the platform
 *  with the runtime pinned to Docker so service start/stop/logs target the real
 *  service runtime even when the project's app deploys "bare". Cloud stays on
 *  CloudRuntime (runtimeMode is irrelevant there). */
export async function resolveServicePlatform(
  project: { organizationId: string },
  dep: { meta: unknown },
) {
  const snapshot = { ...(dep.meta as DeploymentConfigSnapshot), runtimeMode: "docker" as const };
  return resolveDeploymentPlatform(snapshot, { organizationId: project.organizationId });
}

/**
 * Read-only runtime for a service — thin alias over the shared
 * `resolveDeploymentRuntimeForRead` (which owns the target decision and the
 * runtime-vs-platform split), adapted to the (project, dep) shape service code
 * already passes around and degrading to null so a read never throws.
 */
export async function resolveServiceRuntimeForRead(
  project: { organizationId: string },
  dep: { meta: unknown },
): Promise<RuntimeAdapter | null> {
  return resolveDeploymentRuntimeForRead({
    meta: dep.meta,
    organizationId: project.organizationId,
  })
    .then((r) => r.runtime)
    .catch(() => null);
}

/** The runtime surface live identity resolution needs — anything that can list
 *  the host's containers. Keeps callers from importing the whole adapter type. */
export interface HostContainerLister {
  supports(cap: "hostContainerQuery"): boolean;
  listAllContainers?(): Promise<
    Array<{
      id: string;
      names: string[];
      image?: string;
      state: string;
      status?: string;
      labels: Record<string, string>;
      ports?: Array<{ privatePort: number; publicPort?: number; type?: string }>;
      ip?: string;
    }>
  >;
}

/**
 * Verify one service's container id against the host, using a runtime the caller
 * ALREADY holds (no second platform resolution / SSH connect).
 *
 * Returns the live container id; null when the host answered and nothing matches
 * (the container is gone); `tracked` when the runtime can't enumerate containers
 * (cloud) or the query failed — never worse than the recorded value.
 */
export async function liveContainerIdWithRuntime(
  runtime: HostContainerLister | null | undefined,
  args: { service: { id: string; name: string }; projectId: string; slug: string; tracked: string | null },
): Promise<string | null> {
  return (await liveContainerStateWithRuntime(runtime, args)).containerId;
}

/**
 * The same resolution, keeping the RUNNING fact instead of discarding it.
 *
 * `resolveLiveServiceState` already computes a status for the container it matched;
 * every caller above threw it away, so consumers that need "can I exec in here"
 * — a logical database dump, above all — had only an id, and an id is also what a
 * stopped container has.
 *
 * `running: null` means we could not ask (no host query, unreachable host, failed
 * enumeration). Never conflate that with `false`: unknown must let a caller proceed,
 * or the cloud and bare sources lose their dumps.
 *
 * Only `stopped` reports `false`. That status is docker's
 * created/exited/paused/removing set — exactly the states where `docker exec`
 * refuses — while an unhealthy-but-running container stays `true`, because a dump
 * against it works.
 */
export async function liveContainerStateWithRuntime(
  runtime: HostContainerLister | null | undefined,
  args: { service: { id: string; name: string }; projectId: string; slug: string; tracked: string | null },
): Promise<{ containerId: string | null; running: boolean | null }> {
  if (!runtime?.supports("hostContainerQuery") || !runtime.listAllContainers) {
    return { containerId: args.tracked, running: null };
  }
  const containers = await runtime.listAllContainers().catch(() => null);
  if (!containers) return { containerId: args.tracked, running: null };
  const match = resolveLiveServiceState({
    services: [args.service],
    live: containers,
    projectId: args.projectId,
    slug: args.slug,
    trackedIds: { [args.service.id]: args.tracked },
  }).get(args.service.id);
  if (!match?.containerId) return { containerId: null, running: null };
  return { containerId: match.containerId, running: match.status !== "stopped" };
}

/**
 * The container a PROJECT-level question means — "its logs", "its container info",
 * "its resource usage" — for the deployment `dep`.
 *
 * `dep.containerId` cannot answer it for a multi-service release: it holds ONE
 * service's container, chosen without reference to which service the project's URL
 * points at, so it named the database an app `dependsOn` (#498). It can also hold
 * the `"compose"` sentinel, which is no container at all. So the primary service is
 * picked the way the access URL is picked, and its container read from `dep`'s own
 * rows.
 *
 * Resolved LIVE against the host, and the row healed, for the ACTIVE release only.
 * The live matcher keys on identity (project+service label) rather than deployment,
 * so it answers with whatever runs NOW — right for the current release, wrong for a
 * historical one, whose recorded container is the point of asking. These endpoints
 * accept any deployment id, so healing unconditionally would rewrite history from a
 * GET.
 *
 * Null means the primary service's container is genuinely gone.
 */
export async function livePrimaryContainerId(
  runtime: HostContainerLister | null | undefined,
  dep: { id: string; projectId: string; containerId: string | null },
): Promise<string | null> {
  const recorded = isRealContainerRef(dep.containerId) ? dep.containerId : null;
  const [project, rows] = await Promise.all([
    repos.project.findById(dep.projectId).catch(() => null),
    repos.service.listByDeployment(dep.id).catch(() => []),
  ]);
  // THIS release's own rows decide whether it was a service deploy. The project's
  // current service list would misread a single-app release that later gained a
  // sidecar, and answer for the sidecar.
  if (!project || rows.length === 0) return recorded;

  const [services, domainRows] = await Promise.all([
    repos.service.listByProject(dep.projectId).catch(() => []),
    repos.domain.listByProject(dep.projectId).catch(() => []),
  ]);
  const candidates = services.filter(
    (svc) => svc.enabled && rows.some((r) => r.serviceId === svc.id && r.containerId),
  );
  const primaryId = pickPrimaryServiceId(candidates, domainRows);
  const svc = candidates.find((s) => s.id === primaryId);
  const row = svc ? rows.find((r) => r.serviceId === svc.id) : undefined;
  if (!svc || !row?.containerId) return recorded;

  if (project.activeDeploymentId !== dep.id) return row.containerId;

  const live = await liveContainerIdWithRuntime(runtime, {
    service: { id: svc.id, name: svc.name },
    projectId: dep.projectId,
    slug: project.slug,
    tracked: row.containerId,
  });
  if (live && live !== row.containerId) {
    await repos.service.updateServiceDeployment(row.id, { containerId: live }).catch(() => {});
  }
  return live;
}

/**
 * The container id a service ACTUALLY runs as, verified against the host.
 *
 * The recorded id goes stale constantly — a redeploy replaces the container, a
 * migration adopts one that was created by something else, an operator recreates
 * a compose stack by hand. Consumers that trusted the record then failed with
 * docker's "no such container" (service logs, terminal, backup, volume sizes) or
 * silently provisioned a DUPLICATE container next to the running one.
 *
 * So: ask the host what exists, match it to this service by identity
 * (`openship.project`+`openship.service` label → canonical `openship-<slug>-<svc>`
 * name → recorded id → compose labels — see live-state.ts), and return that.
 *
 * - live query succeeded, no match → null (the container really is gone; callers
 *   surface "not deployed" instead of a confusing docker 404)
 * - live query unavailable/failed (cloud runtime, unreachable host) → the
 *   recorded id, so behaviour is never WORSE than before
 */
export async function liveContainerIdForService(
  project: { slug: string; organizationId: string },
  dep: { id: string; meta?: unknown },
  service: { id: string; name: string },
  opts?: { projectId?: string },
): Promise<string | null> {
  return (await liveContainerForService(project, dep, service, opts)).containerId;
}

/**
 * `liveContainerIdForService` plus the running fact — see
 * `liveContainerStateWithRuntime` for why the two travel together and why
 * `running: null` (unknown) is not `false`.
 */
export async function liveContainerForService(
  project: { slug: string; organizationId: string },
  dep: { id: string; meta?: unknown },
  service: { id: string; name: string },
  opts?: { projectId?: string },
): Promise<{ containerId: string | null; running: boolean | null }> {
  const tracked = await containerIdForService(dep, service);
  const projectId = opts?.projectId;

  const runtime = await resolveServiceRuntimeForRead(project, { meta: dep.meta });
  if (!runtime) return { containerId: tracked, running: null };
  try {
    return await liveContainerStateWithRuntime(runtime, {
      service: { id: service.id, name: service.name },
      projectId: projectId ?? "",
      slug: project.slug,
      tracked,
    });
  } finally {
    void Promise.resolve(runtime.dispose?.()).catch(() => {});
  }
}
