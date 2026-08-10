/**
 * Prove to Openship Cloud that this installation controls a routing target.
 *
 * Cloud will only route `<slug>.opsh.io` to a target whose control has been proven:
 * it fetches a one-time token from the target over an SSRF-safe, IP-pinned
 * connection, and pins the resulting route to the validated IP. Unproven targets are
 * refused with `403 target_unverified`.
 *
 * The whole flow is automatic and invisible — there is no "Verify" button, because a
 * deploy and `openship up` both have to work unattended.
 *
 * ── The rule that outranks the flow ─────────────────────────────────────────
 * A verification lasts 90 days and Cloud re-probes THE SAME token shortly before it
 * expires. A 404 at that moment expires the verification and disables the route, so a
 * token we stop serving kills a free domain roughly 83 days after a perfectly green
 * deploy. Everything here is therefore built around never losing a token: tokens are
 * files (never config, never the volatile mgmt layer), a re-issue RETIRES the previous
 * token instead of replacing it, and nothing is deleted when a free domain is dropped.
 */

import { safeErrorMessage } from "@repo/core";
import { repos } from "@repo/db";
import type { Platform } from "@repo/adapters";
import { cloudClient } from "./cloud/client";
import { canonicalEdgeTarget } from "./edge-target";
import { resolveTargetPlatform } from "./deployment-runtime";

type Routing = Platform["routing"];

export interface VerifyTargetResult {
  verified: boolean;
  /** Operator-facing explanation when `verified` is false. */
  reason?: string;
  /** Set when our own pre-probe couldn't read the token back. Advisory — it does
   *  NOT block the attempt (see `probeOwnToken`), but it is the most useful line in
   *  the log when Cloud's probe then fails too. */
  selfProbeWarning?: string;
}

/**
 * How long a recorded attempt suppresses the next one.
 *
 * Free-domain sync runs once PER DOMAIN in a loop, so without this a project with
 * five free domains would issue five challenges for the same target in a second —
 * each one resetting the previous token — and walk straight into the upstream's
 * 10-checks-per-5-minutes limit. One attempt per target per window; the other
 * domains reuse its outcome.
 */
const ATTEMPT_COOLDOWN_MS = 60_000;

/** Timeout for reading our own token back. Short: this is a local-ish request and
 *  it must never add meaningful latency to a deploy. */
const SELF_PROBE_TIMEOUT_MS = 4_000;

/**
 * Ensure `target` is proven, issuing and serving a challenge if it is not.
 *
 * Called REACTIVELY — only after a sync came back `target_unverified` — so a stored
 * `verified` row is not evidence of anything here: Cloud has just said otherwise, and
 * believing our own cache over the upstream is how a route stays broken forever. The
 * cooldown, not the status, is what stops repeat work.
 *
 * Never throws. A verification that can't be obtained leaves the free URL unwired,
 * which is a warning, not a deploy failure.
 */
