/**
 * PROXY protocol on the LOCAL Compose edge's HTTPS listener (#1050).
 *
 * ── The case ─────────────────────────────────────────────────────────────────
 *
 * A TCP proxy on another machine (Traefik `HostSNI` + `passthrough: true`, HAProxy
 * `mode tcp`, a cloud TCP load balancer) forwards :443 without terminating TLS, so it
 * cannot add `X-Forwarded-For`. Every HTTPS connection then reaches the edge with the
 * PROXY's address as `remote_addr`, and the rate limiter, IP bans, analytics, logs and
 * every app's `X-Real-IP` see one address. Such a proxy can still prepend a PROXY
 * protocol v1/v2 header before the ClientHello, which is what this reads.
 *
 * ── Shape ────────────────────────────────────────────────────────────────────
 *
 * Opt-in, and :443 only:
 *
 *   OPENSHIP_EDGE_PROXY_PROTOCOL=https
 *   OPENSHIP_EDGE_PROXY_PROTOCOL_TRUSTED=192.168.1.153,10.0.0.0/8
 *
 * :80 is untouched: ACME http-01, the edge-target challenge and Cloud's free-domain
 * front all arrive there as plain HTTP, and a proxy in front usually forwards it as
 * HTTP too. Read only by `localContainerEdgeProvider` — the env describes THIS
 * machine's edge, never a remote box the same api drives.
 *
 * ── Why the trust list is separate from OPENSHIP_EDGE_TRUSTED_PROXIES ────────
 *
 * That list extends the http-scope `set_real_ip_from` set, which trusts the
 * `CF-Connecting-IP` HEADER from those peers on every listener, :80 included. A proxy
 * that only speaks PROXY on :443 usually forwards :80 verbatim, so listing it there
 * would let any client choose its own address with a forged header on :80. This list
 * is emitted only at SERVER scope inside the :443 blocks, next to
 * `real_ip_header proxy_protocol`.
 *
 * ── Why an empty or invalid list is refused, not skipped ─────────────────────
 *
 * realip merges its trust list by INHERITANCE, not addition: a server block with no
 * `set_real_ip_from` of its own inherits the http-scope one, which is Cloudflare's
 * published ranges plus OPENSHIP_EDGE_TRUSTED_PROXIES. `real_ip_header proxy_protocol`
 * with no list would therefore let any of those peers name an arbitrary client in a
 * PROXY header. So an invalid setting makes every mutating edge operation throw before
 * its first write or command, and the edge keeps serving its previous configuration.
 * A malformed entry is refused the same way: dropping it would quietly trust less (or,
 * for a typo in a CIDR, a different network) than the operator wrote.
 *
 * ── Why two files, and why vhosts carry no `proxy_protocol` flag ─────────────
 *
 * nginx applies `proxy_protocol` per LISTENING SOCKET: one `listen 443 ... proxy_protocol`
 * anywhere makes every server on 0.0.0.0:443 expect the header, including the image's
 * baked `443 default_server` catch-all, which cannot be edited at runtime. Measured on
 * the pinned OpenResty 1.27.1.1: `openresty -t` is clean (no "protocol options
 * redefined") and an unknown SNI is answered by the catch-all after the header. So
 * the flag lives in ONE file:
 *
 *   `_openship-proxy-protocol.conf` — a dead-end server whose only job is
 *     `listen 443 ssl proxy_protocol`. It exists even with zero TLS vhosts, and
 *     deleting it is a complete retirement: no stale vhost can keep the socket in
 *     PROXY mode after the feature is turned off.
 *   `_openship-proxy-protocol-realip.inc` — the server-scope realip block, included
 *     by every generated :443 block. Changing the trust list rewrites this one file
 *     and reloads once; no vhost has to be re-rendered.
 *
 * ── Why switching is one transaction over every vhost ───────────────────────
 *
 * The socket flag changes how EVERY :443 server reads its client at the same instant.
 * A vhost still rendered for the other mode is then wrong, and dangerously so for a
 * Cloud-fronted host, whose plain-TLS block trusts X-Real-IP from any peer. So only
 * `NginxProvider.transitionProxyProtocol` (run by the routing sweep) writes the pair:
 * it re-renders every :443 vhost from its saved route and publishes them WITH both
 * files behind one `openresty -t` and reload, restoring all of it on any failure.
 * Turning it on is refused, with nothing written, while a :443 vhost that serves
 * content cannot be re-rendered. A route, certificate or challenge write renders for
 * the mode the socket is IN (the listener file is on disk or not), never for the env,
 * so no other entrypoint can switch the socket or put one vhost ahead of the rest.
 *
 * The listener file carries `server_name openship-proxy-protocol.invalid`. `.invalid`
 * is reserved (RFC 6761) and can never be a routed hostname. It also keeps the file
 * through `sanitizeEdgeVhosts`, which drops `.conf` files without a real server_name
 * before every edge start. Without it the edge would restart with :443 in plain-TLS
 * mode and refuse every connection from a proxy that sends PROXY headers.
 *
 * `$proxy_protocol_addr` is never read anywhere. Nothing can name the client except
 * realip from an explicitly trusted peer, which rewrites `remote_addr`. That is the
 * variable every consumer already reads.
 */

