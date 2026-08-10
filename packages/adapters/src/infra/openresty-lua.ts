/**
 * OpenResty Lua deployment - reads dedicated .lua files and writes them
 * to the managed server via the CommandExecutor (SSH / local shell).
 *
 * Architecture:
 *   No external dependencies on the managed server - everything runs on
 *   ngx.shared.dict zones in OpenResty shared memory.  No Redis, no
 *   file I/O on the hot path.
 *
 * Lua scripts live in ./lua/ as proper .lua files (readable, lintable,
 * editable with Lua tooling).  At deploy time we read them with
 * fs.readFileSync and push them to the server.
 *
 * Scripts:
 *   site_logger.lua      - log_by_lua: atomic counters + ring buffer
 *   pipe_stream.lua      - content_by_lua: SSE endpoint reading the ring by cursor
 *   mgmt_api.lua         - content_by_lua: REST analytics query endpoints
 *   geo_country.lua      - module: MaxMind GeoLite2 IP → country code
 *
 * Shared memory zones (declared in nginx.conf):
 *   analytics        256m - minute-bucket counters, daily geo, totals
 *   request_data     128m - raw-log ring buffer (also the live SSE source)
 *
 * Management port: 127.0.0.1:9145 (loopback only)
 *   GET /analytics?domain=&from=&to=   - minute-bucket time series
 *   GET /analytics/totals?domain=      - lifetime counters (or all domains)
 *   GET /analytics/geo?domain=&day=    - country breakdown
 *   GET /logs/recent?domain=&limit=    - recent raw requests
 *   GET /logs/stream?domain=           - SSE live stream
 *   GET /health                        - 200 ok
 */

import { safeErrorMessage } from "@repo/core";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EMBEDDED_LUA } from "./lua-embedded";
import type { CommandExecutor } from "../types";
import { EDGE_REAL_IP_CONF_NAME, edgeRealIpConf } from "./edge-real-ip";
import { EDGE_NOT_FOUND_LOCATION } from "./edge-not-found";
import { sq } from "../system/local-shell";

// ── Paths & constants ────────────────────────────────────────────────────────

/** Directory on the managed server where Lua scripts are deployed. */
export const OPENRESTY_LUA_DIR = "/usr/local/openresty/site/lualib/openship";

/** Absolute path to the site_logger script (referenced by nginx server blocks). */
export const LUA_LOGGER_PATH = `${OPENRESTY_LUA_DIR}/site_logger.lua`;

/** Absolute path to the access-phase rules guard (referenced by server blocks). */
export const RULES_GUARD_PATH = `${OPENRESTY_LUA_DIR}/rules_guard.lua`;

/** Management API port - loopback only, queried via SSH tunnel. */
export const OPENRESTY_MGMT_PORT = 9145;

/**
 * Directory `require "openship.<mod>"` resolves from — the PARENT of the module
 * dir, which is what makes the dotted module names in our Lua resolvable at all.
 */
const OPENRESTY_SITE_LUALIB = OPENRESTY_LUA_DIR.replace(/\/[^/]+$/, "");

/** OpenResty's own default lualib (`;;`) plus the openship modules. */
export const EDGE_LUA_PACKAGE_PATH = `${OPENRESTY_SITE_LUALIB}/?.lua;;`;

/**
 * nginx sizes the server_name hash to the LONGEST server_name it loads, and the
 * 64-byte default rejects the whole config — `could not build server_names_hash`
 * fails `nginx -t`, so the reload is REFUSED and no route change lands until the
 * offending vhost is removed. A single long hostname (a generated
 * `<project>-<service>.opsh.io`, or any custom domain past ~63 chars) would
 * otherwise wedge routing for every site on the box, not just its own.
 */
export const EDGE_SERVER_NAMES_HASH_BUCKET_SIZE = 128;

/**
 * Shared-memory zones the openship Lua depends on, and the ONE definition of
 * their sizes.
 *
 * Two consumers used to carry their own copy: the `grep || sed` patches that add
 * them to a bare box's nginx.conf (below), and the baked container config in
 * `apps/edge/nginx.conf` (now generated from this — see `bakedEdgeNginxConf`). A
 * dict sized 256m on one install path and 16m on the other is an eviction bug
 * that only appears under load, on one kind of box.
 */
export const EDGE_SHARED_DICTS: ReadonlyArray<{ name: string; size: string }> = [
  /** Analytics counters. */
  { name: "analytics", size: "256m" },
  /** Raw-log ring buffers + the live-log pipe. */
  { name: "request_data", size: "128m" },
  /** Per-route rules cache: written reload-free by mgmt_api `POST /rules`, read
   *  by rules_guard.lua in the access phase. The DB (route_rule) is the source
   *  of truth, so losing this dict costs a re-push, not a ruleset. */
  { name: "rules", size: "32m" },
  /** Rate-limit COUNTERS, kept apart from `rules` so a high-cardinality flood (a
   *  fresh key per source IP per second) can't LRU-evict the rulesets and
   *  silently disable enforcement mid-attack.
   *
   *  32m, matching openresty module migration 1.1.0, which raises it from the
   *  original 16m on boxes already installed. Both must state the same target: a
   *  fresh install writes THIS value, so leaving it at 16m meant a new box got the
   *  size the migration exists to correct — and only bare boxes that consented to
   *  the migration would ever reach 32m. The migration stays because the
   *  `grep || sed` convergence below is append-only and cannot resize an existing
   *  directive; `edge-shared-dicts.test.ts` pins the two together. */
  { name: "rl_counters", size: "32m" },
  /**
   * Distinct-visitor sets. One key per (domain, day, salted-IP hash) — high
   * cardinality and short-lived, so it gets its own zone for the same reason
   * `rl_counters` does: a busy day's visitor set must not LRU-evict the analytics
   * counters or the rulesets.
   *
   * Privacy: keys hold a per-day-salted hash, never an address, and only the
   * resulting COUNT is ever flushed to Postgres. Nothing that identifies a visitor
   * leaves the box — see the visitor block in site_logger.lua.
   *
   * 64m ≈ 1M distinct visitors/day. Past that the zone LRU-evicts and the count
   * UNDERSTATES; `GET /status` reports free_space so a reader can mark it
   * approximate rather than present an eviction artifact as a measurement.
   */
  { name: "visitors", size: "64m" },
];

// ── Detected paths ───────────────────────────────────────────────────────────

/**
 * Resolved OpenResty paths for a target server.
 *
 * Detected once from `openresty -V`, then passed to every function that
 * touches the OpenResty config on that server. No hardcoded fallbacks
 * are used at runtime.
 */
