import { safeErrorMessage } from "@repo/core";
import { cloudClient } from "./cloud/client";
import { resolveEdgeTargetHost } from "./edge-target";

const NO_CLOUD_MEMBER =
  "Cannot sync edge proxy: no member of this organization has linked Openship Cloud";

/**
 * Ensure an Oblien edge proxy exists for a managed deploy slug.
 *
 * Sends slug + target host to the SaaS, which forwards to Oblien with the org's
 * namespace token. Oblien resolves + pins the target IP (its SSRF guard) and
 * scopes the slug to the namespace — no ownership challenge needed, so this is
 * a plain best-effort sync.
 */
export async function ensureManagedEdgeProxy(
  organizationId: string,
  slug: string,
  opts?: { serverId?: string },
): Promise<void> {
  if (!slug.trim()) return;

  // The edge target MUST be a public host Oblien can reach on :80 — NOT the deploy
  // server's display `sshHost` (which is `127.0.0.1` for an isLocal box with no
  // public URL, making Oblien proxy to its own loopback → 404). resolveEdgeTargetHost
  // returns null (with a reason) rather than a dead loopback so we surface an
  // actionable warning instead of silently wiring a broken route.
  const { host, reason } = await resolveEdgeTargetHost(organizationId, opts?.serverId);
  if (!host) {
    throw new Error(`Cannot configure edge proxy: ${reason ?? "target host could not be resolved"}`);
  }
  const result = await cloudClient({ organizationId }).edgeProxy.sync({ slug, target: host });
  if (!result) throw new Error(NO_CLOUD_MEMBER);
}

export interface ManagedEdgeTarget {
  /** Full managed hostname, e.g. `myapp.opsh.io` — used in log/warning text. */
  hostname: string;
  /** The `<slug>` the SaaS edge keys the route on. */
  subdomain: string;
}

/**
 * Sync every managed (*.opsh.io) route for a project through the SaaS edge,
 * best-effort. Shared by the deploy pipeline (post-deploy) and the standalone
 * "retry routing" action so the loop + failure collection live in one place.
 * Never throws — collects per-target failures (the app is already live locally;
 * only the free URL is affected).
 */
export async function syncManagedEdgeRoutes(
  targets: ManagedEdgeTarget[],
  opts: { organizationId: string; serverId?: string; onLog?: (msg: string, level?: "warn") => void },
): Promise<{ failures: string[] }> {
  const failures: string[] = [];
  for (const tgt of targets) {
    opts.onLog?.(`Syncing managed edge proxy for ${tgt.hostname}...\n`);
    try {
      await ensureManagedEdgeProxy(opts.organizationId, tgt.subdomain, { serverId: opts.serverId });
    } catch (err) {
      const reason = safeErrorMessage(err);
      failures.push(`${tgt.hostname} (${reason})`);
      opts.onLog?.(
        `Warning: could not sync managed edge proxy for ${tgt.hostname}: ${reason}. ` +
          `The deployment is live; this only affects the free ${tgt.hostname} URL.\n`,
        "warn",
      );
    }
  }
  return { failures };
}

/**
 * Tear down every managed (*.opsh.io) edge route for a set of freed slugs,
 * best-effort. The delete-side counterpart to `syncManagedEdgeRoutes`: dropping
 * a free domain must release its slug→target route on Openship Cloud's edge, or
 * the old URL keeps resolving and the slug stays taken. Never throws — a stale
 * edge route is cosmetic and must never fail a domain edit; returns per-slug
 * failures for the caller to log.
 */
export async function deregisterManagedEdgeRoutes(
  slugs: string[],
  opts: { organizationId: string },
): Promise<{ failures: string[] }> {
  const failures: string[] = [];
  for (const slug of slugs) {
    if (!slug.trim()) continue;
    try {
      await cloudClient({ organizationId: opts.organizationId }).edgeProxy.deregister(slug);
    } catch (err) {
      failures.push(`${slug} (${safeErrorMessage(err)})`);
    }
  }
  return { failures };
}

/** The user-facing "free routing didn't sync" message. `retryHint` is the
 *  closing call-to-action ("redeploy to retry" from a deploy, "retry" from the
 *  standalone retry action). */
export function edgeUnsyncedWarning(failures: string[], retryHint: string): string {
  return (
    `Deployed, but the free domain routing didn't sync for ${failures.join(", ")}. ` +
    `The app is live on the server; the free .opsh.io URL won't resolve until the edge route is created. ` +
    `Check that the server is reachable from Openship Cloud on port 80, then ${retryHint}.`
  );
}
