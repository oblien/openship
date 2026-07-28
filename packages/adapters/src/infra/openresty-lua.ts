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
 *   site_logger.lua      - log_by_lua: atomic counters + ring buffer + pipe
 *   pipe_log.lua         - module: pushes to shared-dict list for SSE pipe
 *   pipe_stream.lua      - content_by_lua: SSE endpoint (long-lived)
 *   mgmt_api.lua         - content_by_lua: REST analytics query endpoints
 *   geo_country.lua      - module: MaxMind GeoLite2 IP → country code
 *
 * Shared memory zones (declared in nginx.conf):
 *   analytics        256m - minute-bucket counters, daily geo, totals
 *   request_data     128m - raw-log ring buffers + live-log pipe queue
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
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EMBEDDED_LUA } from "./lua-embedded";
import type { CommandExecutor } from "../types";

// ── Paths & constants ────────────────────────────────────────────────────────

/** Directory on the managed server where Lua scripts are deployed. */
export const OPENRESTY_LUA_DIR = "/usr/local/openresty/site/lualib/openship";

/** Absolute path to the site_logger script (referenced by nginx server blocks). */
export const LUA_LOGGER_PATH = `${OPENRESTY_LUA_DIR}/site_logger.lua`;

/** Absolute path to the access-phase rules guard (referenced by server blocks). */
export const RULES_GUARD_PATH = `${OPENRESTY_LUA_DIR}/rules_guard.lua`;

/** Management API port - loopback only, queried via SSH tunnel. */
export const OPENRESTY_MGMT_PORT = 9145;

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
}

/** Fallback paths when `openresty -V` is unavailable (e.g. not yet installed). */
export const OPENRESTY_DEFAULT_PATHS: OpenRestyPaths = {
  bin: "/usr/local/openresty/bin/openresty",
  confPath: "/usr/local/openresty/nginx/conf/nginx.conf",
  confDir: "/usr/local/openresty/nginx/conf",
  sitesDir: "/usr/local/openresty/nginx/conf/sites-enabled",
  pidPath: "/usr/local/openresty/nginx/logs/nginx.pid",
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

  return {
    bin,
    confPath,
    confDir,
    sitesDir: `${confDir}/sites-enabled`,
    pidPath,
  };
}

// ── Reload command builder ───────────────────────────────────────────────────

/**
 * Build the OpenResty reload command from detected paths.
 *
 * Primary: `openresty -t` then `openresty -s reload` (graceful, zero-downtime).
 * Fallback: if reload fails (e.g. not running), kill everything and start fresh.
 */