export interface OpenRestyPaths {
  /** Path to the openresty binary (e.g. /usr/local/openresty/bin/openresty) */
  bin: string;
  /** Path to nginx.conf (e.g. /etc/openresty/nginx.conf) */
  confPath: string;
  /** Directory containing nginx.conf (e.g. /etc/openresty) */
  confDir: string;
  /** sites-enabled directory (e.g. /etc/openresty/sites-enabled) */
  sitesDir: string;
  /** PID file path (e.g. /usr/local/openresty/nginx/logs/nginx.pid) */
  pidPath: string;
  /**
   * nginx version behind this OpenResty, when `openresty -V` could be read.
   * Only consumer so far is the vhost renderer's gate on version-dependent
   * directive syntax (`http2 on;` needs ≥ 1.25.1) — undefined means "unknown",
   * which callers treat as allow. See `proxyDirectiveAllowed` in @repo/core.
   */
  nginxVersion?: readonly [number, number, number];
}

/**
 * Pull the nginx version out of `openresty -V` output.
 *
 * The banner reads `nginx version: openresty/1.27.1.1` on OpenResty and
 * `nginx version: nginx/1.24.0` on stock nginx; OpenResty's 4th component is its
 * own patch level, which no nginx feature gate cares about, so it's dropped.
 */
export function parseNginxVersion(raw: string): readonly [number, number, number] | undefined {
  const m = raw.match(/nginx version:\s*\S*?\/(\d+)\.(\d+)\.(\d+)/i);
  if (!m) return undefined;
  return [Number(m[1]), Number(m[2]), Number(m[3])] as const;
}

/** Fallback paths when `openresty -V` is unavailable (e.g. not yet installed). */
export const OPENRESTY_DEFAULT_PATHS: OpenRestyPaths = {
  bin: "/usr/local/openresty/bin/openresty",
  confPath: "/usr/local/openresty/nginx/conf/nginx.conf",
  confDir: "/usr/local/openresty/nginx/conf",
  sitesDir: "/usr/local/openresty/nginx/conf/sites-enabled",
  pidPath: "/usr/local/openresty/nginx/logs/nginx.pid",
};

/**
 * Directory (relative to the conf dir) holding the placeholder certificate the
 * :443 catch-all presents for a hostname we do NOT route, so the handshake
 * completes and the visitor gets a page instead of a TLS error (#431).
 *
 * Beside `sites-enabled`, and pointedly NOT under `/etc/letsencrypt`: that path is
 * a bind mount that `certsExist()` / `readCertInfo()` / the migrate proxy scan all
 * read, and a self-signed cert sitting in it would be reported as a domain's
 * active certificate — satisfying the renewal scheduler and the verify-pending
 * sweep while the real cert never gets issued. Here it is invisible to all of them.
 *
 * The conf dir is not a mount, so in the container this resolves to the copy baked
 * into the image and nothing on the host can mask or delete it.
 */
export const EDGE_DEFAULT_CERT_DIRNAME = "openship-default-cert";

/** The placeholder cert/key pair for a given OpenResty conf dir. */
export function edgeDefaultCertPaths(confDir: string): {
  dir: string;
  certPath: string;
  keyPath: string;
} {
  const dir = `${confDir}/${EDGE_DEFAULT_CERT_DIRNAME}`;
  return { dir, certPath: `${dir}/fullchain.pem`, keyPath: `${dir}/privkey.pem` };
}

/**
 * Common name on that placeholder. Not a hostname on purpose — it is presented
 * only for names we do not serve, and giving it one would make it look, to anyone
 * reading a scan or a browser warning, like a cert we meant to use for that name.
 */
export const EDGE_DEFAULT_CERT_CN = "openship-edge-default";

// ── Containerized edge ───────────────────────────────────────────────────────

/** Root for edge state that isn't already at a well-known host location. */
export const EDGE_HOST_STATE_DIR = "/var/lib/openship/edge";

/**
 * Where the edge container's state lives ON THE HOST, and where it's mounted
 * inside the container.
 *
 * Certs and static docroots keep the SAME path on both sides deliberately: every
 * host-side reader we already have (the migrate proxy scan, `carrySourceCerts`,
 * cert reuse, the mail server's cert symlinks) then keeps working with no
 * translation, and a bare→container conversion inherits the box's existing certs
 * instead of orphaning them. Bind mounts, never named volumes — Docker-managed
 * volumes make edge state invisible to host tooling, which is what silently broke
 * domain/SSL detection in the migrate wizard.
 */
export const EDGE_CONTAINER_MOUNTS: ReadonlyArray<{ host: string; container: string }> = [
  { host: `${EDGE_HOST_STATE_DIR}/sites-enabled`, container: OPENRESTY_DEFAULT_PATHS.sitesDir },
  { host: "/etc/letsencrypt", container: "/etc/letsencrypt" },
  { host: `${EDGE_HOST_STATE_DIR}/acme`, container: "/var/www/acme" },
  { host: "/opt/openship/static", container: "/opt/openship/static" },
];

/**
 * Paths for driving a containerized edge from OUTSIDE the container — i.e. over
 * SSH to the box it runs on.
 *
 * Deliberately mixed, and the split is the whole point: `sitesDir` is the HOST
 * path (vhost files are written straight to the bind-mounted directory), while
 * `bin` and `pidPath` are CONTAINER paths (commands run via `docker exec`).
 * `confPath` is baked into the image and must never be written — the container
 * edge skips `ensureOpenRestyConfig` entirely.
 */
export const EDGE_HOST_PATHS: OpenRestyPaths = {
  bin: OPENRESTY_DEFAULT_PATHS.bin,
  confPath: OPENRESTY_DEFAULT_PATHS.confPath,
  confDir: OPENRESTY_DEFAULT_PATHS.confDir,
  sitesDir: `${EDGE_HOST_STATE_DIR}/sites-enabled`,
  pidPath: OPENRESTY_DEFAULT_PATHS.pidPath,
};

/** Well-known nginx.conf locations across OpenResty packages. */
const KNOWN_CONF_PATHS = [
  "/usr/local/openresty/nginx/conf/nginx.conf",
  "/etc/openresty/nginx.conf",
  "/etc/nginx/nginx.conf",
];

/**
 * Detect the actual OpenResty paths on a server by parsing `openresty -V`.
 *
 * After parsing, validates that the detected conf file actually exists.
 * If not, probes known alternative locations. This handles scenarios
 * where OpenResty was reinstalled and the config directory changed.
 */
