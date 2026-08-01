/**
 * @module edge-orphans.service
 *
 * The I/O half of the edge-orphan sweep: read what the local edge serves, read
 * what Openship tracks, and hand both to the pure diff in `@repo/core`.
 *
 * Why an orphan exists at all — record-only delete ("Remove from Openship only")
 * promises the workload keeps running, which explicitly includes NOT removing the
 * route. So the vhost outlives its DB rows by design. A port-based leftover 502s
 * and announces itself; a STATIC leftover keeps serving the old project's files
 * with a 200, on a hostname that may since have been handed to someone else, and
 * nothing looked for it.
 *
 * Read-only except for `removeEdgeOrphan`, which takes ONE named hostname. There
 * is deliberately no sweep-and-delete: that would break the guarantee that
 * created the orphan in the first place.
 */

import { repos } from "@repo/db";
import {
  findUntrackedEdgeSites,
  mailServerRouteHostnames,
  normalizeServedHostname,
  type UntrackedEdgeSite,
} from "@repo/core";
import { safeErrorMessage } from "@repo/core";
import { env } from "../config/env";
import { platform } from "./controller-helpers";

export interface EdgeOrphanScan {
  /**
   * False when there's nothing to compare against — no edge on this box, or the
   * edge is a FOREIGN proxy we don't own. Distinct from `orphans: []`, which
   * means we looked and everything is accounted for. A caller must not render
   * "all clear" for the unsupported case.
   */
  scanned: boolean;
  reason?: string;
  orphans: UntrackedEdgeSite[];
  /** Hostname count we compared against, for the "we did look" signal in the UI. */
  knownCount: number;
}

/**
 * Every hostname Openship believes it should be serving on this box.
 *
 * Assembled from the SAME producers that write vhosts, so the sweep doesn't flag
 * live infrastructure:
 *   - domain rows                → project routes (the overwhelming majority)
 *   - mail-server route plan     → mail./api.mail./autodiscover. per mail domain,
 *                                  registered straight from the plan with no
 *                                  domain row of their own
 *   - OPENSHIP_PUBLIC_URL host   → the managed-edge vhost fronting the dashboard
 *
 * A producer added later without being added here shows up as an orphan. That is
 * the safe direction — the report is advisory and removal is per-hostname and
 * manual — but it IS noise, so a new direct `registerRoute` caller should add its
 * hostnames here.
 */
export async function collectKnownHostnames(): Promise<string[]> {
  const out = new Set<string>();

  for (const h of await repos.domain.listAllHostnames().catch(() => [])) {
    const n = normalizeServedHostname(h);
    if (n) out.add(n);
  }

  // Mail routes come from the plan builder, not the domain table.
  for (const server of await repos.mailServer.list().catch(() => [])) {
    const d = normalizeServedHostname(server.domain ?? "");
    if (!d) continue;
    for (const h of mailServerRouteHostnames(d)) out.add(normalizeServedHostname(h));
  }

  // The dashboard's own vhost, when this box runs the managed edge.
  const publicHost = hostnameFromUrl(env.OPENSHIP_PUBLIC_URL);
  if (publicHost) out.add(publicHost);

  return [...out];
}

function hostnameFromUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return normalizeServedHostname(new URL(value).hostname) || null;
  } catch {
    return null;
  }
}

/**
 * Compare the local edge's vhosts against what Openship tracks.
 *
 * Fails SOFT in every direction: no edge, a foreign edge, or a read error all
 * return `scanned: false` with a reason rather than throwing. This runs from a
 * background sweep and a settings page; neither should break because a box has no
 * OpenResty on it.
 */
export async function scanEdgeOrphans(): Promise<EdgeOrphanScan> {
  const empty = (reason: string): EdgeOrphanScan => ({
    scanned: false,
    reason,
    orphans: [],
    knownCount: 0,
  });

  let api: Awaited<ReturnType<typeof import("@repo/adapters").edgeProxy>>;
  try {
    const { edgeProxy, createExecutor } = await import("@repo/adapters");
    api = await edgeProxy(createExecutor());
  } catch (err) {
    return empty(`Could not read the edge: ${safeErrorMessage(err)}`);
  }
  if (!api) return empty("No reverse proxy detected on this machine.");
  // A foreign proxy's vhosts are not ours to call orphaned — the operator may run
  // unrelated sites on it, and the takeover/import flow is what reasons about those.
  if (!api.ours) {
    return empty(`The edge on this machine is ${api.kind}, not Openship's — nothing to reconcile.`);
  }

  const [scan, knownHostnames] = await Promise.all([
    api.listSites().catch(() => null),
    collectKnownHostnames(),
  ]);
  if (!scan) return empty("The edge's site list could not be read.");

  return {
    scanned: true,
    orphans: findUntrackedEdgeSites({ sites: scan.sites, knownHostnames }),
    knownCount: knownHostnames.length,
  };
}

/**
 * Is a vhost already serving `hostname` that Openship has no record of?
 *
 * Used by the domain-claim path. Returns null when the hostname is fine to claim
 * (nothing there, already tracked, foreign edge, or unreadable) — the claim must
 * never be blocked by this. Re-claiming a hostname whose forgotten vhost is still
 * up is the NORMAL recovery flow, and the next deploy rewrites the vhost wholesale
 * (registerRoute replaces the whole file). The point is only to say so out loud.
 */
export async function untrackedSiteFor(hostname: string): Promise<UntrackedEdgeSite | null> {
  const host = normalizeServedHostname(hostname);
  if (!host) return null;
  try {
    const { edgeProxy, createExecutor } = await import("@repo/adapters");
    const api = await edgeProxy(createExecutor());
    if (!api?.ours) return null;

    const site = await api.siteFor(host).catch(() => null);
    if (!site) return null;

    // Reuse the same rule the sweep uses, so the claim warning and the orphan
    // list can never disagree about what counts as untracked.
    const [found] = findUntrackedEdgeSites({
      sites: [site],
      knownHostnames: await collectKnownHostnames(),
    });
    return found ?? null;
  } catch {
    return null; // advisory only — never fail a claim on this
  }
}

/**
 * Remove ONE named orphan's vhost.
 *
 * Guarded: re-scans and refuses unless `hostname` is still reported as untracked.
 * Without that check this would be a "delete any vhost by name" endpoint, and a
 * stale dashboard list could take down a live domain that got claimed between the
 * scan and the click.
 *
 * The static FILES are left on disk. They may be a rollback target for a project
 * that still exists elsewhere, and deleting served content is not what "stop
 * serving this hostname" asks for.
 */
export async function removeEdgeOrphan(
  hostname: string,
): Promise<{ removed: boolean; reason?: string }> {
  const host = normalizeServedHostname(hostname);
  if (!host) return { removed: false, reason: "Invalid hostname." };

  const scan = await scanEdgeOrphans();
  if (!scan.scanned) return { removed: false, reason: scan.reason ?? "Edge not readable." };

  const match = scan.orphans.find((o) => o.hostnames.includes(host));
  if (!match) {
    return {
      removed: false,
      reason: `${host} is not an untracked vhost on this machine — refusing to remove it.`,
    };
  }

  try {
    await platform().routing.removeRoute(match.hostname);
    return { removed: true };
  } catch (err) {
    return { removed: false, reason: safeErrorMessage(err) };
  }
}
