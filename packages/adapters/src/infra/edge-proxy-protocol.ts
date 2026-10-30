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
 * Which files have a :443 server is read with nginx's own token rules
 * ({@link inspectHttpsVhost}). A file without a saved route is only left behind when it
 * provably answers :443 with nothing but a `return`. An `include`, inherited content or
 * an unknown directive cannot be proved inert, so such a file refuses the switch by name.
 *
 * ── Why a failed rollback is recorded on disk ───────────────────────────────
 *
 * The mode is read back from disk (the listener file is there or not), so a switch whose
 * rollback fails part-way leaves files that describe neither mode. Every PROXY switch,
 * and every vhost transaction while PROXY is on, first records the previous files in
 * `_openship-config.journal` (owner-only, atomic, before the first change). It is
 * removed once the change completes or is fully rolled back. While it exists, every
 * change from any provider on this edge is refused with {@link EdgeConfigRecoveryError},
 * and the routing sweep (a deploy or Retry routing) restores it first: every recorded
 * file, then `openresty -t` and a reload, and only then the journal is removed.
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
/**
 * sites-enabled file recording the previous content of every file a journaled config
 * transaction changes. Written before the first change and removed once the edge is
 * consistent again, so it outlives a failed rollback or a crash. Not `*.conf`: nginx never
 * loads it.
 */
export const EDGE_CONFIG_JOURNAL_NAME = "_openship-config.journal";

export type EdgeProxyProtocolSetting =
  | { mode: "off" }
  | { mode: "https"; trusted: string[] }
  | { mode: "invalid"; error: string };

/** Thrown before any write when the setting is invalid. See the module header. */
export class EdgeProxyProtocolConfigError extends Error {
  override name = "EdgeProxyProtocolConfigError";
}

/**
 * A config transaction failed and its files could not all be restored, or such a
 * transaction is still recorded in {@link EDGE_CONFIG_JOURNAL_NAME}.
 *
 * The edge was not reloaded and still runs its previous configuration, but the files on
 * disk are partly changed. Any later reload would load them, so every change is refused
 * until the routing sweep (a deploy or Retry routing) restores the recorded files,
 * validates them and reloads.
 */
export class EdgeConfigRecoveryError extends Error {
  override name = "EdgeConfigRecoveryError";
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
  return `    include ${edgeProxyProtocolRealIpIncludePath(nginxSitesDir)};`;
}

