/**
 * Client-address recovery at the edge.
 *
 * ── The bug this fixes ───────────────────────────────────────────────────────
 *
 * Everything the edge knows about "who made this request" came from
 * `ngx.var.remote_addr`, which is the TCP peer. Put Cloudflare (or any reverse proxy, or a
 * load balancer) in front and that peer is the PROXY, so on such a box:
 *
 *   • every visitor's country resolved to the proxy PoP's country,
 *   • distinct-visitor counts collapsed toward the number of PoPs, not people,
 *   • per-IP rate limits bucketed the entire planet behind one PoP into one counter —
 *     so one noisy visitor could rate-limit everyone, and an attacker was never isolated,
 *   • IP ban rules banned a PoP, i.e. a large slice of legitimate traffic, or nothing.
 *
 * `rules_guard.lua` has carried a note about this since it was written ("front a real_ip").
 * This is that real_ip.
 *
 * ── Why nginx's realip module rather than reading a header in Lua ────────────
 *
 * Because it rewrites `remote_addr` itself, every existing consumer is fixed at once and
 * none of them can drift: the geo lookup, the visitor hash, the rate-limit key, the ban
 * check and the request log all keep reading the same variable they already read. A Lua
 * helper would have to be threaded into each call site, and the first one someone forgets
 * silently keeps the old behaviour — for rate limiting, that is a security regression that
 * looks like nothing.
 *
 * ── Why this cannot be bypassed by sending the header yourself ───────────────
 *
 * `set_real_ip_from` is NOT "trust this header". It is "trust this header only when the
 * TCP peer is one of these addresses". A visitor who curls the origin directly with
 * `CF-Connecting-IP: 1.2.3.4` is not connecting from a Cloudflare address, so nginx
 * ignores the header and keeps their real peer address. The trust is anchored to who
 * opened the socket — something the client cannot forge — not to what they claim.
 *
 * ── Why CF-Connecting-IP and not X-Forwarded-For ─────────────────────────────
 *
 * This is the part that decides whether the whole thing is spoofable, and the two headers
 * are NOT interchangeable:
 *
 *   • Cloudflare OVERWRITES `CF-Connecting-IP`. Whatever the client sent is discarded, so
 *     the value that reaches us is Cloudflare's own statement of the client address and
 *     contains nothing client-supplied.
 *   • Cloudflare APPENDS to `X-Forwarded-For`. The value that reaches us is
 *     `<whatever the client put there>, <real client>` — a list under partial client
 *     control. Reading it correctly requires `real_ip_recursive on` and walking from the
 *     RIGHT; take the left-most entry (the naive reading, and what plenty of code does)
 *     and the client picks their own address, which also means they pick which rate-limit
 *     bucket and which ban rule applies to them.
 *
 * So the Cloudflare path uses the header Cloudflare guarantees. XFF remains available for
 * an operator's own proxy via `OPENSHIP_EDGE_REAL_IP_HEADER`, where `real_ip_recursive on`
 * (always emitted below) makes the right-to-left walk the active behaviour.
 *
 * ── Shape on disk ────────────────────────────────────────────────────────────
 *
 * Emitted as an `include` file rather than lines appended into `http {}`. The bare-box
 * convergence elsewhere in this package is `grep || sed -i /http {/a`, which is
 * append-only and therefore cannot UPDATE anything it has already written. A trust list
 * that grows when Cloudflare adds a range has to be rewritable, so it gets a file the
 * patcher overwrites wholesale plus one `include` line that is appended once.
 */

import { SYSTEM } from "@repo/core";
import { CLOUDFLARE_IPV4, CLOUDFLARE_IPV6 } from "./cloudflare-ips.generated";

/** Filename of the generated real-ip include, inside the OpenResty conf dir. */
export const EDGE_REAL_IP_CONF_NAME = "openship-real-ip.conf";

/**
 * Header naming the true client, honoured only from a trusted peer.
 *
 * Overridable for an operator fronting the edge with their own proxy — set
 * `OPENSHIP_EDGE_REAL_IP_HEADER=X-Forwarded-For` together with
 * `OPENSHIP_EDGE_TRUSTED_PROXIES`. Read at config-generation time, so a change needs the
 * routing to be re-applied (or the edge reinstalled), not merely a reload.
 */