export async function detectOpenRestyPaths(
  executor: CommandExecutor,
): Promise<OpenRestyPaths> {
  const raw = await executor.exec("openresty -V 2>&1 || true");

  const parseFlag = (flag: string): string | null => {
    const m = raw.match(new RegExp(`--${flag}=([^\\s]+)`));
    return m ? m[1] : null;
  };

  const bin = parseFlag("sbin-path") ?? OPENRESTY_DEFAULT_PATHS.bin;
  let confPath = parseFlag("conf-path") ?? OPENRESTY_DEFAULT_PATHS.confPath;
  const pidPath = parseFlag("pid-path") ?? OPENRESTY_DEFAULT_PATHS.pidPath;

  // Verify the detected confPath actually exists on disk.
  // After a reinstall, the config may be at a different location.
  if (!(await executor.exists(confPath))) {
    let found = false;
    for (const candidate of KNOWN_CONF_PATHS) {
      if (candidate !== confPath && await executor.exists(candidate)) {
        confPath = candidate;
        found = true;
        break;
      }
    }
    if (!found) {
      // Config doesn't exist yet - use the detected/default path.
      // ensureOpenRestyConfig() will bootstrap a minimal config file.
    }
  }

  const confDir = confPath.replace(/\/[^/]+$/, "");
  const nginxVersion = parseNginxVersion(raw);

  return {
    bin,
    confPath,
    confDir,
    sitesDir: `${confDir}/sites-enabled`,
    pidPath,
    ...(nginxVersion ? { nginxVersion } : {}),
  };
}

// ── Reload command builder ───────────────────────────────────────────────────

/**
 * Build the OpenResty reload command from detected paths.
 *
 * Primary (both modes): `openresty -t` then `-s reload` — graceful, zero-downtime.
 *
 * What happens when reload FAILS is where this gets dangerous, because the wrong
 * recovery takes every site on the box down. Three layers, in order:
 *
 *   1. `opts.containerEdge` — set by the two container-edge providers, so for the
 *      paths we control the command CONTAINS no kill at all. Nothing to reason
 *      about at runtime.
 *   2. `/proc/1/comm` — a runtime backstop for any path that reaches the bare
 *      command while actually running inside the edge container (a caller that
 *      forgot the flag, `ensureLuaScripts` on a containerized box). The master IS
 *      pid 1 there, so `pkill` kills the container's init: the `docker exec`
 *      returns non-zero, registerRoute's self-rollback restores the PREVIOUS
 *      vhost, and the deploy reports "Routing failed" while every site blips.
 *      Restarting a dead master is the supervisor's job in that mode — fail
 *      loudly, surfacing the reload's real stderr.
 *   3. BARE host — a failed reload usually does mean "not running", so starting it
 *      is right. But recover WITHOUT a pattern kill: `pkill -f openresty` also
 *      matches a host-networked edge CONTAINER's master (see edge-check.test.ts),
 *      so the blind kill could take down the very edge it was recovering. Only
 *      start when no live master holds the pid file; otherwise report it rather
 *      than killing a process we can't identify.
 */
export function buildReloadCommand(
  paths: OpenRestyPaths,
  opts: { containerEdge?: boolean } = {},
): string {
  if (opts.containerEdge) {
    return `${paths.bin} -t 2>&1 || exit 1
${paths.bin} -s reload 2>&1 || exit 1`;
  }

  return `${paths.bin} -t 2>&1 || exit 1

reload_err=$(${paths.bin} -s reload 2>&1) && exit 0

if [ "$(cat /proc/1/comm 2>/dev/null)" = "openresty" ] || [ "$(cat /proc/1/comm 2>/dev/null)" = "nginx" ]; then
  echo "openresty reload failed and openresty is PID 1 (containerized edge) — not killing it; the container supervisor owns restarts." >&2
  echo "$reload_err" >&2
  exit 1
fi

if [ -f ${paths.pidPath} ] && kill -0 "$(cat ${paths.pidPath} 2>/dev/null)" 2>/dev/null; then
  echo "openresty (pid $(cat ${paths.pidPath})) is running but refused -s reload" >&2
  exit 1
fi

rm -f ${paths.pidPath}
${paths.bin}`;
}

/**
 * Ensure the placeholder certificate the :443 catch-all presents for unrouted
 * hostnames exists, creating it if not. Returns null when it could not be produced.
 *
 * Only the BARE/legacy edge needs this: the container edge gets the same pair baked
 * into its image at build time, where it cannot be missing.
 *
 * Never throws, and returning null is a real outcome rather than a formality — the
 * caller then writes the `ssl_reject_handshake` catch-all instead. Naming a
 * certificate that is not on disk does not degrade the page, it stops OpenResty
 * loading the config at all: `openresty -t` fails, so the deploy's reload is
 * refused and every subsequent route change on the box is refused with it. A box
 * with no openssl keeps the unfriendly TLS error; it does not lose routing.
 *
 * 10 years, like the per-domain bootstrap cert in nginx.ts: nothing trusts this
 * cert, so a short life buys no security, while an EXPIRED one would put the box
 * back to a hard TLS failure on a date nobody is watching.
 *
 * EC P-256 rather than the RSA-2048 used per-domain, because this key signs a
 * DIFFERENT kind of traffic. `ssl_reject_handshake` aborted in the servername
 * callback, before any asymmetric work; presenting a certificate means every
 * connection to an unrouted host now costs a real signature — and the case #431 is
 * about is wildcard DNS aimed at the box, i.e. unbounded distinct hostnames all
 * landing here. P-256 signing is roughly an order of magnitude cheaper than
 * RSA-2048, so the page does not come with a cheap amplifier attached. (It also
 * keygens in milliseconds instead of seconds, which matters on the bare path where
 * this runs inline in a deploy.)
 */
async function ensureEdgeDefaultCert(
  executor: CommandExecutor,
  confDir: string,
): Promise<{ certPath: string; keyPath: string } | null> {
  const { dir, certPath, keyPath } = edgeDefaultCertPaths(confDir);
  try {
    if ((await executor.exists(certPath)) && (await executor.exists(keyPath))) {
      return { certPath, keyPath };
    }
  } catch {
    return null;
  }

  // Unique per attempt, like ensureBootstrapCert's. A shared `${dir}.staging` that
  // we pre-clear is a race between two concurrent deploys to the same box: the
  // second one's cleanup deletes the first one's staging mid-openssl, so the first
  // writes the `ssl_reject_handshake` fallback and the box silently regresses to a
  // TLS error until some later deploy happens to win.
  const staging = `${dir}.staging-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    await executor.mkdir(staging);
    // Remote executors run through a login shell, so every argument is quoted even
    // though these are all derived from our own constants.
    await executor.exec(
      `openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 3650 ` +
        `-subj ${sq(`/CN=${EDGE_DEFAULT_CERT_CN}`)} ` +
        `-keyout ${sq(`${staging}/privkey.pem`)} -out ${sq(`${staging}/fullchain.pem`)} 2>/dev/null`,
    );
    // Before the move, so the key is never readable at its final path. OpenSSL 3
    // already writes `-keyout` 0600, but that has not always been true and this
    // runs on whatever openssl a legacy box happens to have.
    await executor.exec(`chmod 600 ${sq(`${staging}/privkey.pem`)}`);
    await executor.mkdir(dir);
    // Move the pair together: OpenResty must never see a cert beside a key that
    // does not open it, which is what a reload racing a half-written dir would get.
    await executor.exec(
      `mv -f ${sq(`${staging}/fullchain.pem`)} ${sq(`${staging}/privkey.pem`)} ${sq(dir)}/`,
    );
    if (!(await executor.exists(certPath)) || !(await executor.exists(keyPath))) return null;
    return { certPath, keyPath };
  } catch (err) {
    console.warn(
      `[openresty] could not create the edge's default certificate — an unrouted HTTPS host ` +
        `will get a TLS error instead of the "service not found" page ` +
        `(is openssl installed?): ${safeErrorMessage(err)}`,
    );
    return null;
  } finally {
    await executor.rm(staging).catch(() => undefined);
  }
}

