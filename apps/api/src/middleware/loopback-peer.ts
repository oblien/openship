/**
 * TCP-peer loopback check.
 *
 * The "is this request from loopback" decision MUST be made from the
 * kernel-reported peer address, never the Host header. Host is set by
 * the client (or a misconfigured proxy) and can lie. Peer comes from
 * the socket and cannot.
 *
 * ─── Used by (4 consumers, all with additional gating) ────────────────
 *
 *   1. `middleware/auth.ts` — zero-auth fallback (CRITICAL #4).
 *      Loopback is the FINAL gate. Earlier gates: `authMode === "none"`
 *      AND (`DEPLOY_MODE=desktop` OR `OPENSHIP_ALLOW_ZERO_AUTH=true`).
 *
 *   2. `middleware/internal-auth.ts` — Electron → API desktop fallback
 *      when `INTERNAL_TOKEN` is unset (CRITICAL #5). Earlier gate:
 *      `DEPLOY_MODE=desktop` AND env.ts boot guard refuses non-desktop
 *      deployments without `INTERNAL_TOKEN`.
 *
 *   3. `middleware/rate-limiter.ts` — loopback peers skip rate limits
 *      (local-dev DX; doesn't fire in SaaS since requests come through
 *      the reverse proxy, not literal localhost).
 *
 *   4. `middleware/client-ip.ts` — trust `X-Forwarded-For` when peer
 *      is loopback OR `TRUST_PROXY=true`. SaaS uses TRUST_PROXY; the
 *      loopback branch is a local-dev shortcut for the same effect.
 *
 * ─── Why this is safe (vs. a generic bypass) ──────────────────────────
 *
 *   - **Kernel-peer, not header.** A remote attacker cannot make the
 *     socket appear to originate from 127.0.0.1 — that bit comes from
 *     the OS, not the request.
 *   - **A proxy can itself be loopback.** This helper identifies the TCP
 *     peer, not the original browser. Authorization callers must also verify
 *     the deployment posture. The local-bootstrap and zero-auth guards reject
 *     public/CLI instances even when their dashboard proxies through loopback.
 *   - **Layered gates.** No consumer treats loopback alone as proof
 *     of trust — each ANDs it with deploy-mode / env-flag / boot
 *     guard. Loopback is the LAST verification, not the first.
 *
 * Whitelist covers IPv4 127.0.0.0/8, IPv6 ::1, and the IPv4-mapped-IPv6
 * forms a dual-stack listener surfaces ("::ffff:127.x.x.x").
 */

import type { Context } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
/** Exact addresses we accept without further parsing. */
const EXACT_LOOPBACK = new Set<string>([
  "::1",
  "0:0:0:0:0:0:0:1",
]);

/** Parse "127.x.x.x" / "::ffff:127.x.x.x" → true for any 127.0.0.0/8. */
function isLoopbackIpv4(addr: string): boolean {
  // Strip the v4-mapped-v6 prefix Node hands back on dual-stack sockets.
  let stripped = addr;
  if (stripped.startsWith("::ffff:")) {
    stripped = stripped.slice("::ffff:".length);
  }
  return /^127(?:\.\d{1,3}){3}$/.test(stripped);
}

export function isLoopbackPeer(peer: string | null | undefined): boolean {
  if (!peer) return false;
  if (EXACT_LOOPBACK.has(peer)) return true;
  return isLoopbackIpv4(peer);
}

export function peerAddress(c: Context): string | null {
  try {
    return getConnInfo(c).remote.address ?? null;
  } catch {
    return null;
  }
}

export function isLoopbackRequest(c: Context): boolean {
  return isLoopbackPeer(peerAddress(c));
}