export async function ensureTargetVerified(
  organizationId: string,
  target: string,
  opts: {
    serverId?: string;
    /** The routing provider for the box that IS this target. Resolved from
     *  `serverId` when omitted. */
    routing?: Routing;
    onLog?: (message: string, level?: "warn") => void;
  } = {},
): Promise<VerifyTargetResult> {
  const canonical = canonicalEdgeTarget(target);
  if (!canonical) return { verified: false, reason: "no target to verify" };

  const existing = await repos.edgeTargetVerification
    .findByTarget(organizationId, canonical)
    .catch(() => undefined);

  // A very recent attempt decides for every caller in this window. Its outcome is
  // reused verbatim — including a success, since a 403 immediately after a green
  // check is propagation, not a fresh problem, and re-issuing would reset the token
  // Cloud is in the middle of accepting.
  if (existing?.lastCheckedAt && Date.now() - existing.lastCheckedAt.getTime() < ATTEMPT_COOLDOWN_MS) {
    return existing.status === "verified"
      ? { verified: true }
      : { verified: false, reason: existing.lastError ?? `target verification is ${existing.status}` };
  }

  const host = hostOf(canonical);
  if (!host) return { verified: false, reason: `"${canonical}" is not a usable target address` };

  const routing = opts.routing ?? (await resolveRoutingFor(organizationId, opts.serverId));
  if (!routing?.serveEdgeChallenge) {
    return {
      verified: false,
      reason:
        `this box can't serve Openship Cloud's target challenge — its routing provider ` +
        `has no HTTP surface, so ${host} cannot be proven from here`,
    };
  }

  const client = cloudClient({ organizationId });

  // 1. Ask for a challenge. This RESETS the token upstream, which is exactly why the
  //    previous one is retired rather than dropped below.
  let challenge: Awaited<ReturnType<typeof client.edgeProxy.requestVerification>>;
  try {
    challenge = await client.edgeProxy.requestVerification(canonical);
  } catch (err) {
    return { verified: false, reason: safeErrorMessage(err) };
  }
  if (!challenge) {
    return { verified: false, reason: "Openship Cloud is not connected for this organization" };
  }

  const row = await repos.edgeTargetVerification.recordChallenge({
    organizationId,
    target: canonical,
    host,
    ...(opts.serverId ? { serverId: opts.serverId } : {}),
    verificationId: challenge.id,
    token: challenge.token,
    challengePath: challenge.path,
    status: "pending",
  });

  // 2. Serve it — the current token AND every retired one. Serving the old tokens is
  //    not politeness: an earlier verification record may still be mid-re-probe, and
  //    answering only the newest would expire it.
  const tokens = repos.edgeTargetVerification.servableTokens(row);
  try {
    const served = await routing.serveEdgeChallenge({ host, tokens });
    if (!served.served) {
      const reason = served.reason ?? "the edge could not be configured to serve the challenge";
      await recordFailure(row.id, reason);
      return { verified: false, reason };
    }
  } catch (err) {
    const reason = `could not install the challenge on this box's edge: ${safeErrorMessage(err)}`;
    await recordFailure(row.id, reason);
    return { verified: false, reason };
  }

  // 3. Read our own token back before asking Cloud to. ADVISORY ONLY — a box behind a
  //    NAT that doesn't hairpin its own public IP will fail this while being perfectly
  //    reachable from the internet, so treating it as authoritative would refuse
  //    verifications that would have succeeded. Its value is diagnostic: when Cloud's
  //    probe fails too, this line is what says whether the problem is our config or
  //    the path to us.
  const selfProbe = await probeOwnToken(canonical, challenge.path, challenge.token);
  const selfProbeWarning = selfProbe.ok ? undefined : selfProbe.reason;
  if (selfProbeWarning) {
    opts.onLog?.(
      `Note: couldn't read the target challenge back from ${canonical} (${selfProbeWarning}). ` +
        `Continuing — Openship Cloud probes from outside your network, which may still succeed.\n`,
      "warn",
    );
  }

  // 4. One check. Never a poll loop: the upstream allows 10 checks per 5 minutes and
  //    counts failures toward a lockout, and a token that isn't being served will not
  //    start being served by asking again.
  let result: Awaited<ReturnType<typeof client.edgeProxy.checkVerification>>;
  try {
    result = await client.edgeProxy.checkVerification(challenge.id);
  } catch (err) {
    const reason = safeErrorMessage(err);
    await recordFailure(row.id, reason);
    return { verified: false, reason, ...(selfProbeWarning ? { selfProbeWarning } : {}) };
  }
  if (!result) {
    const reason = "Openship Cloud returned no verification result";
    await recordFailure(row.id, reason);
    return { verified: false, reason, ...(selfProbeWarning ? { selfProbeWarning } : {}) };
  }

  await repos.edgeTargetVerification.recordCheck(row.id, {
    status: result.status,
    validatedIp: result.validatedIp ?? null,
    expiresAt: result.expiresAt ? new Date(result.expiresAt) : null,
    lastError: result.status === "verified" ? null : (result.error ?? null),
  });

  if (result.status === "verified") {
    opts.onLog?.(
      `Verified ${canonical} with Openship Cloud` +
        (result.validatedIp ? ` (routing pinned to ${result.validatedIp})` : "") +
        `.\n`,
    );
    return { verified: true };
  }

  // The upstream's own `error` names the actual cause — DNS, a firewall, a proxy in
  // front of :80 — and nothing we could substitute would be as specific.
  return {
    verified: false,
    reason:
      result.error ??
      `Openship Cloud could not confirm control of ${canonical} (status: ${result.status})`,
    ...(selfProbeWarning ? { selfProbeWarning } : {}),
  };
}

async function recordFailure(id: string, reason: string): Promise<void> {
  await repos.edgeTargetVerification
    .recordCheck(id, { status: "failed", lastError: reason })
    .catch(() => undefined);
}

/** Bare host from a canonical target, unbracketing IPv6 for `serveEdgeChallenge`
 *  (whose `assertValidDomain` takes an address, not a URL authority). */
function hostOf(canonical: string): string | null {
  try {
    const h = new URL(canonical).hostname;
    return h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h || null;
  } catch {
    return null;
  }
}

/**
 * Fetch the token we just installed, from the target's own public address.
 *
 * Compares the BODY, not just the status: a catch-all vhost, a captive portal or a
 * CDN error page all return 200 with the wrong bytes, and "200 OK" would read as
 * success while the probe upstream fails for a reason nothing in our logs explains.
 *
 * Exported for the periodic sweep, which asks the same question ("is this token
 * still answerable?") about tokens it did not just install.
 */
export async function probeOwnToken(
  canonical: string,
  path: string,
  token: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const url = `${canonical.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
  try {
    const res = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(SELF_PROBE_TIMEOUT_MS),
      headers: { "User-Agent": "openship-target-check" },
    });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status} from ${url}` };
    const body = (await res.text()).trim();
    if (body !== token) {
      return {
        ok: false,
        reason:
          body.length === 0
            ? `${url} returned an empty body`
            : `${url} returned something other than the token (${body.length} bytes) — ` +
              `another server or vhost is answering for this address on port 80`,
      };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: safeErrorMessage(err) };
  }
}

/**
 * Routing for the box that is this target, when the caller didn't supply it.
 *
 * Reached only on the verification path (a sync that came back unverified) and from
 * the periodic sweep — never on a healthy deploy. Building a platform is not free, so
 * this deliberately stays off the hot path rather than being resolved eagerly and
 * thrown away.
 */
export async function resolveRoutingFor(
  organizationId: string,
  serverId?: string,
): Promise<Routing | null> {
  try {
    const target = serverId ? "server" : "local";
    const resolved = await resolveTargetPlatform(target, "docker", serverId, organizationId);
    return resolved.routing;
  } catch (err) {
    console.warn(
      `[edge-verify] could not resolve routing for ${serverId ?? "this box"}: ${safeErrorMessage(err)}`,
    );
    return null;
  }
}