export function edgeRealIpHeader(): string {
  const raw = process.env.OPENSHIP_EDGE_REAL_IP_HEADER?.trim();
  // Header names only. This value lands in a config directive, so anything with
  // whitespace, a semicolon or a brace could close the directive and inject another —
  // an env var is a lower bar than a socket, but it is still not a place to concatenate
  // unvalidated text into nginx config.
  if (raw && /^[A-Za-z0-9-]{1,64}$/.test(raw)) return raw;
  return "CF-Connecting-IP";
}

/**
 * Extra CIDRs to trust, for a proxy that is not Cloudflare.
 *
 * Comma or whitespace separated. Malformed entries are DROPPED rather than passed through:
 * a bad token would make `nginx -t` fail, and a failed test means the reload is refused and
 * no routing change lands at all — so one typo in an env var would wedge every route on the
 * box. Being silently ignored is the better failure for a value that only widens trust.
 */
export function edgeTrustedProxies(): string[] {
  const raw = process.env.OPENSHIP_EDGE_TRUSTED_PROXIES?.trim();
  if (!raw) return [];
  const CIDR = /^(?:(?:\d{1,3}\.){3}\d{1,3}|[0-9a-fA-F:]+)(?:\/\d{1,3})?$/;
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length <= 64 && CIDR.test(s));
}

/**
 * The complete real-ip config block.
 *
 * Same text on the containerized edge (inlined into the baked `http {}`) and on a
 * bare/remote box (written to the include file), because a box that recovers client
 * addresses on one install path and not the other has two different rate limiters.
 */
export function edgeRealIpConf(): string {
  const header = edgeRealIpHeader();
  const extra = edgeTrustedProxies();

  const lines: string[] = [
    "# Openship — recover the real client address from a trusted front proxy.",
    "#",
    "# GENERATED. Source: packages/adapters/src/infra/edge-real-ip.ts",
    "#",
    "# Without this, remote_addr is the PROXY on any box behind Cloudflare or a load",
    "# balancer, which silently breaks four things at once: visitor country resolves to",
    "# the PoP, distinct-visitor counts collapse toward the number of PoPs, per-IP rate",
    "# limits put the whole planet behind one PoP in a single bucket, and IP bans ban a",
    "# PoP instead of a visitor.",
    "#",
    "# set_real_ip_from does NOT mean 'trust this header'. It means 'trust this header",
    "# only when the TCP peer is one of these addresses'. Someone hitting the origin",
    "# directly with a forged header is not connecting FROM Cloudflare, so the header is",
    "# ignored and their real address stands. The trust is anchored to who opened the",
    `# socket, which a client cannot forge.`,
    "#",
    `# The header is ${header}.`,
    ...(header.toLowerCase() === "cf-connecting-ip"
      ? [
          "# Cloudflare OVERWRITES CF-Connecting-IP, so its value holds nothing the client",
          "# supplied. It deliberately is NOT X-Forwarded-For: Cloudflare APPENDS to that",
          "# one, so XFF arrives as '<client-controlled>, <real client>' and reading it",
          "# left-to-right would let a visitor choose their own apparent address — and",
          "# with it their rate-limit bucket and which ban rules miss them.",
        ]
      : [
          "# NOT the default (CF-Connecting-IP) — set via OPENSHIP_EDGE_REAL_IP_HEADER.",
          "# If this is X-Forwarded-For, note that proxies APPEND to it, so the header is",
          "# partly client-controlled; real_ip_recursive below is what makes nginx walk it",
          "# from the right and stop at the last untrusted hop, which is the real client.",
        ]),
    "",
    `real_ip_header ${header};`,
    "",
    "# Walk a multi-hop header from the RIGHT, skipping trusted addresses. Inert for a",
    "# single-value header like CF-Connecting-IP; load-bearing for X-Forwarded-For, where",
    "# the left-hand entries are whatever the client sent.",
    "real_ip_recursive on;",
    "",
    `# Cloudflare's published edge ranges (${CLOUDFLARE_IPV4.length} v4 + ${CLOUDFLARE_IPV6.length} v6).`,
    "# Trusted unconditionally, which is safe by construction: on a box that is not behind",
    "# Cloudflare no peer ever matches, so every line here is inert. Refresh with",
    "# `bun run update:cloudflare-ips`.",
    ...CLOUDFLARE_IPV4.map((c) => `set_real_ip_from ${c};`),
    ...CLOUDFLARE_IPV6.map((c) => `set_real_ip_from ${c};`),
  ];

  if (extra.length > 0) {
    lines.push(
      "",
      "# Operator-declared proxies (OPENSHIP_EDGE_TRUSTED_PROXIES). Each of these can set",
      "# the header above and be believed, so keep the list to hosts you control.",
      ...extra.map((c) => `set_real_ip_from ${c};`),
    );
  }

  return lines.join("\n") + "\n";
}

