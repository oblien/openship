/**
 * Make a box ABLE to answer Openship Cloud's edge-target challenge, before any
 * challenge exists.
 *
 * Oblien will only route `<slug>.opsh.io` to a target that has proven control, and it
 * proves it by fetching a token from the target over plain HTTP. This prepares the
 * serving side; issuing and checking the token is the verify flow's job.
 *
 * WHY THIS RUNS AT EDGE-ENSURE rather than only when a verification starts: the
 * challenge location serves a DIRECTORY, so the vhost is valid with nothing in it and
 * can exist before a token does. Doing it here means the box is ready from its first
 * install and stays ready — the alternative was relying on the `:80` catch-all, which
 * on a container edge (the only install path) comes from the BAKED image and so never
 * reaches a box running an older pinned image, or one rolled back to it. This vhost
 * lands in the bind-mounted `sites-enabled` written by our own code, so it works on
 * every image version.
 *
 * Best-effort by contract: routing never fails a deploy, and a box that can't resolve
 * a public target yet simply isn't ready to hold a free domain either.
 */

import type { Platform } from "@repo/adapters";
import { safeErrorMessage } from "@repo/core";
import { repos } from "@repo/db";
import { canonicalEdgeTarget, resolveEdgeTargetHost } from "./edge-target";

type Routing = Platform["routing"];

export interface EdgeChallengeReadyResult {
  ready: boolean;
  host?: string;
  reason?: string;
}

/**
 * Ensure the challenge vhost exists for the org's edge target on `routing`'s box.
 *
 * Resolves the target through the SAME resolver the verification and the proxy sync
 * use, so the host we prepare to answer for is the host Oblien will actually dial —
 * preparing a different one would look identical right up to the probe 404ing.
 */
export async function ensureEdgeChallengeReady(
  organizationId: string,
  routing: Routing | null | undefined,
  opts: { serverId?: string; onLog?: (message: string) => void } = {},
): Promise<EdgeChallengeReadyResult> {
  // Cloud routes through Oblien's own edge and has nothing to serve from, so its
  // provider implements no `serveEdgeChallenge` — an absent method is a clean
  // "not applicable", not a failure.
  if (!routing?.serveEdgeChallenge) {
    return { ready: false, reason: "this routing provider serves no HTTP surface" };
  }

  const { host, reason } = await resolveEdgeTargetHost(organizationId, {
    serverId: opts.serverId,
  });
  if (!host) return { ready: false, reason };

  // Re-assert whatever tokens this target already owes an answer for. This is the
  // self-heal, and it is the reason the 90-day re-probe survives real operations: a
  // wiped host state dir, a rebuilt server, or a restored backup loses the token
  // files while the DB row (the source of truth) still says the target is verified.
  // Writing them back on every edge-ensure means the next deploy repairs it silently
  // instead of the free domain dying two months later.
  const tokens = await owedTokens(organizationId, host);

  try {
    const result = await routing.serveEdgeChallenge({ host, ...(tokens.length ? { tokens } : {}) });
    if (!result.served) {
      opts.onLog?.(
        `Note: ${host} can't answer Openship Cloud's target check yet — ${result.reason ?? "unknown reason"}\n`,
      );
      return { ready: false, host, reason: result.reason };
    }
    return { ready: true, host };
  } catch (err) {
    // Never propagates: this is preparation for a feature the deploy does not depend
    // on, and the verify flow re-attempts it with the token in hand anyway.
    const message = safeErrorMessage(err);
    console.warn(`[edge-challenge] could not prepare ${host}: ${message}`);
    return { ready: false, host, reason: message };
  }
}

/**
 * Tokens this target already owes an answer for, or none.
 *
 * Wrapped whole rather than with a promise `.catch`: this runs on the deploy path,
 * where the contract is that preparation never throws, and a failure to READ the
 * tokens must degrade to preparing the location with nothing in it — the same state
 * every box starts in — rather than taking the deploy down with it.
 */
async function owedTokens(organizationId: string, host: string): Promise<string[]> {
  try {
    const row = await repos.edgeTargetVerification.findByTarget(
      organizationId,
      canonicalEdgeTarget(host),
    );
    return repos.edgeTargetVerification.servableTokens(row);
  } catch (err) {
    console.warn(
      `[edge-challenge] could not read owed tokens for ${host}: ${safeErrorMessage(err)}`,
    );
    return [];
  }
}