/**
 * Ensure OpenResty config is ready for routing.
 *
 * Idempotent - safe to call on every platform init. Creates the
 * sites-enabled directory and adds the include directive to nginx.conf
 * if missing. Also creates the ACME challenge directory.
 *
 * This runs ONCE at platform startup, not per-request.
 */
export async function ensureOpenRestyConfig(
  executor: CommandExecutor,
  paths: OpenRestyPaths,
): Promise<void> {
  await executor.mkdir(paths.sitesDir);
  await executor.mkdir("/var/www/acme");
  // Ensure the logs/PID directory exists - OpenResty refuses to start without it.
  const pidDir = paths.pidPath.replace(/\/[^/]+$/, "");
  await executor.mkdir(pidDir);

  // Base server blocks: the loopback management API and the default catch-all
  // (incl. the 443 default that owns unmatched SNI). Written here - not just at
  // install - so an already-deployed box self-heals the catch-all on its next
  // deploy and no longer cross-serves an unrouted HTTPS host. Idempotent overwrite
  // of static content; a stale copy is replaced. The deploy's route reload applies
  // it, and that reload is why the cert is resolved FIRST: a config naming a
  // missing ssl_certificate fails `openresty -t`, which rejects the reload and
  // freezes every later route change on the box.
  const defaultCert = await ensureEdgeDefaultCert(executor, paths.confDir);
  await executor.writeFile(`${paths.sitesDir}/_management.conf`, MANAGEMENT_BLOCK);
  await executor.writeFile(`${paths.sitesDir}/_default.conf`, edgeDefaultCatchAllConf(defaultCert));

  // Bootstrap: if nginx.conf doesn't exist (e.g. after a reinstall that
  // removed the old config), write a minimal working config.
  if (!(await executor.exists(paths.confPath))) {
    await executor.mkdir(paths.confDir);
    await executor.writeFile(
      paths.confPath,
      MINIMAL_NGINX_CONF(paths.confDir, paths.sitesDir),
    );
    return; // Fresh config already has the include - no sed needed.
  }

  // Check if the EXACT correct include path is already present
  const hasCorrectInclude = await executor
    .exec(`grep -qF 'include ${paths.sitesDir}/' ${paths.confPath}`)
    .then(() => true)
    .catch(() => false);

  if (!hasCorrectInclude) {
    // Check if a WRONG sites-enabled include exists (different directory)
    const hasWrongInclude = await executor
      .exec(`grep -q 'include.*sites-enabled' ${paths.confPath}`)
      .then(() => true)
      .catch(() => false);

    if (hasWrongInclude) {
      // Replace the wrong include path with the correct one
      await executor.exec(
        `sed -i 's|include.*/sites-enabled/\\*\\.conf;|include ${paths.sitesDir}/*.conf;|' ${paths.confPath}`,
      );
    } else {
      // No include at all - add one inside http {}
      await executor.exec(
        `sed -i '/http *{/a \\    include ${paths.sitesDir}/*.conf;' ${paths.confPath}`,
      );
    }
  }
}

/** Minimal nginx.conf that OpenResty can boot with. */
function MINIMAL_NGINX_CONF(confDir: string, sitesDir: string): string {
  return `# Auto-generated by Openship - safe to extend
worker_processes auto;
events {
    worker_connections 1024;
}
http {
    include       ${confDir}/mime.types;
    default_type  application/octet-stream;
    sendfile      on;
    keepalive_timeout 65;
    # See EDGE_SERVER_NAMES_HASH_BUCKET_SIZE — the 64-byte default fails
    # \`nginx -t\` outright for any server_name past ~63 chars, refusing the reload
    # and wedging every route on the box, not just the long one.
    server_names_hash_bucket_size ${EDGE_SERVER_NAMES_HASH_BUCKET_SIZE};
    include ${sitesDir}/*.conf;
}
`;
}
export const GEOIP_DIR = "/usr/share/GeoIP";
export const GEOIP_DB_PATH = `${GEOIP_DIR}/GeoLite2-Country.mmdb`;
/**
 * Fallback download source for a BARE box only — the container edge bakes the DB
 * in (apps/edge/Dockerfile), so this is never the shipping path.
 *
 * Points at OUR vendored copy, matching apps/api/src/lib/geo-ip.ts. It used to
 * point at a third-party mirror (P3TERX/GeoLite.mmdb releases/latest), which
 * contradicted the stance that stands one directory over in
 * apps/api/assets/geoip/README.md: production reads a copy we ship, and the only
 * upstream reference belongs in a maintainer-time script (`bun run update:geoip`).
 */
const GEOIP_DB_URL =
  process.env.OPENSHIP_GEOIP_URL?.trim() ||
  "https://raw.githubusercontent.com/oblien/openship/main/apps/api/assets/geoip/GeoLite2-Country.mmdb";

// ── Local Lua source directory ───────────────────────────────────────────────

// Optional on-disk source of the .lua scripts, for dev / Docker / CLI bundle
// where the files sit next to this module (edit + reload works). This is only a
// convenience — the base64 EMBEDDED_LUA copy is the atomic guarantee that ships
// inside the JS. OPENSHIP_LUA_DIR lets an operator point at hand-edited scripts.
const LUA_SRC_DIR =
  process.env.OPENSHIP_LUA_DIR?.trim() || join(dirname(fileURLToPath(import.meta.url)), "lua");

/** The scripts a generated nginx server block hard-depends on — if these aren't
 *  installable, the vhost MUST omit its `*_by_lua_file` directives (else every
 *  request 500s on a missing file). `rules_guard.lua` (access phase) does a
 *  non-pcall `require "openship.rules_lib"`, so rules_lib is a hard dep too;
 *  `site_logger.lua` (log phase) only soft-pcalls geo/pipe, so it stands alone.
 *  See `luaSourceAvailable`. */
const VHOST_REFERENCED_LUA = ["rules_guard.lua", "rules_lib.lua", "site_logger.lua"] as const;

