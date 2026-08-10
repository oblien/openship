/**
 * Link the control plane's OWN containers to its self-app project.
 *
 * `openship up` on Linux runs Openship as a compose stack (api, dashboard,
 * postgres, redis, edge). The self-app project was registered as a bare row with
 * no services, so its Apps & Services tab read "No apps or services yet" while
 * five containers of Openship were running right there — and nothing in the
 * dashboard could show their state, logs, or shell.
 *
 * This reconstructs the missing half: one `service` row per compose service, plus
 * the `service_deployment` rows that bind them to the adopt deployment. From
 * there the normal machinery takes over — the live-state read resolves each
 * container by identity (compose labels / tracked id — see
 * modules/services/live-state.ts), so status, logs and terminal work exactly as
 * they do for any deployed compose project.
 *
 * Idempotent and best-effort: it runs on self-register AND on every boot
 * reconcile, so existing installs are backfilled, and any failure (no docker
 * socket, bare install, permissions) leaves the project exactly as it was.
 */

import { repos } from "@repo/db";
import { safeErrorMessage } from "@repo/core";
import { DockerRuntime, type DockerContainerSummary } from "@repo/adapters";

/** The stack's own services, in the order they should read in the UI. `edge` is
 *  included — it's the thing holding 80/443, and an operator debugging a routing
 *  problem needs its logs as much as the api's. */
const SERVICE_ORDER = ["api", "dashboard", "edge", "postgres", "redis"];

/** Compose services that are infrastructure, not user-editable workloads: they
 *  exist so the UI can show state/logs, but nothing should offer to rebuild them
 *  from source. */
const INTERNAL_SERVICES = new Set(["postgres", "redis", "edge"]);

/** First published host port, if any (`0.0.0.0:3001->3001/tcp` → 3001). */
function publishedPort(c: DockerContainerSummary): number | null {
  for (const p of c.ports ?? []) if (p.publicPort) return p.publicPort;
  return null;
}

/** Compose spec strings for a container's published ports (`3001:3001`). */
export function portSpecs(c: DockerContainerSummary): string[] {
  const seen = new Set<string>();
  for (const p of c.ports ?? []) {
    if (p.publicPort) seen.add(`${p.publicPort}:${p.privatePort}`);
  }
  return [...seen];
}

/**
 * Find the compose stack that IS this Openship install. Keyed off the api +
 * dashboard services being present under one compose project, so an unrelated
 * stack on the same host can never be adopted as the control plane.
 */
export function findOwnStack(containers: DockerContainerSummary[]): DockerContainerSummary[] {
  const byProject = new Map<string, DockerContainerSummary[]>();
  for (const c of containers) {
    if (!c.composeProject || !c.composeService) continue;
    const list = byProject.get(c.composeProject) ?? [];
    list.push(c);
    byProject.set(c.composeProject, list);
  }
  for (const [, members] of byProject) {
    const services = new Set(members.map((m) => m.composeService));
    if (services.has("api") && services.has("dashboard")) return members;
  }
  return [];
}

/**
 * Create/refresh the self-app's service rows from its own running containers.
 * Returns the number of services linked (0 = nothing to do).
 */
export async function linkSelfAppServices(
  projectId: string,
  deploymentId: string | null,
): Promise<number> {
  let runtime: DockerRuntime;
  try {
    runtime = await DockerRuntime.create();
  } catch {
    return 0; // no docker reachable (bare install / no socket) → nothing to link
  }

  try {
    const containers = await runtime.listAllContainers();
    const own = findOwnStack(containers);
    if (own.length === 0) return 0;

    const existing = await repos.service.listByProject(projectId);
    const byName = new Map(existing.map((s) => [s.name, s]));
    let linked = 0;

    for (const container of own) {
      const name = container.composeService!;
      const sortIndex = SERVICE_ORDER.indexOf(name);
      const spec = {
        name,
        image: container.image,
        ports: portSpecs(container),
        // The edge owns 80/443 and the dashboard/api are reached through it, so
        // no self-app service publishes a managed route of its own here; the
        // project's own domain (Domains & Routes) is the public entry point.
        exposed: false,
        enabled: true,
        kind: "compose" as const,
        sortOrder: sortIndex === -1 ? SERVICE_ORDER.length : sortIndex,
        // Infra services must never be offered a source rebuild.
        ...(INTERNAL_SERVICES.has(name) ? { build: null, dockerfile: null } : {}),
      };

      const row = byName.get(name);
      const serviceId = row?.id ?? (await repos.service.create({ projectId, ...spec })).id;
      if (row) {
        // Keep the image/ports fresh across upgrades (the tag moves every
        // release) without touching anything the operator may have edited.
        await repos.service
          .update(row.id, { image: spec.image, ports: spec.ports, sortOrder: spec.sortOrder })
          .catch(() => {});
      }
      linked += 1;

      // Bind to the adopt deployment so the Services panel has an identity hint
      // per service. `status` is deploy-time bookkeeping only — liveness is read
      // from the host on every request.
      if (deploymentId) {
        await repos.service
          .upsertServiceDeployment({
            deploymentId,
            serviceId,
            serviceName: name,
            containerId: container.id,
            status: container.state === "running" ? "success" : "failure",
            imageRef: container.image ?? null,
            hostPort: publishedPort(container),
            ip: container.ip ?? null,
          })
          .catch(() => {});
      }
    }
    // Heal an already-seeded phantom: the #231 app-materialize backfill once
    // created a `monorepo` row named after the slug on this app project — a
    // PUBLIC service on the dashboard port that matches no container (shows
    // "Stopped") and carries a stray {slug}-{slug} free-subdomain route. The
    // self-app's only real units are the compose rows linked above, so drop any
    // monorepo leftover. (The dashboard can't: assertNotControlPlaneService
    // blocks deleting control-plane services.) Prevention lives in
    // materializeAppServiceRow; this clears instances that predate that guard.
    const stale = await repos.service.listByProjectKind(projectId, "monorepo").catch(() => []);
    for (const row of stale) {
      await repos.service.remove(row.id).catch(() => {});
    }

    return linked;
  } catch (err) {
    console.warn(`[self-services] linking skipped: ${safeErrorMessage(err)}`);
    return 0;
  } finally {
    await runtime.dispose().catch(() => {});
  }
}