import { isIP } from "node:net";
import { EDGE_NOT_FOUND_LOCATION } from "./edge-not-found";

/** Selector env var. Unset, empty or `off` disables; `https` enables. */
export const EDGE_PROXY_PROTOCOL_ENV = "OPENSHIP_EDGE_PROXY_PROTOCOL";
/** The peers allowed to name a client in a PROXY header. Required with `https`. */
export const EDGE_PROXY_PROTOCOL_TRUSTED_ENV = "OPENSHIP_EDGE_PROXY_PROTOCOL_TRUSTED";

/** sites-enabled file holding the one `listen 443 ssl proxy_protocol`. */
export const EDGE_PROXY_PROTOCOL_LISTENER_CONF_NAME = "_openship-proxy-protocol.conf";
/** sites-enabled file holding the :443 server-scope realip block. Not `*.conf`, so the
 *  http-scope glob never loads it a second time. */
export const EDGE_PROXY_PROTOCOL_REAL_IP_NAME = "_openship-proxy-protocol-realip.inc";
/** Reserved name for the listener's dead-end server. */
export const EDGE_PROXY_PROTOCOL_SERVER_NAME = "openship-proxy-protocol.invalid";

export type EdgeProxyProtocolSetting =
  | { mode: "off" }
  | { mode: "https"; trusted: string[] }
  | { mode: "invalid"; error: string };

/** Thrown before any write when the setting is invalid. See the module header. */
export class EdgeProxyProtocolConfigError extends Error {
  override name = "EdgeProxyProtocolConfigError";
}