/**
 * True when the vhost-referenced Lua can be installed — from disk OR from the
 * embedded base64 copy. Since the scripts are embedded (see scripts/embed-lua),
 * this is effectively always true; it stays as a fail-safe signal so that if the
 * embedded module were ever emptied, the vhost builder omits the `*_by_lua_file`
 * directives (edge rules/logging off, sites UP) rather than 500ing every request.
 */
export function luaSourceAvailable(): boolean {
  return VHOST_REFERENCED_LUA.every(
    (f) => EMBEDDED_LUA[f] !== undefined || existsSync(join(LUA_SRC_DIR, f)),
  );
}

/**
 * Return a Lua script's contents. Prefers the on-disk source (dev / Docker /
 * CLI bundle — lets you edit lua/*.lua and reload) and falls back to the base64
 * EMBEDDED_LUA copy, which is what makes the scripts atomic in a compiled binary
 * / bundle where no module-relative path resolves. Throws only if a script is
 * absent from BOTH — i.e. it was never embedded (run `bun run embed:lua`).
 */
function readLua(filename: string): string {
  const onDisk = join(LUA_SRC_DIR, filename);
  if (existsSync(onDisk)) return readFileSync(onDisk, "utf-8");
  const embedded = EMBEDDED_LUA[filename];
  if (embedded !== undefined) return Buffer.from(embedded, "base64").toString("utf-8");
  throw new Error(
    `Lua script "${filename}" not found on disk (${LUA_SRC_DIR}) or in EMBEDDED_LUA — ` +
      `add it to packages/adapters/src/infra/lua/ and run \`bun run embed:lua\`.`,
  );
}

// ── Management server block ──────────────────────────────────────────────────

/**
 * The internal analytics + live-log server block. Loopback only — reached by the
 * api over the Docker network or an SSH tunnel, never publicly exposed.
 *
 * Shared with the baked container config (`bakedEdgeNginxConf`), which nests it
 * inside `http {}` instead of writing it as its own `sites-enabled` file.
 */
export const EDGE_MGMT_SERVER_BLOCK = `\
server {
    listen 127.0.0.1:${OPENRESTY_MGMT_PORT};

    # Long-running Lua content handlers need generous timeouts
    send_timeout          3600s;
    keepalive_timeout     3600s;
    lua_check_client_abort on;

    # SSE live-log stream (long-lived connection)
    location = /logs/stream {
        content_by_lua_file ${OPENRESTY_LUA_DIR}/pipe_stream.lua;
    }

    # REST analytics + health (short-lived)
    location / {
        content_by_lua_file ${OPENRESTY_LUA_DIR}/mgmt_api.lua;
    }
}`;

const MANAGEMENT_BLOCK = `\
# Openship internal management - analytics & live-log streaming
# Auto-generated - do not edit manually
${EDGE_MGMT_SERVER_BLOCK}
`;

/**
 * Loopback port certbot's `--standalone` authenticator listens on during
 * issuance. The edge proxies `/.well-known/acme-challenge/` to it, so HTTP-01
 * works with ZERO downtime — no port-80 fight with the edge, no webroot
 * dependency, no DNS-01. Fixed high port, outside the usual app/user range.
 * Certbot binds it only transiently; it just needs to be reachable from the
 * edge on loopback. Identical for bare (host netns) and docker-edge (container
 * netns), since certbot runs on the same executor/netns as the edge.
 */
export const ACME_HTTP01_PORT = 49180;

/**
 * The `/.well-known/acme-challenge/` location block — proxies the HTTP-01
 * challenge to certbot's transient standalone server. SHARED by the default
 * catch-all here and the per-vhost templates in nginx.ts so all three agree.
 */
export const ACME_CHALLENGE_LOCATION = `\
    location /.well-known/acme-challenge/ {
        proxy_pass http://127.0.0.1:${ACME_HTTP01_PORT};
        proxy_set_header Host $host;
    }`;

/**
 * URL prefix Openship Cloud's shared edge fetches to prove this box controls a
 * routing target. Oblien issues `<prefix><token>` and expects the token back as
 * the body with a 200.
 */
export const EDGE_CHALLENGE_URL_PREFIX = "/.well-known/oblien-proxy-challenge/";

/**
 * Doc root for those tokens, and the directory they are written to.
 *
 * A SUB-directory of the ACME webroot, not the webroot itself, for two reasons:
 * it keeps our files clear of anything that ever re-uses `/var/www/acme`, and
 * `nginx.test.ts` asserts a vhost contains no `root /var/www/acme;` — that
 * assertion means "ACME is proxied to certbot, never served from a webroot", and
 * it should keep meaning that.
 *
 * `/var/www/acme` is the CONTAINER path, and it is already bind-mounted in every
 * mode (see EDGE_CONTAINER_MOUNTS) while being served by nothing since ACME moved
 * to the standalone proxy — so this needs no new mount. Adding one would in fact
 * be unworkable: the mount list is baked into the `docker run` argv, so it only
 * takes effect on container RECREATE, and a rollback to an older release would
 * recreate with the old list and lose the tokens.
 */
export const EDGE_CHALLENGE_ROOT = "/var/www/acme/oblien";
export const EDGE_CHALLENGE_DIR = `${EDGE_CHALLENGE_ROOT}${EDGE_CHALLENGE_URL_PREFIX}`.replace(/\/$/, "");

/**
 * The same directory as seen from the HOST, for the one provider whose file ops
 * land outside the container.
 *
 * This mount is the exception to the rule: every other edge mount keeps the same
 * path on both sides on purpose, and `acme` does not
 * (`/var/lib/openship/edge/acme` → `/var/www/acme`). Forgetting that is a mistake
 * with history here — see the mail-SSL webroot note.
 */
export const EDGE_CHALLENGE_HOST_DIR = `${EDGE_HOST_STATE_DIR}/acme/oblien${EDGE_CHALLENGE_URL_PREFIX}`.replace(
  /\/$/,
  "",
);

/**
 * The location that serves those tokens. SHARED by the per-vhost templates in
 * nginx.ts, the per-target challenge vhost, and the baked container config — so
 * every place that can receive the edge's probe agrees.
 *
 * Deliberately NOT in the bare catch-all (`edgeDefaultCatchAllConf`), and the reason
 * is that no catch-all is the mechanism here. The container edge is the only INSTALL
 * path and skips `ensureOpenRestyConfig`; the bare catch-all is still evaluated on
 * every deploy to a legacy bare box or a Docker-less server (see `platform.ts`), so
 * it is legacy-but-live, not dead. Either way both catch-alls are version-pinned to
 * whatever that box last got — the baked one to its image, the bare one to a
 * `_default.conf` written once and only patched thereafter — so neither can be
 * relied on to carry a location added later.
 *
 * What IS relied on is the per-target challenge vhost (`serveEdgeChallenge`): our own
 * code writes it into the bind-mounted sites-enabled on every edge-ensure, so it
 * reaches a box on an old image, a rolled-back one, and a bare one alike. The
 * catch-alls are belt-and-braces; the baked image gets the location because it costs
 * nothing there, and the bare one does not because emitting it into a file we only
 * ever patch would read like coverage that arrives, and it wouldn't.
 *
 * Token-agnostic in config, token-specific in data. Two things follow, and both
 * matter: issuing a token is a file write with no config edit and no reload, AND the
 * vhost can be created BEFORE any token exists — which is what lets the box be ready
 * from first install instead of only once a verification is in flight.
 *
 * `try_files $uri =404` means only tokens we actually wrote are served. That is a
 * security property, not a detail — a handler that echoed the token back out of the
 * URL would let anyone register THIS box as THEIR target, prove control with our own
 * reply, and point their slug at us.
 */
