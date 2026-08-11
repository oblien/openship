-- geo_country.lua
-- MaxMind GeoLite2-Country lookup with per-worker LRU cache.
--
-- DB and cache are per-worker only: one load per worker, shared by all
-- requests. No reload per stream or per request.
--
-- Dependencies:
--   Lua binding — `openship.maxminddb`, vendored beside this file. Falls back to
--                 `resty.maxminddb` for a bare box that has the opm package
--                 installed from before we vendored it.
--   C library   — libmaxminddb.so (`apk add libmaxminddb` in apps/edge/Dockerfile;
--                 installGeoDeps() for bare boxes)
--   Database    — /usr/share/GeoIP/GeoLite2-Country.mmdb (baked into the edge
--                 image from apps/api/assets/geoip, so no runtime download)
--
-- Falls back gracefully - if the library or database is missing,
-- get_country_code() returns nil.  site_logger.lua wraps this module in
-- pcall(require, ...) so a missing DB never crashes the request pipeline
-- (the country it resolves flows into the ring buffer, and from there to
-- both /logs/recent and the live SSE stream). mgmt_api `GET /status` reports whether geo actually
-- resolved, so a silently-dark edge is visible instead of just yielding an
-- empty country map.

local _M = {}

local DB_PATH = "/usr/share/GeoIP/GeoLite2-Country.mmdb"

-- Vendored copy first, opm-installed copy second. `ffi.load('libmaxminddb')`
-- runs at require time in both, so a missing .so surfaces here as mmdb_ok=false.
local mmdb_ok, maxmind = pcall(require, "openship.maxminddb")
if not mmdb_ok then
    mmdb_ok, maxmind = pcall(require, "resty.maxminddb")
end
local lrucache_ok, lrucache = pcall(require, "resty.lrucache")

local cache            -- one LRU per worker
local geo_initted = false  -- DB opened once per worker on first lookup
-- Why geo is off, for `GET /status`. Distinguishing "no FFI binding / no .so"
-- from "no database" matters: they need different fixes, and both used to
-- present identically as an empty country map.
local geo_reason = "not initialised"

-- Init MaxMind once per worker; subsequent lookups (any stream) reuse.
local function ensure_geo_init()
    if geo_initted then
        return true
    end
    if not mmdb_ok or not maxmind then
        geo_reason = "maxminddb FFI binding unavailable (libmaxminddb.so missing?)"
        return false
    end
    local ok, err = maxmind.init(DB_PATH)
    if not ok then
        geo_reason = "database unreadable at " .. DB_PATH .. ": " .. (err or "unknown")
        ngx.log(ngx.WARN,
            "[geo_country] GeoLite2 database not found at " .. DB_PATH ..
            " - geo lookups disabled: " .. (err or "unknown"))
        return false
    end
    geo_initted = true
    geo_reason = "ok"
    ngx.log(ngx.INFO, "[geo_country] GeoLite2-Country loaded from " .. DB_PATH)
    return true
end

-- Create LRU cache once per worker (max 50000 IPs).
local function get_cache()
    if cache then
        return cache
    end
    if not lrucache_ok or not lrucache then
        return nil
    end
    local c, err = lrucache.new(50000)
    if not c then
        return nil
    end
    cache = c
    return cache
end

--- Get country ISO code for IP. Uses in-memory LRU cache then MaxMind DB.
-- @param ip string (e.g. "8.8.8.8")
-- @return string|nil country code (e.g. "US") or nil
function _M.get_country_code(ip)
    if not ip or ip == "" then
        return nil
    end

    local c = get_cache()
    if c then
        local cached = c:get(ip)
        if cached ~= nil then
            -- false means "looked up, no result" - avoids repeated DB misses
            return (cached == false) and nil or cached
        end
    end

    if not ensure_geo_init() then
        if c then c:set(ip, false) end
        return nil
    end

    local ok, res, err = pcall(maxmind.lookup, ip)
    local code = nil
    if ok and res and res.country and res.country.iso_code then
        code = res.country.iso_code
    end

    if c then
        c:set(ip, code or false)
    end
    return code
end

function _M.ensure_geo_init()
    return ensure_geo_init()
end

--- Health for `GET /status`: does geo actually resolve, and if not, why.
-- @return boolean available, string reason, string db_path
function _M.status()
    local ok = ensure_geo_init()
    return ok, geo_reason, DB_PATH
end

return _M
