/**
 * Push a project's analytics collection switches to the edge that serves it.
 *
 * Right now there is exactly one switch — per-path aggregation ("Top Paths") — and it is
 * the only analytics dimension that is opt-in. Measured on the shipped edge image, the
 * path block costs 1.72 µs per request of the log handler's ~3.0 µs (57%), and 1.38 µs of
 * that is `normalize_path` + `is_static_asset` string work rather than counter writes. It
 * is also the highest-cardinality dimension — up to 2000 keys per domain per day, against
 * ~200 countries and a few dozen statuses — and the largest column in the daily rollup.
 *
 * Everything else the edge records is effectively free, because it is already handling the
 * request. This one is not, so it is a choice.
 *
 * ── Why this pushes, rather than the edge reading a config ───────────────────
 *
 * The flag is read on the hot path, once per request, so it has to be a shared-dict lookup
 * (0.07 µs) — not a file read and certainly not a query. Shared dicts are RAM and are lost
 * whenever nginx restarts, so `project.collect_paths` in Postgres is the source of truth
 * and this runs again on every route apply.
 *
 * ── Why it is not folded into the route-rules push ───────────────────────────
 *
 * `pushProjectRules` iterates the hosts that HAVE rules, plus prior hostnames it needs to
 * clear. A project with no route rules would therefore never receive this flag. Same
 * lifecycle, separate payload.
 */

import { repos } from "@repo/db";
import { safeErrorMessage } from "@repo/core";
import { postEdgeMgmt, resolveProjectTrafficSources } from "../../lib/project-analytics";

/**
 * Push the current setting to every hostname the project serves.
 *
 * `serverId === null` targets the local OpenResty. Best-effort per host: an unreachable
 * box logs and is retried by the next route apply.
 *
 * Pushed for EVERY host on every call, including when disabled — the edge deletes the key
 * on `false`, so turning it off has to reach the box just as much as turning it on does.
 */
export async function pushProjectAnalyticsConfig(
  projectId: string,
  serverId: string | null,
  priorHostnames: string[] = [],
): Promise<void> {
  const [project, domains] = await Promise.all([
    repos.project.findById(projectId),
    repos.domain.listByProject(projectId),
  ]);
  if (!project) return;
  // The cloud edge is not OpenResty and has no shared dict to push into.
  if (project.cloudWorkspaceId) return;

  const paths = project.collectPaths === true;
  const hosts = new Set<string>([
    ...domains.map((d) => d.hostname.toLowerCase()),
    // A hostname whose domain row was removed still has a stale key on the box; clearing
    // it costs one call and avoids collecting for a host the project no longer owns.
    ...priorHostnames.map((h) => h.toLowerCase()),
  ]);
  if (hosts.size === 0) return;

  // ONE round trip carrying every host, not one per host: the reconcile below runs this
  // shape against boxes that may serve dozens of domains, and through an SSH tunnel each
  // round trip is the expensive part.
  await postEdgeMgmt(
    serverId,
    "/analytics/config",
    { hosts: Array.from(hosts).map((host) => ({ host, paths })) },
    // Resolves a null serverId to the "This Server" row; there is no loopback fallback.
    project.organizationId,
  ).catch((err) =>
    console.warn(`[analytics-config] push failed: ${safeErrorMessage(err)}`),
  );
}

/**
 * Re-assert every project's setting on every edge.
 *
 * ── Why this has to exist ────────────────────────────────────────────────────
 *
 * The flag lives in a shared dict, which is RAM. Verified behaviour:
 *
 *   `openresty -s reload`  → the zone SURVIVES. A routing change keeps the flag (and
 *                            re-pushes anyway).
 *   full restart           → the zone is EMPTY. Absent means off, so path collection
 *                            silently stops.
 *
 * A reboot, a `docker restart openship-edge`, or an image upgrade therefore turns
 * collection off on a box while the database still says it is on — and the dashboard reads
 * the database, so it would go on claiming "on" while nothing accumulated. Before this, the
 * only thing that corrected it was the next route apply, which for a stable project can be
 * weeks away.
 *
 * Run from the analytics scrape sweep, which already visits every server every 30 minutes,
 * so drift after a restart is bounded to one sweep instead of to the next deploy. Pushing
 * unconditionally rather than diffing first: the write is idempotent and one round trip per
 * server is cheaper than a read plus a conditional write.
 */
export async function reconcileAnalyticsConfig(): Promise<{ servers: number; hosts: number }> {
  const projects = await repos.project.listAllForScan();
  /**
   * serverId (or "" for the local edge) → its hosts, plus an org to resolve "" with.
   *
   * "" is not a transport: it means the project's edge is this box's "This Server" row, and
   * postEdgeMgmt needs an organizationId to look that row up.
   */
  const byServer = new Map<
    string,
    { hosts: Array<{ host: string; paths: boolean }>; organizationId: string }
  >();

  for (const p of projects) {
    if (p.cloudWorkspaceId) continue;
    // An undeployed project has no edge to configure yet; its first route apply will.
    if (!p.activeDeploymentId) continue;
    const sources = await resolveProjectTrafficSources(p.id).catch(() => []);
    for (const src of sources) {
      if (src.kind !== "self-hosted") continue;
      const key = src.serverId ?? "";
      const slot = byServer.get(key) ?? { hosts: [], organizationId: p.organizationId };
      slot.hosts.push({ host: src.domain.toLowerCase(), paths: p.collectPaths === true });
      byServer.set(key, slot);
    }
  }

  let hosts = 0;
  for (const [key, slot] of byServer) {
    hosts += slot.hosts.length;
    await postEdgeMgmt(
      key === "" ? null : key,
      "/analytics/config",
      { hosts: slot.hosts },
      slot.organizationId,
    ).catch((err) =>
      console.warn(
        `[analytics-config] reconcile failed for ${key || "local"}: ${safeErrorMessage(err)}`,
      ),
    );
  }
  return { servers: byServer.size, hosts };
}
