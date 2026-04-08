-- geo_country.lua
-- MaxMind GeoLite2-Country lookup with per-worker LRU cache.
--
-- DB and cache are per-worker only: one load per worker, shared by all
-- requests. No reload per stream or per request.
--
-- Dependencies (installed by deployLuaScripts):
--   opm: anjia0532/lua-resty-maxminddb
--   apt: libmaxminddb0 libmaxminddb-dev  (C library for FFI)
--   Database: /usr/share/GeoIP/GeoLite2-Country.mmdb
--
-- Falls back gracefully — if the library or database is missing,
-- get_country_code() returns nil.  Both site_logger.lua and pipe_log.lua
-- wrap this module in pcall(require, ...) so a missing DB never crashes
-- the request pipeline.

local _M = {}

local DB_PATH = "/usr/share/GeoIP/GeoLite2-Country.mmdb"

local mmdb_ok, maxmind = pcall(require, "resty.maxminddb")
local lrucache_ok, lrucache = pcall(require, "resty.lrucache")

local cache            -- one LRU per worker
local geo_initted = false  -- DB opened once per worker on first lookup

-- Init MaxMind once per worker; subsequent lookups (any stream) reuse.
local function ensure_geo_init()
    if geo_initted then
        return true
    end
    if not mmdb_ok or not maxmind then
        return false
    end
    local ok, err = maxmind.init(DB_PATH)
    if not ok then
        ngx.log(ngx.WARN,
            "[geo_country] GeoLite2 database not found at " .. DB_PATH ..
            " — geo lookups disabled: " .. (err or "unknown"))
        return false
    end
    geo_initted = true
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
            -- false means "looked up, no result" — avoids repeated DB misses
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

return _M
