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

const OPENRESTY_CONF_PATH = "/usr/local/openresty/nginx/conf/nginx.conf";
const SITES_DIR = "/usr/local/openresty/nginx/conf/sites-enabled";
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

  // ── Patch nginx.conf ─────────────────────────────────────────────────

  // Shared dict: analytics counters (256 MB)
  await executor.exec(
    `grep -q 'lua_shared_dict analytics ' ${OPENRESTY_CONF_PATH} || ` +
      `sed -i '/http *{/a \\    lua_shared_dict analytics 256m;' ${OPENRESTY_CONF_PATH}`,
  );

  // Shared dict: request data — ring buffers + live-log pipe (128 MB)
  await executor.exec(
    `grep -q 'lua_shared_dict request_data ' ${OPENRESTY_CONF_PATH} || ` +
      `sed -i '/http *{/a \\    lua_shared_dict request_data 128m;' ${OPENRESTY_CONF_PATH}`,
  );

  // Lua module search path (OpenResty default + openship modules)
  await executor.exec(
    `grep -q 'lua_package_path' ${OPENRESTY_CONF_PATH} || ` +
      `sed -i '/http *{/a \\    lua_package_path "/usr/local/openresty/site/lualib/?.lua;;";' ${OPENRESTY_CONF_PATH}`,
  );

  // ── Management server block ──────────────────────────────────────────
  await executor.mkdir(SITES_DIR);
  await executor.writeFile(`${SITES_DIR}/_management.conf`, MANAGEMENT_BLOCK);

  // ── Validate + reload ────────────────────────────────────────────────
  await executor.exec("openresty -t");
  await executor.exec("openresty -s reload");
}
