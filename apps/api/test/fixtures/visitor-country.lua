-- Run by the existing source/embedded OpenResty fixture. The real GeoIP module
-- and resty LRU run against a counted database binding; no external GeoIP service.
local scripts = (arg and arg[1]) or "/usr/local/openresty/site/lualib/openship"
local lru = require "resty.lrucache"
local init_calls, db_calls, resolver_calls = 0, 0, 0
local record, headers
local zone = {
    get = function() return nil end,
    set = function() return true end,
    incr = function() return 1 end,
    safe_add = function() return false end,
}
local request = {
    var = { host = "country.test", remote_addr = "8.8.8.8", status = "200" },
    shared = { analytics = zone, request_data = zone },
    now = function() return 1700000000 end,
    log = function() end,
    req = { set_header = function(name, value) headers[name] = value end },
}
local binding = {
    init = function() init_calls = init_calls + 1; return true end,
    lookup = function(ip)
        db_calls = db_calls + 1
        if ip == "8.8.8.8" then return { country = { iso_code = "US" } } end
        if ip == "198.51.100.2" then error("corrupt lookup") end
        return nil
    end,
}
local modules = {
    ["openship.maxminddb"] = binding,
    ["resty.lrucache"] = { new = function(capacity)
        assert(capacity == 50000, "the existing bounded IP cache must be retained")
        return lru.new(capacity)
    end },
    ["cjson.safe"] = { encode = function(value) record = value; return "record" end },
}
local function script(name)
    local env = setmetatable({ ngx = request, require = function(module)
        assert(modules[module], "unexpected dependency: " .. module)
        return modules[module]
    end }, { __index = _G })
    -- LuaJIT in OpenResty; Lua 5.2+ also permits a local daemon-free smoke run.
    if setfenv then return setfenv(assert(loadfile(scripts .. "/" .. name)), env) end
    return assert(loadfile(scripts .. "/" .. name, "t", env))
end
local geo = script("geo_country.lua")()
modules["openship.geo_country"] = { get_country_code = function(ip)
    resolver_calls = resolver_calls + 1
    return geo.get_country_code(ip)
end }
local guard, logger = script("rules_guard.lua"), script("site_logger.lua")
local function visit(ip, expected)
    request.ctx = {}
    request.var.remote_addr = ip
    headers = { ["x-visitor-country"] = { "RU", "CA" } }
    record = nil
    local before = resolver_calls
    guard()
    assert(headers["x-visitor-country"] == expected, "supplied country was not replaced/removed")
    logger()
    assert(resolver_calls == before + 1, "access/log phases repeated the country lookup")
    assert(record and record.country == expected, "analytics lost the request country")
end

visit("8.8.8.8", "US")
visit("8.8.8.8", "US")
assert(init_calls == 1 and db_calls == 1, "a repeated IP reopened or queried the database")
visit("203.0.113.1", nil)
visit("203.0.113.1", nil)
assert(db_calls == 2, "unknown countries must also hit the worker LRU")
for _ = 1, 10000 do visit("8.8.8.8", "US") end
assert(init_calls == 1 and db_calls == 2, "warm requests escaped the existing IP cache")
visit("198.51.100.2", nil)

modules["openship.geo_country"].get_country_code = function()
    resolver_calls = resolver_calls + 1
    error("broken GeoIP provider")
end
visit("8.8.8.8", nil) -- A provider exception must not interrupt a normal request or analytics.
modules["openship.geo_country"] = nil
request.ctx = {}
headers = { ["x-visitor-country"] = "RU" }
guard()
assert(headers["x-visitor-country"] == nil and request.ctx.openship_country == false,
    "an unavailable GeoIP module must clear the supplied header")

return "country cache and failure checks passed"
