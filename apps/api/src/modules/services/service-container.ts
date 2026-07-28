import { repos } from "@repo/db";
import type { RuntimeAdapter } from "@repo/adapters";
import {
  resolveDeploymentPlatform,
  resolveDeploymentRuntimeForRead,
} from "../../lib/deployment-runtime";
import { resolveLiveServiceState } from "./live-state";
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
  if (!runtime?.supports("hostContainerQuery") || !runtime.listAllContainers) return args.tracked;
  const containers = await runtime.listAllContainers().catch(() => null);
  if (!containers) return args.tracked;
  return (
    resolveLiveServiceState({
      services: [args.service],
      live: containers,
      projectId: args.projectId,
      slug: args.slug,
      trackedIds: { [args.service.id]: args.tracked },
    }).get(args.service.id)?.containerId ?? null
  );
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
  const tracked = await containerIdForService(dep, service);
  const projectId = opts?.projectId;

  const runtime = await resolveServiceRuntimeForRead(project, { meta: dep.meta });
  if (!runtime) return tracked;
  try {
    return await liveContainerIdWithRuntime(runtime, {
      service: { id: service.id, name: service.name },
      projectId: projectId ?? "",
      slug: project.slug,
      tracked,
    });
  } finally {
    void Promise.resolve(runtime.dispose?.()).catch(() => {});
  }
}
