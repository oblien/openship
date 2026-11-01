-- rules_lib.lua
-- Per-worker helpers + parsed-rule cache for rules_guard.lua (access phase).
-- Loaded ONCE per worker via require("openship.rules_lib"). The access file is
-- re-executed on every request, so all parsing/compiling/matching lives here to
-- avoid re-creating closures and re-decoding JSON on the hot path.
--
-- Shared-dict value `rules[host]` = JSON array of { pathPrefix, spec } where
-- spec matches @repo/core RouteRuleSpec. parse() decodes + precompiles CIDRs to
-- integers, lowercases UA/referer needles, and builds O(1) sets for
-- countries/methods ONCE; the compiled result is LRU-cached per host and reused
-- until the raw string changes (rule edits are rare, requests are hot).
--
-- SECURITY: nothing here turns a rule value into Lua code or a Lua pattern.
-- Strings are compared with `==`/set-lookups; user-agent matching is
-- string.find(hay, needle, 1, true) — PLAIN, never a regex.

local cjson = require "cjson.safe"
local lrucache = require "resty.lrucache"

local M = {}

local cache = lrucache.new(1024) -- compiled rules, per worker, ~1024 hosts

-- ── IPv4 helpers ──
local function ipv4_to_int(s)
    local a, b, c, d = string.match(s, "^(%d+)%.(%d+)%.(%d+)%.(%d+)$")
    if not a then return nil end
    a, b, c, d = tonumber(a), tonumber(b), tonumber(c), tonumber(d)
    if a > 255 or b > 255 or c > 255 or d > 255 then return nil end
    return a * 16777216 + b * 65536 + c * 256 + d
end
M.ipv4_to_int = ipv4_to_int

-- Precompile a CIDR / bare-IP string into a cheap match descriptor.
local function compile_cidr(s)
    local base, bits = string.match(s, "^([^/]+)/(%d+)$")
    if base then
        bits = tonumber(bits)
        local basei = ipv4_to_int(base)
        if not basei or bits < 0 or bits > 32 then return { exact = s } end
        if bits == 0 then return { all = true } end
        local div = 2 ^ (32 - bits) -- compare the top `bits` bits
        return { net = math.floor(basei / div), div = div }
    end
    local i = ipv4_to_int(s)
    if i then return { ip = i } end
    return { exact = s } -- IPv6 / unparseable → literal string compare
end

local function compile_list(list)
    if type(list) ~= "table" then return nil end
    local out, n = {}, 0
    for _, s in ipairs(list) do
        if type(s) == "string" and s ~= "" then
            n = n + 1
            out[n] = compile_cidr(s)
        end
    end
    return n > 0 and out or nil
end

-- Match a client (int form `ipi`, may be nil for non-IPv4; raw `ips`) against a
-- compiled CIDR/IP list.
local function match_compiled(compiled, ipi, ips)
    if not compiled then return false end
    for i = 1, #compiled do
        local c = compiled[i]
        if c.all then
            return true
        elseif c.ip then
            if ipi and ipi == c.ip then return true end
        elseif c.net then
            if ipi and math.floor(ipi / c.div) == c.net then return true end
        elseif c.exact == ips then
            return true
        end
    end
    return false
end
M.match_compiled = match_compiled

local function lower_list(list)
    if type(list) ~= "table" then return nil end
    local out, n = {}, 0
    for _, s in ipairs(list) do
        if type(s) == "string" and s ~= "" then
            n = n + 1
            out[n] = string.lower(s)
        end
    end
    return n > 0 and out or nil
end

-- Build an O(1) lookup set from a string list (optionally lowercased).
local function to_set(list, lower)
    if type(list) ~= "table" then return nil end
    local set, any = {}, false
    for _, s in ipairs(list) do
        if type(s) == "string" and s ~= "" then
            set[lower and string.lower(s) or s] = true
            any = true
        end
    end
    return any and set or nil
end

-- Compile one RouteRuleSpec into a fast-match shape.
local function compile_spec(spec)
    if type(spec) ~= "table" then return { blockStatus = 403 } end
    local out = {}

    local rl = spec.rateLimit
    local rps = rl and tonumber(rl.rps)
    if rps and rps > 0 then
        out.rl = {
            limit = math.floor(rps) + math.floor(tonumber(rl.burst) or 0),
            status = tonumber(rl.status) or 429,
        }
    end

    local ban = spec.ban
    if type(ban) == "table" then
        out.ban = {
            ips = compile_list(ban.ips),
            cidrs = compile_list(ban.cidrs),
            countries = to_set(ban.countries),
            uas = lower_list(ban.userAgents),
            emptyUA = ban.emptyUserAgent == true,
        }
    end

    local acc = spec.access
    if type(acc) == "table" then
        out.access = {
            allow = compile_list(acc.allowCidrs),
            deny = compile_list(acc.denyCidrs),
            allowCountries = to_set(acc.allowCountries),
            methods = to_set(acc.methods),
        }
    end

    local hot = spec.hotlink
    if type(hot) == "table" then
        local refs = to_set(hot.allowReferers, true)
        if refs then
            out.hotlink = { referers = refs, allowEmpty = hot.allowEmpty ~= false }
        end
    end

    out.blockStatus = (type(spec.block) == "table" and tonumber(spec.block.status)) or 403
    return out
end

local function parse(raw)
    local entries = cjson.decode(raw)
    if type(entries) ~= "table" then return {} end
    local out, n = {}, 0
    for _, e in ipairs(entries) do
        if type(e) == "table" then
            -- cjson.null is truthy userdata. Normalize once so both prefix
            -- matching and rate-limit keys use nil for a whole-host rule.
            local prefix = e.pathPrefix
            if type(prefix) ~= "string" then prefix = nil end
            n = n + 1
            out[n] = { pathPrefix = prefix, spec = compile_spec(e.spec) }
        end
    end
    return out
end

-- LRU-cached parse: reuse the compiled form until the raw dict string changes.
function M.get(host, raw)
    local hit = cache:get(host)
    if hit and hit.raw == raw then return hit.parsed end
    local parsed = parse(raw)
    cache:set(host, { raw = raw, parsed = parsed })
    return parsed
end

return M
