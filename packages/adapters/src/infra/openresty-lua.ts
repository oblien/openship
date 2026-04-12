/**
 * OpenResty Lua deployment — reads dedicated .lua files and writes them
 * to the managed server via the CommandExecutor (SSH / local shell).
 *
 * Architecture:
 *   No external dependencies on the managed server — everything runs on
 *   ngx.shared.dict zones in OpenResty shared memory.  No Redis, no
 *   file I/O on the hot path.
 *
 * Lua scripts live in ./lua/ as proper .lua files (readable, lintable,
 * editable with Lua tooling).  At deploy time we read them with
 * fs.readFileSync and push them to the server.
 *
 * Scripts:
 *   site_logger.lua  — log_by_lua: atomic counters + ring buffer + pipe
 *   pipe_log.lua     — module: pushes to shared-dict list for SSE pipe
 *   pipe_stream.lua  — content_by_lua: SSE endpoint (long-lived)
 *   mgmt_api.lua     — content_by_lua: REST analytics query endpoints
 *   geo_country.lua  — module: MaxMind GeoLite2 IP → country code
 *
 * Shared memory zones (declared in nginx.conf):
 *   analytics      256m — minute-bucket counters, daily geo, totals
 *   request_data   128m — raw-log ring buffers + live-log pipe queue
 *
 * Management port: 127.0.0.1:9145 (loopback only)
 *   GET /analytics?domain=&from=&to=   — minute-bucket time series
 *   GET /analytics/totals?domain=      — lifetime counters (or all domains)
 *   GET /analytics/geo?domain=&day=    — country breakdown
 *   GET /logs/recent?domain=&limit=    — recent raw requests
 *   GET /logs/stream?domain=           — SSE live stream
 *   GET /health                        — 200 ok
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CommandExecutor } from "../types";

// ── Paths & constants ────────────────────────────────────────────────────────

/** Directory on the managed server where Lua scripts are deployed. */
export const OPENRESTY_LUA_DIR = "/usr/local/openresty/site/lualib/openship";

/** Absolute path to the site_logger script (referenced by nginx server blocks). */
export const LUA_LOGGER_PATH = `${OPENRESTY_LUA_DIR}/site_logger.lua`;

/** Management API port — loopback only, queried via SSH tunnel. */
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
      // Config doesn't exist yet — use the detected/default path.
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
 * Idempotent — safe to call on every platform init. Creates the
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
  // Ensure the logs/PID directory exists — OpenResty refuses to start without it.
  const pidDir = paths.pidPath.replace(/\/[^/]+$/, "");
  await executor.mkdir(pidDir);

  // Bootstrap: if nginx.conf doesn't exist (e.g. after a reinstall that
  // removed the old config), write a minimal working config.
  if (!(await executor.exists(paths.confPath))) {
    await executor.mkdir(paths.confDir);
    await executor.writeFile(
      paths.confPath,
      MINIMAL_NGINX_CONF(paths.confDir, paths.sitesDir),
    );
    return; // Fresh config already has the include — no sed needed.
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
      // No include at all — add one inside http {}
      await executor.exec(
        `sed -i '/http *{/a \\    include ${paths.sitesDir}/*.conf;' ${paths.confPath}`,
      );
    }
  }
}

/** Minimal nginx.conf that OpenResty can boot with. */
function MINIMAL_NGINX_CONF(confDir: string, sitesDir: string): string {
  return `# Auto-generated by Openship — safe to extend
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

const LUA_SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "lua");

/** Read a .lua file from the local lua/ directory. */
function readLua(filename: string): string {
  return readFileSync(join(LUA_SRC_DIR, filename), "utf-8");
}

// ── Management server block ──────────────────────────────────────────────────

const MANAGEMENT_BLOCK = `\
# Openship internal management — analytics & live-log streaming
# Auto-generated — do not edit manually
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

const DEFAULT_BLOCK = `\
# Openship default catch-all — prevents the stock OpenResty welcome page
# Auto-generated — do not edit manually
server {
    listen 80 default_server;
    server_name _;

    location /.well-known/acme-challenge/ {
        root /var/www/acme;
    }

    location / {
        return 404;
    }
}
`;

// ── Deployment ───────────────────────────────────────────────────────────────

const LUA_SCRIPTS = [
  "site_logger.lua",
  "pipe_log.lua",
  "pipe_stream.lua",
  "mgmt_api.lua",
  "geo_country.lua",
] as const;

/**
 * Install libmaxminddb (C library needed by lua-resty-maxminddb's FFI),
 * the OpenResty Lua binding via opm, and download the GeoLite2 database.
 *
 * Non-fatal — if any step fails the analytics pipeline still works,
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
    // Non-fatal — geo just won't work
  }

  // ── 2. lua-resty-maxminddb (Lua binding via opm) ──────────────────────
  try {
    await executor.exec(
      "opm get anjia0532/lua-resty-maxminddb",
    );
  } catch {
    // opm might not be in PATH — try the full path
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
  await executor.mkdir(OPENRESTY_LUA_DIR);

  for (const name of LUA_SCRIPTS) {
    await executor.writeFile(
      `${OPENRESTY_LUA_DIR}/${name}`,
      readLua(name),
    );
  }

  // ── Ensure nginx.conf + sites-enabled directory ───────────────────────
  // Must run BEFORE sed patches — bootstraps a minimal config if missing.
  await ensureOpenRestyConfig(executor, paths);

  // ── Patch nginx.conf ─────────────────────────────────────────────────

  // Shared dict: analytics counters (256 MB)
  await executor.exec(
    `grep -q 'lua_shared_dict analytics ' ${paths.confPath} || ` +
      `sed -i '/http *{/a \\    lua_shared_dict analytics 256m;' ${paths.confPath}`,
  );

  // Shared dict: request data — ring buffers + live-log pipe (128 MB)
  await executor.exec(
    `grep -q 'lua_shared_dict request_data ' ${paths.confPath} || ` +
      `sed -i '/http *{/a \\    lua_shared_dict request_data 128m;' ${paths.confPath}`,
  );

  // Lua module search path (OpenResty default + openship modules)
  await executor.exec(
    `grep -q 'lua_package_path' ${paths.confPath} || ` +
      `sed -i '/http *{/a \\    lua_package_path "/usr/local/openresty/site/lualib/?.lua;;";' ${paths.confPath}`,
  );

  // ── Management server block ──────────────────────────────────────────
  await executor.writeFile(`${paths.sitesDir}/_management.conf`, MANAGEMENT_BLOCK);
  await executor.writeFile(`${paths.sitesDir}/_default.conf`, DEFAULT_BLOCK);

  // ── Validate + reload ────────────────────────────────────────────────
  await executor.exec(buildReloadCommand(paths));
}