/** IPv4/IPv6 literal → integer, or null. IPv6 may compress and may embed IPv4. */
function addressBits(address: string, family: 4 | 6): bigint | null {
  if (family === 4) {
    const parts = address.split(".").map(Number);
    return parts.reduce((acc, octet) => (acc << 8n) | BigInt(octet), 0n);
  }
  let text = address.toLowerCase();
  const tail = text.match(/:(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const v4 = addressBits(tail[1]!, 4)!;
    text = `${text.slice(0, -tail[1]!.length)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const [head = "", rest] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = rest === undefined ? [] : rest ? rest.split(":") : [];
  const groups =
    rest === undefined
      ? left
      : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  if (groups.length !== 8) return null;
  return groups.reduce((acc, group) => (acc << 16n) | BigInt(parseInt(group, 16)), 0n);
}

/**
 * Validate one trust entry. Returns the error text, or null when it is acceptable.
 *
 * Rejects `/0` (that is "trust everyone": any client could name any address) and a
 * CIDR with host bits set, which nginx would accept with a "low address bits are
 * meaningless" warning while trusting a network the operator may not have meant.
 */
function trustEntryError(entry: string): string | null {
  if (entry.length > 64) return "is too long";
  const [address = "", prefix, ...extra] = entry.split("/");
  const family = isIP(address);
  if (!family || address.includes("%") || extra.length)
    return "is not an IPv4/IPv6 address or CIDR";
  if (prefix === undefined) return null;
  const max = family === 4 ? 32 : 128;
  if (!/^(?:0|[1-9]\d{0,2})$/.test(prefix) || Number(prefix) > max) {
    return `has an invalid prefix length (expected 1-${max})`;
  }
  const length = Number(prefix);
  if (length === 0) return "trusts every address (/0); list the proxy's own address instead";
  const bits = addressBits(address, family === 4 ? 4 : 6);
  if (bits === null) return "is not an IPv4/IPv6 address or CIDR";
  const hostMask = (1n << BigInt(max - length)) - 1n;
  if ((bits & hostMask) !== 0n) return "has host bits set; use the network address of the range";
  return null;
}

/**
 * Read the setting from an environment. Pure: nothing here touches the edge.
 *
 * `invalid` carries an operator-facing message naming the variable and entry, because
 * it is what a refused route change reports.
 */
export function readEdgeProxyProtocolSetting(
  env: Record<string, string | undefined> = process.env,
): EdgeProxyProtocolSetting {
  const mode = (env[EDGE_PROXY_PROTOCOL_ENV] ?? "").trim().toLowerCase();
  if (mode === "" || mode === "off") return { mode: "off" };
  if (mode !== "https") {
    return {
      mode: "invalid",
      error:
        `${EDGE_PROXY_PROTOCOL_ENV}=${JSON.stringify(env[EDGE_PROXY_PROTOCOL_ENV])} is not supported. ` +
        `Use "https" to accept PROXY protocol on port 443, or "off".`,
    };
  }
  const entries = (env[EDGE_PROXY_PROTOCOL_TRUSTED_ENV] ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (entries.length === 0) {
    return {
      mode: "invalid",
      error:
        `${EDGE_PROXY_PROTOCOL_ENV}=https requires ${EDGE_PROXY_PROTOCOL_TRUSTED_ENV} with the ` +
        `address or CIDR of the proxy that sends the PROXY header. Without it the edge would ` +
        `trust its Cloudflare list for PROXY headers.`,
    };
  }
  const trusted: string[] = [];
  for (const entry of entries) {
    const error = trustEntryError(entry);
    if (error) {
      return {
        mode: "invalid",
        error: `${EDGE_PROXY_PROTOCOL_TRUSTED_ENV} entry ${JSON.stringify(entry)} ${error}.`,
      };
    }
    if (!trusted.includes(entry)) trusted.push(entry);
  }
  return { mode: "https", trusted };
}

/**
 * The line every generated :443 block includes while the feature is on.
 *
 * `.in[c]` is a glob that can only match the exact filename. nginx accepts a glob that
 * matches nothing, so a vhost written while the feature was on still passes
 * `openresty -t` after the file is removed. A literal path would make that vhost
 * reject every reload. Temp files from atomic writes (`….inc.tmp-…`) never match.
 */
export function edgeProxyProtocolRealIpIncludeLine(nginxSitesDir: string): string {
  return `    include ${nginxSitesDir}/${EDGE_PROXY_PROTOCOL_REAL_IP_NAME.slice(0, -1)}[${EDGE_PROXY_PROTOCOL_REAL_IP_NAME.slice(-1)}];`;
}

/** Content of {@link EDGE_PROXY_PROTOCOL_REAL_IP_NAME}. `trusted` must be validated. */
export function edgeProxyProtocolRealIpConf(trusted: readonly string[]): string {
  if (trusted.length === 0) {
    // Defence in depth: see the module header for why an empty list is not "trust nobody".
    throw new EdgeProxyProtocolConfigError("PROXY protocol trust list is empty");
  }
  return [
    "# Openship — client address from the PROXY protocol header on :443.",
    "#",
    "# GENERATED on every routing apply. Source: packages/adapters/src/infra/edge-proxy-protocol.ts",
    "# Included at SERVER scope by each generated :443 block.",
    "#",
    "# Only the peers below may name the client. Their list REPLACES the http-scope one",
    "# (Cloudflare + OPENSHIP_EDGE_TRUSTED_PROXIES) in this scope, so CF-Connecting-IP is",
    "# not honoured on :443 while this is active. :80 keeps the http-scope behaviour.",
    "real_ip_header proxy_protocol;",
    ...trusted.map((c) => `set_real_ip_from ${c};`),
    "",
  ].join("\n");
}

/** Content of {@link EDGE_PROXY_PROTOCOL_LISTENER_CONF_NAME}. */
export function edgeProxyProtocolListenerConf(): string {
  return `\
# Openship — PROXY protocol on the HTTPS listener (OPENSHIP_EDGE_PROXY_PROTOCOL=https).
#
# GENERATED on every routing apply. Source: packages/adapters/src/infra/edge-proxy-protocol.ts
#
# nginx applies proxy_protocol to the whole 0.0.0.0:443 socket, so this one listen
# makes every :443 server (each vhost and the image's catch-all) require a PROXY v1/v2
# header before the TLS handshake. Plain TLS without it is refused. Removing this file
# returns :443 to plain TLS.
#
# The server below only holds the listen directive. Its name is reserved (.invalid),
# it rejects a handshake for that name, and it serves nothing.
server {
    listen 443 ssl proxy_protocol;
    server_name ${EDGE_PROXY_PROTOCOL_SERVER_NAME};
    ssl_reject_handshake on;

${EDGE_NOT_FOUND_LOCATION}
}
`;
}
