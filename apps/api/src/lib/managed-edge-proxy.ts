import type { Platform } from "@repo/adapters";
import { safeErrorMessage } from "@repo/core";
import { cloudClient } from "./cloud/client";
import { isTargetUnverified } from "./cloud/request-error";
import { canonicalEdgeTarget, resolveEdgeTargetHost } from "./edge-target";
import { ensureTargetVerified } from "./edge-target-verify";

const NO_CLOUD_MEMBER =
  "Cannot sync edge proxy: no member of this organization has linked Openship Cloud";

/**
 * A managed-edge failure the caller has to answer differently.
 *
 * The three cases read alike as plain Errors and are not alike at all: an
 * unresolvable target is the operator's config (400), a missing Cloud link is a
 * setup step (409), and an upstream refusal is neither (502). The setup wizard maps
 * these onto its HTTP response, which is why the funnel has to distinguish them
 * rather than throwing one opaque Error — the reason the wizard used to keep its own
 * copy of this call.
 */
export class ManagedEdgeError extends Error {
  readonly status: 400 | 409 | 502;
  constructor(message: string, status: 400 | 409 | 502) {
    super(message);
    this.name = "ManagedEdgeError";
    this.status = status;
  }
}

/**
 * Ensure an Openship Cloud edge proxy exists for a managed deploy slug.
 *
 * THE one funnel. Sends slug + target host to the SaaS, which forwards to Cloud with
 * the org's namespace token; Cloud scopes the slug to the namespace and pins the
 * route to the target's validated IP.
 *
 * Cloud refuses to route to a target whose control hasn't been proven, so a
 * `target_unverified` refusal is not a failure — it is the signal to prove it. We
 * verify (issue a challenge, serve it on this box's edge, ask Cloud to probe) and
 * retry the sync exactly ONCE. Everything about that is invisible on the happy path:
 * an already-proven target never touches the verification code.
 *
 * Returns the target it wired (and any caveat about it) so the caller can SHOW
 * that. The target is the whole substance of this route and it used to be
 * invisible: on the box, in the deploy log, and in the Domains tab alike. An
 * operator whose free URL didn't work had nowhere to see that it had been
 * pointed at a hostname rather than their server.
 */
export async function ensureManagedEdgeProxy(
  organizationId: string,
  slug: string,
  opts?: {
    serverId?: string;
    /** A candidate address for THIS box, from setup's `--public-url`. A candidate,
     *  not an override — it gets the same guards as every other source. */
    preferHost?: string;
    /** Routing for the box that is the target, when the caller already holds it.
     *  Only used if a verification turns out to be needed. */
    routing?: Platform["routing"];
    onLog?: (message: string, level?: "warn") => void;
  },
): Promise<{ target: string; warning?: string }> {
  if (!slug.trim()) return { target: "" };

  // The edge target MUST be a public host Cloud can reach on :80 — NOT the deploy
  // server's display `sshHost` (which is `127.0.0.1` for an isLocal box with no
  // public URL, making Cloud proxy to its own loopback → 404). resolveEdgeTargetHost
  // returns null (with a reason) rather than a dead loopback so we surface an
  // actionable warning instead of silently wiring a broken route.
  const { host, reason, warning } = await resolveEdgeTargetHost(organizationId, {
    serverId: opts?.serverId,
    ...(opts?.preferHost ? { preferHost: opts.preferHost } : {}),
  });
  if (!host) {
    throw new ManagedEdgeError(
      `Cannot configure edge proxy: ${reason ?? "target host could not be resolved"}`,
      400,
    );
  }

  const client = cloudClient({ organizationId });
  const sync = async () => {
    const result = await client.edgeProxy.sync({ slug, target: host });
    if (!result) throw new ManagedEdgeError(NO_CLOUD_MEMBER, 409);
    return result;
  };

  try {
    await sync();
  } catch (err) {
    if (!isTargetUnverified(err)) {
      throw err instanceof ManagedEdgeError ? err : new ManagedEdgeError(safeErrorMessage(err), 502);
    }
    // Prove control, then retry once. `canonicalEdgeTarget` is the SAME normalizer
    // the SaaS applies before calling Cloud, so what we verify is what gets routed.
    opts?.onLog?.(`Proving this server controls ${host} for Openship Cloud routing...\n`);
    const verdict = await ensureTargetVerified(organizationId, canonicalEdgeTarget(host), {
      ...(opts?.serverId ? { serverId: opts.serverId } : {}),
      ...(opts?.routing ? { routing: opts.routing } : {}),
      ...(opts?.onLog ? { onLog: opts.onLog } : {}),
    });
    if (!verdict.verified) {
      throw new ManagedEdgeError(
        `Openship Cloud won't route to ${host} until it can confirm this server controls it: ` +
          `${verdict.reason ?? "verification did not complete"}`,
        502,
      );
    }
    await sync();
  }

  return { target: host, warning };
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
  opts: {
    organizationId: string;
    serverId?: string;
    onLog?: (msg: string, level?: "warn") => void;
  },
): Promise<{ failures: string[] }> {
  const failures: string[] = [];
  for (const tgt of targets) {
    opts.onLog?.(`Syncing managed edge proxy for ${tgt.hostname}...\n`);
    try {
      const { target, warning } = await ensureManagedEdgeProxy(opts.organizationId, tgt.subdomain, {
        serverId: opts.serverId,
        ...(opts.onLog ? { onLog: opts.onLog } : {}),
      });
      // Name the target. It's the one fact that explains whether this URL will
      // serve the app, and the operator could not see it anywhere before.
      opts.onLog?.(`  ${tgt.hostname} → http://${target} (Openship Cloud edge → this server)\n`);
      if (warning) opts.onLog?.(`Note: ${tgt.hostname} is ${warning}\n`, "warn");
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