/**
 * Header Openship Cloud's edge names the client in.
 *
 * Not CF-Connecting-IP: the Cloud edge is a proxy in its own right, and the header it
 * OVERWRITES on the way to the origin is `X-Real-IP`. Two different fronts, two
 * different headers — and `real_ip_header` is one per config scope, which is the whole
 * reason a Cloud-fronted host needs its own block instead of the http-scope one.
 */
export const CLOUD_EDGE_REAL_IP_HEADER = "X-Real-IP";

/**
 * Is this hostname one Openship Cloud's shared edge fronts?
 *
 * A free `<slug>.opsh.io` host is served by Cloud's edge, which proxies to this box on
 * plain :80 — so for that vhost, and only that vhost, the TCP peer is the Cloud edge
 * and the visitor is named in a header.
 *
 * Deliberately the LITERAL cloud domain, not the API's `getRoutingBaseDomain()` (which
 * prefers `HOST_DOMAIN`): with `HOST_DOMAIN` set, "managed" hostnames live on the
 * operator's own wildcard zone pointed straight at this box, with nothing in front. A
 * header-trust block there would believe a header no proxy sets — i.e. hand every
 * visitor a free choice of source address.
 */
export function isCloudFrontedHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.+$/, "");
  const suffix = `.${SYSTEM.DOMAINS.CLOUD_DOMAIN.toLowerCase()}`;
  return host.length > suffix.length && host.endsWith(suffix);
}

/**
 * The realip block that belongs INSIDE a Cloud-fronted vhost, at server scope.
 *
 * Without it such a host falls through to the http-scope block, which reads
 * CF-Connecting-IP — a header the Cloud edge does not send. `remote_addr` then stays
 * the edge for every visitor, and the four things that read it break in the way
 * {@link edgeRealIpConf} describes: country resolves to the edge, distinct visitors
 * collapse to one, every visitor shares a single rate-limit bucket, and an IP ban bans
 * the edge or nobody. It is also the value `proxy_set_header X-Real-IP` forwards, so
 * the app behind the route sees the edge too — including this API's own login limiter
 * when the instance is served on its free URL.
 *
 * Trust here is anchored to the VHOST, not to a peer address — see the emitted comment for
 * why a peer list cannot work for this front and what that costs.
 *
 * `indent` is applied to every line so the caller can drop the result straight into a
 * generated `server { }` body.
 */
export function cloudEdgeRealIpConf(indent = "    "): string {
  const lines: string[] = [
    "# Openship Cloud's edge fronts this free host, so the peer is the edge and the",
    "# visitor is named in X-Real-IP (which that front OVERWRITES). The http-scope block",
    "# reads CF-Connecting-IP for Cloudflare-fronted custom domains, and there is one",
    "# real_ip_header per scope — hence this override.",
    "#",
    "# Trust is scoped to this VHOST instead of to a peer list, deliberately. The Cloud",
    "# edge reaches origins from its own address, which this box has no way to know and",
    "# which Cloudflare's ranges (the visitor→edge leg) do not contain — so a peer list",
    "# here silently ignores the header and every free-domain visitor stays the edge.",
    "#",
    "# What bounds it is the server_name: this block exists only inside a <slug>.opsh.io",
    "# vhost, a hostname whose only legitimate path is that edge. Someone who reaches this",
    "# box directly on :80 with a forged Host AND a forged X-Real-IP can choose their own",
    "# apparent address for THIS vhost — accepted, because the alternative is the address",
    "# being wrong for every visitor all the time. Custom domains keep the peer-anchored",
    "# http-scope block; do not widen this to them.",
    `real_ip_header ${CLOUD_EDGE_REAL_IP_HEADER};`,
    // OFF, unlike the http-scope block: the Cloud edge OVERWRITES X-Real-IP with a single
    // address, so there is no list to walk, and "skip trusted addresses from the right"
    // has no meaning once every address is trusted.
    "real_ip_recursive off;",
    "set_real_ip_from 0.0.0.0/0;",
    "set_real_ip_from ::/0;",
  ];

  return lines.map((l) => `${indent}${l}`).join("\n") + "\n";
}
