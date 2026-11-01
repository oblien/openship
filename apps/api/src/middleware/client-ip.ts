import type { Context, Next } from "hono";
import { env } from "@repo/platform/engine/config/env";
import { isLoopbackPeer, peerAddress } from "./loopback-peer";

declare module "hono" {
  interface ContextVariableMap {
    clientIp: string | null;
  }
}

/**
 * Resolve the request's client IP and stamp it on the Hono context.
 *
 * Trust rules (MEDIUM cleanup):
 *   - Loopback peers ALWAYS get header trust (local dev / docker-host
 *     networking, where the API listens on 127.0.0.1 behind a proxy on
 *     the same box).
 *   - Non-loopback peers get header trust ONLY when TRUST_PROXY=true.
 *     Otherwise the kernel-reported peer wins. Without this gate, any
 *     client could send `x-real-ip: 1.2.3.4` and forge their source IP.
 */
export async function clientIpMiddleware(c: Context, next: Next) {
  const peer = peerAddress(c);
  const xri = c.req.header("x-real-ip")?.trim() || null;

  // In-process dispatch (app.fetch — the MCP adapter calling the API itself)
  // has NO TCP peer; every external caller has one (the proxy/socket), so this
  // is unforgeable. Treat it as trusted loopback so self-calls resolve a client
  // IP — the outer request already authenticated + was rate-limited.
  if (peer === null) {
    c.set("clientIp", xri || "127.0.0.1");
    return next();
  }

  // Loopback peers normally get header trust (local dev / same-box proxy). But
  // when the instance is served PUBLICLY (openship up --public-url), the on-box
  // dashboard proxy makes EVERY request look loopback — so trusting x-real-ip
  // off loopback alone would let a remote client forge their source IP (and
  // slip the login rate-limiter). In that case require an explicit trusted
  // front proxy (TRUST_PROXY=true) before believing the header; otherwise fall
  // back to the (loopback) peer, which keys rate limits to one safe bucket.
  const loopbackTrust = isLoopbackPeer(peer) && !env.OPENSHIP_PUBLIC_URL;
  const trustHeader = loopbackTrust || env.TRUST_PROXY === true;
  const ip = trustHeader ? xri || peer : peer;

  c.set("clientIp", ip && ip.length > 0 ? ip : null);
  await next();
}