export const EDGE_CHALLENGE_LOCATION = `\
    location ${EDGE_CHALLENGE_URL_PREFIX} {
        root ${EDGE_CHALLENGE_ROOT};
        default_type text/plain;
        try_files $uri =404;
    }`;

/**
 * The per-target challenge vhost, written to
 * `sites-enabled/_oblien-challenge-<slug>.conf` by `serveEdgeChallenge` on every
 * edge-ensure. Exported so the proxy-scanner tests can feed the REAL bytes: this
 * file lands in sites-enabled on every box, container and bare alike, so it is
 * parsed back by every scan that reads a vhost.
 *
 * `host` must already be validated (`assertValidDomain`) — it is interpolated into
 * a config the edge loads.
 *
 * It carries the shared not-found page because a named `server_name` beats the
 * catch-all for EVERY URI of that host, not just the challenge one. Without a
 * `location /` nginx fell through to its compiled-in `root html; index index.html`
 * and answered a plain visit with OpenResty's welcome page — version banner and
 * all — which is exactly the direct-IP case #431 reported (edge-ensure passes the
 * box's own IP as a routing target, so this vhost claims it).
 */
export function edgeChallengeVhostConf(host: string): string {
  return `# Auto-generated by Openship - do not edit manually
# openship-oblien-challenge: answers ${EDGE_CHALLENGE_URL_PREFIX}<token> for
# Host: ${host}, so Openship Cloud's shared edge can prove this box controls that
# routing target. Everything else gets the shared not-found page - this is
# scaffolding, not a site.
server {
    listen 80;
    server_name ${host};

${EDGE_CHALLENGE_LOCATION}

${EDGE_NOT_FOUND_LOCATION}
}
`;
}

/**
 * The HTTPS catch-all with NO certificate to present — the fallback, kept for the
 * one case that can still reach it: a bare box where we could not produce the
 * placeholder cert (no openssl, unwritable conf dir).
 *
 * BARE-ONLY, despite the shared-looking name: the baked container config always has
 * a certificate (the image creates it at build time, and could not start without
 * it), so it renders the block below this one and never this one. Reaching this is
 * a bare box that failed to produce the placeholder.
 *
 * The long comment is carried in the config text rather than only here because the
 * RATIONALE is the part that must not drift: a reader who thinks this block is
 * decorative will delete it from whichever copy they happen to be holding — and
 * deleting it hands unmatched SNI to another app's vhost.
 */
export const EDGE_HTTPS_REJECT_BLOCK = `\
# HTTPS catch-all. WITHOUT a 443 default_server, nginx serves the first-loaded
# 443 vhost to any request whose SNI matches no server_name - so a domain we do
# NOT route (removed / never-added / just pointed at this IP) silently gets some
# other app's cert + backend. That is cross-serving, a security hole. Owning the
# 443 default closes it: an unrouted host is answered HERE, never by a fallthrough.
#
# This is the no-certificate variant, used only when the placeholder cert could not
# be created. It refuses the handshake, so the visitor gets a raw TLS error and a
# Cloudflare-proxied host gets error 525 - correct, but unfriendly. See
# edgeHttpsDefaultBlock. ssl_reject_handshake (OpenResty/nginx >= 1.19.4; our
# installer pulls the newest LTS) needs no certificate.
server {
    listen 443 ssl default_server;
    ssl_reject_handshake on;
}`;

/**
 * The HTTPS catch-all, serving the branded not-found page (#431).
 *
 * Rejecting the handshake was right about the security question and wrong about the
 * visitor: a mistyped subdomain, or a wildcard DNS record aimed at this box, got
 * `ERR_SSL_UNRECOGNIZED_NAME_ALERT` — and behind Cloudflare, whose "Full" mode does
 * not validate the origin certificate, it got error 525 on a page CF served in our
 * name. Presenting a self-signed placeholder lets the handshake complete so the
 * request reaches a page that says what is actually wrong.
 *
 * The cross-serving hole this block exists to close stays closed, and the reason is
 * structural rather than a property of the certificate: we still OWN
 * `443 ssl default_server`, so an unmatched SNI can never fall through to some
 * other app's vhost. What it now gets is our own dead-end block — one
 * `ssl_certificate` that belongs to no domain, no `proxy_pass`, no `root`, nothing
 * but a `return`. Nothing trusts the placeholder, so possessing its key
 * impersonates nothing: a direct visitor still sees a browser warning, exactly as
 * they do today for a domain whose real cert has not been issued yet.
 *
 * Stated precisely, because "closed" is doing narrower work than it was: nginx picks
 * the virtual server twice for HTTPS — by SNI for the handshake, then by `Host:` for
 * the request. Completing a handshake here therefore lets a client go on to name any
 * vhost on the box by `Host:` and reach it. That is not an escalation (the same
 * client could have sent that name as its SNI and been routed there properly, and
 * the per-vhost `access_by_lua_file` rules still run in the access phase, after the
 * Host-selected server is set) — but it does mean the guarantee is now about the
 * CERTIFICATE, not the backend. Never add an `ssl_certificate` at `http` scope: this
 * block would inherit a real domain's cert and the guarantee would be gone.
 *
 * Two things this does not fix, so nobody promises them: Cloudflare "Full (Strict)"
 * validates the origin certificate and will reject the placeholder, turning error
 * 525 into 526 — same class of unfriendly page, and the only answers remain Full,
 * grey-cloud, or a CF Origin CA cert. And a browser holding an HSTS pin for a
 * hostname that once had a real cert hard-fails on the placeholder with no
 * click-through. (Which is why this block must never send HSTS itself.)
 */