export function buildReloadCommand(paths: OpenRestyPaths): string {
  return `${paths.bin} -t 2>&1 || exit 1

if ${paths.bin} -s reload 2>/dev/null; then
  exit 0
fi

pkill -f '[o]penresty' >/dev/null 2>&1 || true
pkill -f '[n]ginx' >/dev/null 2>&1 || true
sleep 1
rm -f ${paths.pidPath}
${paths.bin}`;
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
  // (incl. the 443 unknown-SNI reject). Written here - not just at install - so
  // an already-deployed box self-heals the catch-all on its next deploy and no
  // longer cross-serves an unrouted HTTPS host. Idempotent overwrite of static
  // content; a stale copy is replaced. The deploy's route reload applies it.
  await executor.writeFile(`${paths.sitesDir}/_management.conf`, MANAGEMENT_BLOCK);
  await executor.writeFile(`${paths.sitesDir}/_default.conf`, DEFAULT_BLOCK);

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
    include ${sitesDir}/*.conf;
}
`;
}
const GEOIP_DIR = "/usr/share/GeoIP";
const GEOIP_DB_PATH = `${GEOIP_DIR}/GeoLite2-Country.mmdb`;
const GEOIP_DB_URL =
  "https://github.com/P3TERX/GeoLite.mmdb/releases/download/2026.04.07/GeoLite2-Country.mmdb";

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

const MANAGEMENT_BLOCK = `\
# Openship internal management - analytics & live-log streaming
# Auto-generated - do not edit manually
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
}
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

const DEFAULT_BLOCK = `\
# Openship default catch-all - prevents the stock OpenResty welcome page AND
# stops an unmatched Host/SNI from being served the first real vhost by default.
# Auto-generated - do not edit manually
server {
    listen 80 default_server;
    server_name _;

${ACME_CHALLENGE_LOCATION}

    location / {
        return 404;
    }
}

# HTTPS catch-all. WITHOUT a 443 default_server, nginx serves the first-loaded
# 443 vhost to any request whose SNI matches no server_name - so a domain we do
# NOT route (removed / never-added / just pointed at this IP) silently gets some
# other app's cert + backend. That is cross-serving, a security hole. Owning the
# 443 default and rejecting unknown SNI closes it: an unrouted host gets a TLS
# handshake failure, never a fallthrough. ssl_reject_handshake (OpenResty/nginx
# >= 1.19.4; our installer pulls the newest LTS) needs no certificate.
server {
    listen 443 ssl default_server;
    ssl_reject_handshake on;
}
`;

// ── Deployment ───────────────────────────────────────────────────────────────

const LUA_SCRIPTS = [
  "site_logger.lua",
  "pipe_log.lua",
  "pipe_stream.lua",
  "mgmt_api.lua",
  "geo_country.lua",
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
 * Install libmaxminddb (C library needed by lua-resty-maxminddb's FFI),
 * the OpenResty Lua binding via opm, and download the GeoLite2 database.
 *
 * Non-fatal - if any step fails the analytics pipeline still works,
 * geo_country.lua just returns nil for every lookup.
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
    }
  } catch {
    // Non-fatal - geo just won't work
  }

  // ── 2. lua-resty-maxminddb (Lua binding via opm) ──────────────────────
  try {
    await executor.exec(
      "opm get anjia0532/lua-resty-maxminddb",
    );
  } catch {
    // opm might not be in PATH - try the full path
    try {
      await executor.exec(
        "/usr/local/openresty/bin/opm get anjia0532/lua-resty-maxminddb",
      );
    } catch {
      // Non-fatal
    }
  }

  // ── 3. GeoLite2-Country database ──────────────────────────────────────
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

  // Shared dict: analytics counters (256 MB)
  await executor.exec(
    `grep -q 'lua_shared_dict analytics ' ${paths.confPath} || ` +
      `sed -i '/http *{/a \\    lua_shared_dict analytics 256m;' ${paths.confPath}`,
  );

  // Shared dict: request data - ring buffers + live-log pipe (128 MB)
  await executor.exec(
    `grep -q 'lua_shared_dict request_data ' ${paths.confPath} || ` +
      `sed -i '/http *{/a \\    lua_shared_dict request_data 128m;' ${paths.confPath}`,
  );

  // Shared dict: per-route rules cache (32 MB). Written reload-free by mgmt_api
  // `POST /rules`, read by rules_guard.lua in the access phase. The DB
  // (route_rule table) is the source of truth.
  await executor.exec(
    `grep -q 'lua_shared_dict rules ' ${paths.confPath} || ` +
      `sed -i '/http *{/a \\    lua_shared_dict rules 32m;' ${paths.confPath}`,
  );

  // Separate dict for rate-limit COUNTERS (16 MB). Kept apart from `rules` so a
  // high-cardinality flood (a fresh key per source IP per second) can't LRU-evict
  // the rulesets and silently disable enforcement mid-attack.
  await executor.exec(
    `grep -q 'lua_shared_dict rl_counters ' ${paths.confPath} || ` +
      `sed -i '/http *{/a \\    lua_shared_dict rl_counters 16m;' ${paths.confPath}`,
  );

  // Lua module search path (OpenResty default + openship modules)
  await executor.exec(
    `grep -q 'lua_package_path' ${paths.confPath} || ` +
      `sed -i '/http *{/a \\    lua_package_path "/usr/local/openresty/site/lualib/?.lua;;";' ${paths.confPath}`,
  );

  // Base server blocks (_management.conf + _default.conf) are written by
  // ensureOpenRestyConfig above - single writer, so they self-heal every deploy.

  // ── Validate + reload ────────────────────────────────────────────────
  await executor.exec(buildReloadCommand(paths));
}
