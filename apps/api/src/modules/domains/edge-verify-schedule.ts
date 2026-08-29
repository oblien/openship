/**
 * Keep target verifications alive, and make their failure visible.
 *
 * Openship Cloud's edge only forwards `<slug>.opsh.io` to a target whose control has
 * been proven, a proof that lasts 90 days and is renewed by Cloud RE-PROBING THE SAME
 * TOKEN within 7 days of expiry. So the standing obligation is not to re-verify — it
 * is to still be answering when that probe arrives.
 *
 * Every deploy already re-asserts the tokens (`ensureEdgeChallengeReady`), which
 * covers an active install. This exists for the case that one cannot: a box that
 * deploys nothing for three months. Its host state dir gets wiped, or the server is
 * rebuilt from a backup, and nothing writes the token back before the re-probe. The
 * free domain then stops resolving ~83 days after a perfectly green deploy, and
 * without this job there is no record anywhere of why.
 *
 * It does three things per target, in order:
 *   1. re-assert every token the target owes an answer for (the self-heal),
 *   2. read one back over the target's own public address (the observability),
 *   3. re-verify from scratch ONLY if the proof has already expired.
 *
 * What it deliberately does NOT do is call Cloud for a target that is still verified.
 * Re-requesting a challenge RESETS the token, so "refreshing" a proof that Cloud is
 * about to re-probe successfully is the one action here that could break a working
 * free domain. A verified row whose token we have just re-asserted needs nothing from
 * upstream — Cloud's own probe will find it.
 */

import { safeErrorMessage } from "@repo/core";
import { repos } from "@repo/db";
import type { EdgeTargetVerification } from "@repo/db";
import { ensureTargetVerified, probeOwnToken, resolveRoutingFor } from "../../lib/edge-target-verify";

export interface EdgeVerifySweepResult {
  targets: number;
  reasserted: number;
  /** Answering with the expected token — the only state that survives a re-probe. */
  serving: number;
  /** Re-asserted but still not answering. Each one is a free domain on a countdown. */
  notServing: number;
  /** Verified, and inside the window where Cloud re-probes. */
  renewingSoon: number;
  reverified: number;
  failed: number;
}

/**
 * How far ahead of expiry a verification counts as "being re-probed about now".
 *
 * Matches the upstream's own 7-day renewal window: inside it, a token we are not
 * serving is not a future problem, it is an active one.
 */
const RENEWAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export async function runEdgeVerifySweep(): Promise<EdgeVerifySweepResult> {
  const rows = await repos.edgeTargetVerification.listAll();
  const result: EdgeVerifySweepResult = {
    targets: rows.length,
    reasserted: 0,
    serving: 0,
    notServing: 0,
    renewingSoon: 0,
    reverified: 0,
    failed: 0,
  };
  if (!rows.length) return result;

  // Routing is resolved per BOX, not per row: several targets can live on one server,
  // and building a platform runs a paths probe and can self-heal the edge under a
  // provision lock. Keyed by org too — the same server id could not appear under two
  // orgs, but the resolver takes both and caching on the pair keeps that honest.
  const routingCache = new Map<string, Awaited<ReturnType<typeof resolveRoutingFor>>>();
  const routingFor = async (row: EdgeTargetVerification) => {
    const key = `${row.organizationId}:${row.serverId ?? "local"}`;
    if (!routingCache.has(key)) {
      routingCache.set(
        key,
        await resolveRoutingFor(row.organizationId, row.serverId ?? undefined),
      );
    }
    return routingCache.get(key) ?? null;
  };

  for (const row of rows) {
    try {
      await sweepOne(row, await routingFor(row), result);
    } catch (err) {
      // One unreachable server must not stop the sweep for every other target.
      result.failed++;
      console.warn(
        `[edge-verify-sweep] ${row.target}: ${safeErrorMessage(err)}`,
      );
    }
  }

  if (result.notServing > 0) {
    console.warn(
      `[edge-verify-sweep] ${result.notServing} of ${result.targets} verified target(s) ` +
        `are not serving their Openship Cloud challenge token. Their free .opsh.io ` +
        `domains will stop resolving when the verification expires.`,
    );
  }
  return result;
}

async function sweepOne(
  row: EdgeTargetVerification,
  routing: Awaited<ReturnType<typeof resolveRoutingFor>>,
  result: EdgeVerifySweepResult,
): Promise<void> {
  const expiresInMs = row.expiresAt ? row.expiresAt.getTime() - Date.now() : null;
  const expired = row.status === "expired" || (expiresInMs !== null && expiresInMs <= 0);
  if (row.status === "verified" && expiresInMs !== null && expiresInMs < RENEWAL_WINDOW_MS) {
    result.renewingSoon++;
  }

  // An expired proof has already cost the route, so re-issuing can't break anything
  // that still works — and it is the only path back for a box that isn't deploying.
  // This is the one upstream call the sweep is allowed to make.
  if (expired) {
    const verdict = await ensureTargetVerified(row.organizationId, row.target, {
      ...(row.serverId ? { serverId: row.serverId } : {}),
      ...(routing ? { routing } : {}),
    });
    if (verdict.verified) result.reverified++;
    else result.failed++;
    return;
  }

  const tokens = repos.edgeTargetVerification.servableTokens(row);
  if (!tokens.length) return; // nothing was ever issued for this target

  if (!routing?.serveEdgeChallenge) {
    result.failed++;
    await repos.edgeTargetVerification.recordServeError(
      row.id,
      `could not reach the box that serves ${row.host} to re-assert its challenge token`,
    );
    return;
  }

  const served = await routing.serveEdgeChallenge({ host: row.host, tokens });
  if (!served.served) {
    result.failed++;
    await repos.edgeTargetVerification.recordServeError(
      row.id,
      `could not re-assert the challenge token on ${row.host}: ${served.reason ?? "unknown reason"}`,
    );
    return;
  }
  result.reasserted++;

  // Then read it back. This is the whole point of the job: without it, "we wrote the
  // file" is the strongest thing anyone could say about a route that Cloud is about to
  // silently drop. Advisory about the network (a NAT that won't hairpin its own public
  // IP fails this while being reachable from outside), so it records and warns rather
  // than changing `status` — Cloud owns that.
  if (!row.challengePath || !row.token) return;
  const probe = await probeOwnToken(row.target, row.challengePath, row.token);
  if (probe.ok) {
    result.serving++;
    if (row.lastError) await repos.edgeTargetVerification.recordServeError(row.id, null);
    return;
  }
  result.notServing++;
  await repos.edgeTargetVerification.recordServeError(
    row.id,
    `${row.target} is not returning its Openship Cloud challenge token (${probe.reason}). ` +
      `Free .opsh.io routing to this server will stop when the verification expires` +
      `${row.expiresAt ? ` on ${row.expiresAt.toISOString().slice(0, 10)}` : ""}.`,
  );
}