export function edgeHttpsDefaultBlock(
  cert?: { certPath: string; keyPath: string } | null,
): string {
  if (!cert) return EDGE_HTTPS_REJECT_BLOCK;
  return `\
# HTTPS catch-all. WITHOUT a 443 default_server, nginx serves the first-loaded
# 443 vhost to any request whose SNI matches no server_name - so a domain we do
# NOT route (removed / never-added / just pointed at this IP) silently gets some
# other app's cert + backend. That is cross-serving, a security hole. Owning the
# 443 default closes it: an unrouted host is answered HERE, never by a fallthrough.
#
# The cert below belongs to no domain and is trusted by nothing - it exists so the
# handshake COMPLETES and the request can be answered with a page instead of
# ERR_SSL_UNRECOGNIZED_NAME_ALERT (Cloudflare "Full" reports the refusal as error
# 525; "Full (Strict)" validates the cert and will still show 526). Keep this block a
# dead end: no proxy_pass, no root, no HSTS, no reuse of a real certificate - that is
# what stops it from becoming the cross-serving it prevents. And never set
# ssl_certificate at http scope: this block would inherit a real domain's cert.
server {
    listen 443 ssl default_server;
    server_name _;

    ssl_certificate ${cert.certPath};
    ssl_certificate_key ${cert.keyPath};

${EDGE_NOT_FOUND_LOCATION}
}`;
}

/**
 * The bare edge's catch-all pair, written to `sites-enabled/_default.conf`.
 *
 * Takes the placeholder cert rather than baking a path in, because on a bare box
 * the file may not exist: nginx refuses to load a config whose `ssl_certificate` is
 * missing, and refusing to load means `openresty -t` fails, the reload is rejected,
 * and NO route change lands on that box again. Passing null falls back to
 * `ssl_reject_handshake`, which is where this box already was.
 *
 * Exported so the `sanitizeEdgeVhosts` guard can be tested against the bytes we
 * actually write. That pairing is load-bearing: a bare→container conversion copies
 * this file into the edge's mounted sites-enabled, where a SECOND
 * `443 ssl default_server` beside the image's own is `[emerg] a duplicate default
 * server` — a permanent crash loop. It survives because the sanitizer's rule is
 * per-FILE and negative: it drops any conf where NO line declares a `server_name`
 * other than `_`. So the pair goes as a unit, and it keeps going even in the
 * no-cert case where the 443 block carries no `server_name` at all. Adding a real
 * hostname to either block — for any reason — would make the sanitizer keep the
 * file and hand the container the duplicate default it exists to prevent.
 */
export function edgeDefaultCatchAllConf(
  cert?: { certPath: string; keyPath: string } | null,
): string {
  return `\
# Openship default catch-all - prevents the stock OpenResty welcome page AND
# stops an unmatched Host/SNI from being served the first real vhost by default.
# Auto-generated - do not edit manually
server {
    listen 80 default_server;
    server_name _;

${ACME_CHALLENGE_LOCATION}

${EDGE_NOT_FOUND_LOCATION}
}

${edgeHttpsDefaultBlock(cert)}
`;
}

// ── Deployment ───────────────────────────────────────────────────────────────

const LUA_SCRIPTS = [
  "site_logger.lua",
  "pipe_stream.lua",
  "mgmt_api.lua",
  "geo_country.lua",
  // Vendored FFI binding geo_country requires as `openship.maxminddb`. Ships with
  // the rest so a bare box needs no `opm get` (which needs perl) — see the file
  // header. Flat, like every other script: ensureLuaScripts writes this list into
  // one directory and its presence scan is a plain `ls -1`.
  "maxminddb.lua",
  "rules_lib.lua",
  "rules_guard.lua",
] as const;

/** Version stamp so the self-heal detects a STALE box (an upgrade shipped new
 *  Lua) as well as a missing one. Dotfile → excluded from `require` + from the
 *  plain `ls -1` presence scan below. */
const LUA_VERSION_MARKER = `${OPENRESTY_LUA_DIR}/.openship-lua-version`;

/** sha256 over the exact bytes we'd install, so any script edit changes it. */
function luaBundleHash(): string {
  const h = createHash("sha256");
  for (const name of LUA_SCRIPTS) {
    h.update(name);
    h.update("\0");
    h.update(readLua(name));
    h.update("\0");
  }
  return h.digest("hex");
}

/**
 * Health-chain ensure/repair: guarantee the Lua on the box is both PRESENT and
 * CURRENT — reinstall (all scripts + version stamp) and reload OpenResty when
 * any script is missing OR the on-box version differs from this build. CHEAP on
 * the happy path (one `ls` + one marker read, no writes; no geo/opm/GeoLite —
 * that's deployLuaScripts), so it runs on every self-hosted deploy's edge-ensure.
 *
 * This is the self-heal for the "box lost its Lua → every managed vhost 500s"
 * outage: a box whose scripts vanished (OpenResty reinstall, manual rm, a build
 * that once shipped without them) OR whose scripts are stale after an upgrade
 * gets fixed on the next deploy instead of staying down / running old rules.
 *
 * NEVER THROWS — a deploy must proceed even if repair fails: the whole body is
 * guarded, and the vhost builder independently degrades to no-Lua when it's
 * genuinely unavailable.
 */
export async function ensureLuaScripts(
  executor: CommandExecutor,
  paths: OpenRestyPaths,
): Promise<{ repaired: string[]; available: boolean }> {
  try {
    if (!luaSourceAvailable()) {
      // Only reachable if the embedded module was gutted. Do NOT throw — the
      // vhost builder omits the *_by_lua_file directives so sites stay up.
      console.error(
        "[openresty] Lua unavailable in this build (not on disk or embedded) — edge " +
          "rules/logging disabled. Run `bun run embed:lua` in packages/adapters.",
      );
      return { repaired: [], available: false };
    }

    const expected = luaBundleHash();
    await executor.mkdir(OPENRESTY_LUA_DIR);

    // One listing beats a stat per script. OPENRESTY_LUA_DIR is a fixed,
    // metachar-free constant; single-quote it anyway per the remote-exec rule.
    const listing = await executor
      .exec(`ls -1 '${OPENRESTY_LUA_DIR}' 2>/dev/null || true`)
      .catch(() => "");
    const present = new Set(listing.split("\n").map((s) => s.trim()).filter(Boolean));
    const missing = LUA_SCRIPTS.filter((name) => !present.has(name));
    // Read the marker directly (it's a dotfile, so `ls -1` won't list it).
    const onBoxVersion = (await executor.readFile(LUA_VERSION_MARKER).catch(() => "")).trim();

    if (missing.length === 0 && onBoxVersion === expected) {
      return { repaired: [], available: true }; // happy path: present + current
    }

    // Rewrite ALL scripts (fixes both a missing script and a stale set), then
    // stamp the version last so a crash mid-write leaves it stale (safe: retried
    // next deploy) rather than falsely current.
    for (const name of LUA_SCRIPTS) {
      await executor.writeFile(`${OPENRESTY_LUA_DIR}/${name}`, readLua(name));
    }
    await executor.writeFile(LUA_VERSION_MARKER, expected);

    const reason = missing.length ? `missing: ${missing.join(", ")}` : "version changed";
    console.warn(`[openresty] (re)installed Lua (${reason}) — reloading edge.`);
    // Reload so OpenResty picks up the scripts (a vhost that had been 500ing on
    // a missing file recovers; fresh workers get a fresh Lua VM). Best-effort.
    await executor.exec(buildReloadCommand(paths)).catch((err) => {
      console.error(`[openresty] reload after Lua (re)install failed: ${safeErrorMessage(err)}`);
    });

    return { repaired: missing.length ? missing : [...LUA_SCRIPTS], available: true };
  } catch (err) {
    // Contract: never throw. A repair failure must not abort the deploy.
    console.error(`[openresty] ensureLuaScripts failed (deploy continues): ${safeErrorMessage(err)}`);
    return { repaired: [], available: false };
  }
}

