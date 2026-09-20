/**
 * Canonical-redirect rules — THE gate for `domain.redirectTo` / `redirectStatus`.
 *
 * A redirect is the cheapest possible way to break a site badly, so every path
 * that can set one (add-domain, the endpoints save, the deploy-time route sync)
 * goes through here rather than trusting its own caller:
 *
 *   • target must be ANOTHER hostname of the SAME project. An arbitrary target
 *     turns a domain the operator verified — and holds a valid certificate for —
 *     into an open redirect, which is exactly what phishing wants to borrow.
 *   • no self-target, and no cycles. `a → b → a` means every request to either
 *     host bounces until the browser gives up: a total outage produced by a
 *     two-field edit, with nothing in the logs to explain it.
 *   • status restricted to the four redirect codes that make sense here.
 *
 * Self-hosted only. On Openship Cloud the managed edge owns routing, and its
 * redirect primitive can't be shown to preserve the original path + query, so
 * `assertRedirectSupported` refuses instead of silently shipping a redirect that
 * drops half the URL.
 */

import {
  DEFAULT_REDIRECT_STATUS,
  REDIRECT_STATUSES,
  ValidationError,
  normalizeCustomHostname,
  resolveRedirectStatus,
  type RedirectStatus,
} from "@repo/core";

export { DEFAULT_REDIRECT_STATUS, REDIRECT_STATUSES, resolveRedirectStatus };
export type { RedirectStatus };

export interface RedirectInput {
  redirectTo?: string | null;
  redirectStatus?: number | null;
}

/** One host in the set a redirect is validated against. */
export interface RedirectHost {
  hostname: string;
  redirectTo?: string | null;
}

/**
 * Normalize a redirect target, or null for "no redirect". Rejects a status that
 * isn't a redirect code outright rather than quietly rewriting it — a caller that
 * asked for 200 has a bug, and answering 301 instead would hide it.
 */
export function normalizeRedirect(input: RedirectInput): {
  redirectTo: string | null;
  redirectStatus: RedirectStatus | null;
} {
  const target = input.redirectTo ? normalizeCustomHostname(input.redirectTo) : "";
  if (!target) return { redirectTo: null, redirectStatus: null };

  if (
    input.redirectStatus !== undefined &&
    input.redirectStatus !== null &&
    !REDIRECT_STATUSES.includes(input.redirectStatus as RedirectStatus)
  ) {
    throw new ValidationError(
      `${input.redirectStatus} is not a redirect status. Use one of ${REDIRECT_STATUSES.join(", ")}.`,
    );
  }

  return { redirectTo: target, redirectStatus: resolveRedirectStatus(input.redirectStatus) };
}

/**
 * Openship Cloud check. Kept as its own call (rather than folded into
 * `assertRedirectTargets`) so the message names the real reason: it isn't a
 * validation failure, it's an unsupported capability on that runtime.
 */
export function assertRedirectSupported(opts: { isCloudProject: boolean; hostname: string }): void {
  if (opts.isCloudProject) {
    throw new ValidationError(
      `Redirects aren't available for projects running on Openship Cloud — the managed edge owns routing for ${opts.hostname}. ` +
        `Point the extra hostname at the same app instead.`,
    );
  }
}

/**
 * Validate every redirect in a project's hostname set at once.
 *
 * Takes the WHOLE set, not one row, because both real failure modes are
 * properties of the set: a target that isn't in it, and a cycle within it. The
 * deploy/save paths already hold the full desired set, so this is the natural
 * shape and it can't be fooled by validating rows one at a time.
 */
export function assertRedirectTargets(hosts: RedirectHost[]): void {
  const known = new Map(
    hosts.map((h) => [normalizeCustomHostname(h.hostname), normalizeCustomHostname(h.hostname)]),
  );
  const edges = new Map<string, string>();

  for (const host of hosts) {
    const from = normalizeCustomHostname(host.hostname);
    if (!host.redirectTo) continue;
    const to = normalizeCustomHostname(host.redirectTo);

    if (to === from) {
      throw new ValidationError(`${from} can't redirect to itself.`);
    }
    if (!known.has(to)) {
      throw new ValidationError(
        `${from} can only redirect to another domain of this project — ${to} isn't one of them.`,
      );
    }
    edges.set(from, to);
  }

  // Walk each chain to its end. A chain can be at most `edges.size` hops before
  // it must have revisited a host, so that bound doubles as the cycle detector.
  for (const start of edges.keys()) {
    let current = start;
    for (let hop = 0; hop <= edges.size; hop++) {
      const next = edges.get(current);
      if (!next) break;
      if (next === start) {
        throw new ValidationError(
          `${start} → ${next} would be a redirect loop — every request to either host would bounce forever. ` +
            `Pick one hostname to serve the app.`,
        );
      }
      current = next;
    }
  }
}

/**
 * The redirect a route should be REGISTERED with, or null.
 *
 * Returns null when the target isn't in the live set: a redirect to a hostname
 * that was since removed would send every visitor to a host this box no longer
 * answers for, so serving the app is the safe reading. Routing must never fail a
 * deploy (the golden rule), so this drops the redirect instead of throwing —
 * `assertRedirectTargets` is where a bad redirect is refused, at write time.
 */
export function resolveRouteRedirect(
  host: { hostname: string; redirectTo?: string | null; redirectStatus?: number | null },
  liveHostnames: Iterable<string>,
): { target: string; statusCode: RedirectStatus } | null {
  if (!host.redirectTo) return null;
  const target = normalizeCustomHostname(host.redirectTo);
  const from = normalizeCustomHostname(host.hostname);
  if (!target || target === from) return null;

  const live = new Set([...liveHostnames].map((h) => normalizeCustomHostname(h)));
  if (!live.has(target)) return null;

  return { target, statusCode: resolveRedirectStatus(host.redirectStatus) };
}