/** The argument of {@link edgeProxyProtocolRealIpIncludeLine}. */
export function edgeProxyProtocolRealIpIncludePath(nginxSitesDir: string): string {
  return `${nginxSitesDir}/${EDGE_PROXY_PROTOCOL_REAL_IP_NAME.slice(0, -1)}[${EDGE_PROXY_PROTOCOL_REAL_IP_NAME.slice(-1)}]`;
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

// ─── Which sites-enabled files have a :443 server ────────────────────────────
//
// A switch must re-render every :443 server that serves content, and may only leave
// behind one it can PROVE serves nothing. So a file is read with nginx's own token
// rules (quotes, escapes, `#` comments), and anything this reader cannot follow
// (an `include`, a directive outside a small inert set, a listen it cannot parse)
// counts as possibly :443 and possibly serving. The transition and the drift pass
// both ask this one function, so they always pick the same files.

interface ConfDirective {
  name: string;
  args: string[];
  block?: ConfDirective[];
}

/** A sites-enabled file this reader cannot follow. The message names the construct. */
class EdgeConfReadError extends Error {
  override name = "EdgeConfReadError";
}

/** nginx unescapes these in every token, quoted or not, and keeps any other `\x`. */
const TOKEN_ESCAPES: Record<string, string> = {
  '"': '"',
  "'": "'",
  "\\": "\\",
  t: "\t",
  r: "\r",
  n: "\n",
};

/** Directives, by nginx's tokenizer rules (`ngx_conf_read_token`). */
function readConf(text: string): ConfDirective[] {
  let i = 0;
  const isSpace = (ch: string | undefined) =>
    ch === " " || ch === "\t" || ch === "\r" || ch === "\n";
  const unescape = (raw: string) =>
    raw.replace(/\\(.)/gs, (all, ch: string) => TOKEN_ESCAPES[ch] ?? all);

  /** Next token, or a `;` `{` `}` punctuator, or null at end of input. */
  const next = (): { word: string } | { punct: ";" | "{" | "}" } | null => {
    for (;;) {
      while (isSpace(text[i])) i++;
      if (i >= text.length) return null;
      if (text[i] !== "#") break;
      while (i < text.length && text[i] !== "\n") i++;
    }
    const ch = text[i]!;
    if (ch === ";" || ch === "{" || ch === "}") {
      i++;
      return { punct: ch };
    }
    if (ch === '"' || ch === "'") {
      const start = ++i;
      while (i < text.length && text[i] !== ch) i += text[i] === "\\" ? 2 : 1;
      if (i >= text.length) throw new EdgeConfReadError("a quoted value is not closed");
      const word = unescape(text.slice(start, i));
      i++;
      const after = text[i];
      // `)` closes an `if (...)` condition and starts the next token.
      if (
        after !== undefined &&
        !isSpace(after) &&
        after !== ";" &&
        after !== "{" &&
        after !== ")"
      ) {
        throw new EdgeConfReadError(`unexpected ${JSON.stringify(after)} after a quoted value`);
      }
      return { word };
    }
    const start = i;
    // An unquoted value ends only at whitespace, `;` or `{`. A `{` right after `$` opens
    // a `${name}` variable instead, and a `}` or quote inside a value is literal.
    while (i < text.length) {
      const c = text[i]!;
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (isSpace(c) || c === ";" || (c === "{" && text[i - 1] !== "$")) break;
      i++;
    }
    return { word: unescape(text.slice(start, i)) };
  };

  /** Skip the body of a `*_by_lua_block`, which ngx_lua reads as Lua, not as nginx. */
  const skipLua = (): void => {
    let depth = 1;
    const longBracket = () => text.slice(i).match(/^\[(=*)\[/);
    const skipLong = (level: string) => {
      const close = text.indexOf(`]${level}]`, i);
      if (close < 0) throw new EdgeConfReadError("a Lua long string is not closed");
      i = close + level.length + 2;
    };
    while (i < text.length) {
      const c = text[i]!;
      if (c === "-" && text[i + 1] === "-") {
        i += 2;
        const long = longBracket();
        if (long) {
          i += long[0].length;
          skipLong(long[1]!);
        } else {
          while (i < text.length && text[i] !== "\n") i++;
        }
        continue;
      }
      const long = c === "[" ? longBracket() : null;
      if (long) {
        i += long[0].length;
        skipLong(long[1]!);
        continue;
      }
      if (c === '"' || c === "'") {
        i++;
        while (i < text.length && text[i] !== c) i += text[i] === "\\" ? 2 : 1;
        if (i >= text.length) throw new EdgeConfReadError("a Lua string is not closed");
        i++;
        continue;
      }
      i++;
      if (c === "{") depth++;
      else if (c === "}" && --depth === 0) return;
    }
    throw new EdgeConfReadError("a Lua block is not closed");
  };

  const block = (nested: boolean): ConfDirective[] => {
    const directives: ConfDirective[] = [];
    let words: string[] = [];
    for (;;) {
      const token = next();
      if (token === null) {
        if (nested) throw new EdgeConfReadError("a block is not closed");
        if (words.length) throw new EdgeConfReadError(`"${words[0]}" is not terminated by ";"`);
        return directives;
      }
      if ("word" in token) {
        words.push(token.word);
        continue;
      }
      if (token.punct === "}") {
        if (!nested) throw new EdgeConfReadError('unexpected "}"');
        if (words.length) throw new EdgeConfReadError(`"${words[0]}" is not terminated by ";"`);
        return directives;
      }
      const [name, ...args] = words;
      if (name === undefined) throw new EdgeConfReadError(`unexpected "${token.punct}"`);
      if (token.punct === "{" && name.endsWith("_by_lua_block")) {
        skipLua();
        directives.push({ name, args, block: [] });
      } else {
        directives.push(token.punct === "{" ? { name, args, block: block(true) } : { name, args });
      }
      words = [];
    }
  };

  return block(false);
}

/** Port of a `listen` address, 80 when it names only a host, null for a unix socket. */
function listenPort(address: string): number | null {
  if (address.startsWith("unix:")) return null;
  const bracketed = address.match(/^\[[^\]]*\](?::(.*))?$/);
  const port = bracketed
    ? bracketed[1]
    : /^\d+$/.test(address)
      ? address
      : address.includes(":")
        ? address.slice(address.lastIndexOf(":") + 1)
        : undefined;
  if (port === undefined) return 80;
  if (!/^\d{1,5}$/.test(port))
    throw new EdgeConfReadError(`listen ${JSON.stringify(address)} has no numeric port`);
  return Number(port);
}

/** Server-scope directives that neither serve content nor change what is served. */
const INERT_SERVER = new Set([
  "listen",
  "server_name",
  "server_tokens",
  "return",
  "location",
  "http2",
  "ssl_certificate",
  "ssl_certificate_key",
  "ssl_reject_handshake",
  "ssl_protocols",
  "ssl_ciphers",
  "ssl_prefer_server_ciphers",
  "ssl_session_cache",
  "ssl_session_timeout",
  "ssl_session_tickets",
  "access_log",
  "error_log",
]);
/** Location-scope ones. `types` only maps extensions, which `return` never reads. */
const INERT_LOCATION = new Set([
  "return",
  "location",
  "default_type",
  "types",
  "server_tokens",
  "access_log",
  "error_log",
]);

/**
 * Does this server provably answer every request with a `return`?
 *
 * A server-scope `return` does, when nothing that could run before it is present.
 * Otherwise every location must `return` and a `location /` must catch every URI: a
 * request no location matches is served from the inherited `root`.
 */
function returnsOnly(server: ConfDirective[]): boolean {
  const inert = (directives: ConfDirective[], allowed: Set<string>): boolean =>
    directives.every((d) => {
      if (!allowed.has(d.name)) return false;
      if (d.name === "types") return true;
      if (d.name !== "location") return !d.block;
      const body = d.block ?? [];
      return inert(body, INERT_LOCATION) && body.some((child) => child.name === "return");
    });
  if (!inert(server, INERT_SERVER)) return false;
  if (server.some((d) => d.name === "return")) return true;
  return server.some(
    (d) => d.name === "location" && (d.args.join(" ") === "/" || d.args.join(" ") === "^~ /"),
  );
}

export interface HttpsVhostShape {
  /** "unknown" when the file's :443 servers cannot be determined. */
  https: "no" | "yes" | "unknown";
  /** Every :443 server it has provably serves nothing but a `return`. */
  returnOnly: boolean;
  /** Why `https` is "unknown", or why a :443 server is not provably inert. */
  reason?: string;
  /** Does any directive include exactly `includePath`? */
  includes: (includePath: string) => boolean;
}

/** What a sites-enabled `.conf` serves on :443, read the way nginx reads it. */
export function inspectHttpsVhost(conf: string): HttpsVhostShape {
  let directives: ConfDirective[];
  try {
    directives = readConf(conf);
  } catch (err) {
    if (!(err instanceof EdgeConfReadError)) throw err;
    return {
      https: "unknown",
      returnOnly: false,
      reason: `it cannot be read: ${err.message}`,
      includes: () => false,
    };
  }
  const included = (path: string, list: ConfDirective[]): boolean =>
    list.some(
      (d) => (d.name === "include" && d.args[0] === path) || (!!d.block && included(path, d.block)),
    );
  const includes = (path: string) => included(path, directives);

  let https: HttpsVhostShape["https"] = "no";
  let returnOnly = true;
  let reason: string | undefined;
  const unknown = (why: string) => {
    https = "unknown";
    returnOnly = false;
    reason ??= why;
  };
  for (const d of directives) {
    if (d.name === "include")
      unknown(`it includes ${d.args[0] ?? "a file"}, which may add a :443 server`);
    if (d.name !== "server" || !d.block) continue;
    let tls = false;
    try {
      tls = d.block.some(
        (child) => child.name === "listen" && listenPort(child.args[0] ?? "") === 443,
      );
    } catch (err) {
      if (!(err instanceof EdgeConfReadError)) throw err;
      unknown(`it has ${err.message}`);
      continue;
    }
    const include = d.block.find((child) => child.name === "include");
    if (!tls) {
      if (include)
        unknown(
          `its server includes ${include.args[0] ?? "a file"}, which may add a :443 listener`,
        );
      continue;
    }
    if (https === "no") https = "yes";
    if (!returnsOnly(d.block)) {
      returnOnly = false;
      reason ??= include
        ? `its :443 server includes ${include.args[0] ?? "a file"}`
        : "its :443 server is not provably a return-only dead end";
    }
  }
  return { https, returnOnly: https !== "no" && returnOnly, reason, includes };
}