/**
 * Install libmaxminddb (the C library geo_country's FFI binding loads) and place
 * the GeoLite2 database — for a BARE box. The container edge bakes both in
 * (apps/edge/Dockerfile), which is the shipping path.
 *
 * No `opm get` any more: the Lua binding is vendored as `maxminddb.lua` and
 * installed with the rest of LUA_SCRIPTS. opm needs perl, which the openresty
 * alpine base doesn't ship, so that step could never have worked there.
 *
 * Non-fatal - if any step fails the analytics pipeline still works,
 * geo_country.lua just returns nil for every lookup (and `GET /status` says why).
 */
async function installGeoDeps(executor: CommandExecutor): Promise<void> {
  // ── 1. libmaxminddb (C library) ───────────────────────────────────────
  // Detect package manager on the remote server and install accordingly.
  try {
    const hasPkg = async (cmd: string) => {
      try { await executor.exec(`command -v ${cmd}`); return true; }
      catch { return false; }
    };

    if (await hasPkg("apt-get")) {
      await executor.exec(
        "apt-get update -qq && apt-get install -y -qq libmaxminddb0 libmaxminddb-dev",
      );
    } else if (await hasPkg("dnf")) {
      await executor.exec("dnf install -y libmaxminddb libmaxminddb-devel");
    } else if (await hasPkg("yum")) {
      await executor.exec("yum install -y libmaxminddb libmaxminddb-devel");
    } else if (await hasPkg("apk")) {
      // Alpine — the openresty base image's distro, and the branch whose absence
      // meant geo could never initialise on a containerized edge.
      await executor.exec("apk add --no-cache libmaxminddb");
    }
  } catch {
    // Non-fatal - geo just won't work
  }

  // ── 2. GeoLite2-Country database ──────────────────────────────────────
  try {
    const exists = await executor.exists(GEOIP_DB_PATH);
    if (!exists) {
      await executor.mkdir(GEOIP_DIR);
      await executor.exec(
        `curl -fsSL -o ${GEOIP_DB_PATH} "${GEOIP_DB_URL}"`,
      );
    }
  } catch {
    // Non-fatal
  }
}

/**
 * Deploy Lua analytics scripts and configure OpenResty shared-dict zones.
 *
 * Reads .lua files from the local lua/ directory, writes them to the
 * managed server, patches nginx.conf with shared-dict + lua_package_path
 * directives, installs geo dependencies, writes the management server
 * block, then validates and reloads.
 */
export async function deployLuaScripts(
  executor: CommandExecutor,
  paths: OpenRestyPaths,
): Promise<void> {
  // ── Install geo dependencies (non-fatal) ─────────────────────────────
  await installGeoDeps(executor);

  // ── Write Lua files ──────────────────────────────────────────────────
  // Loud-fail if neither the on-disk source NOR the embedded base64 copy has
  // the edge scripts (only possible if the embedded module was gutted): without
  // them every generated vhost's `access_by_lua_file` 500s the whole box. The
  // vhost builder independently gates its directives on luaSourceAvailable(), so
  // even this degrades (rules off, sites UP) rather than taking the edge down.
  if (!luaSourceAvailable()) {
    throw new Error(
      `OpenResty Lua is unavailable in this build — not on disk (LUA_SRC_DIR=${LUA_SRC_DIR}) ` +
        `and not in EMBEDDED_LUA. The edge scripts (rules_guard.lua/site_logger.lua) can't be ` +
        `installed. Run \`bun run embed:lua\` in packages/adapters to regenerate lua-embedded.ts.`,
    );
  }
  await executor.mkdir(OPENRESTY_LUA_DIR);

  for (const name of LUA_SCRIPTS) {
    await executor.writeFile(
      `${OPENRESTY_LUA_DIR}/${name}`,
      readLua(name),
    );
  }

  // ── Ensure nginx.conf + sites-enabled directory ───────────────────────
  // Must run BEFORE sed patches - bootstraps a minimal config if missing.
  await ensureOpenRestyConfig(executor, paths);

  // ── Patch nginx.conf ─────────────────────────────────────────────────

  // Shared dicts, sized from EDGE_SHARED_DICTS so a bare box and the baked
  // container image can't diverge. `grep || sed` per dict, not a rewrite: an
  // operator-extended nginx.conf must survive being patched.
  for (const dict of EDGE_SHARED_DICTS) {
    await executor.exec(
      `grep -q 'lua_shared_dict ${dict.name} ' ${paths.confPath} || ` +
        `sed -i '/http *{/a \\    lua_shared_dict ${dict.name} ${dict.size};' ${paths.confPath}`,
    );
  }

  // Lua module search path (OpenResty default + openship modules)
  await executor.exec(
    `grep -q 'lua_package_path' ${paths.confPath} || ` +
      `sed -i '/http *{/a \\    lua_package_path "${EDGE_LUA_PACKAGE_PATH}";' ${paths.confPath}`,
  );

  // Real client address behind Cloudflare / a front proxy.
  //
  // An INCLUDE file plus one include line, unlike the dicts above, because the
  // `grep || sed` idiom is append-only: it cannot update what it already wrote. The
  // trusted-proxy list changes (Cloudflare adds ranges; an operator sets
  // OPENSHIP_EDGE_TRUSTED_PROXIES), so its content has to be rewritable — the file is
  // overwritten wholesale every deploy and the include line is appended exactly once.
  //
  // Written BEFORE the include is added: nginx -t fails on a missing include, and a
  // failed test means the reload is refused and no routing change lands at all.
  const realIpPath = `${paths.confDir}/${EDGE_REAL_IP_CONF_NAME}`;
  await executor.writeFile(realIpPath, edgeRealIpConf());
  await executor.exec(
    `grep -q '${EDGE_REAL_IP_CONF_NAME}' '${paths.confPath}' || ` +
      `sed -i '/http *{/a \\    include ${realIpPath};' '${paths.confPath}'`,
  );

  // Base server blocks (_management.conf + _default.conf) are written by
  // ensureOpenRestyConfig above - single writer, so they self-heal every deploy.

  // ── Validate + reload ────────────────────────────────────────────────
  await executor.exec(buildReloadCommand(paths));
}
