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
M.static_responses = true
M.response_methods = { GET=true, HEAD=true, POST=true, PUT=true, PATCH=true, DELETE=true, OPTIONS=true }

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

-- Response validation runs at management writes and on a worker cache miss,
-- never for each request. Keep these bounds aligned with core/edge-response.ts.
local managed_headers = { ["content-type"]=true, ["content-length"]=true, ["content-encoding"]=true,
    ["transfer-encoding"]=true, connection=true, ["keep-alive"]=true,
    ["proxy-authenticate"]=true, ["proxy-authorization"]=true, te=true, trailer=true,
    upgrade=true, ["x-accel-redirect"]=true }
local token = "[!#$%%&'*+%.%^_`|~0-9A-Za-z%-]+"
M.max_responses = 64

local function reserved_path(path)
    return path == "/_openship" or string.sub(path, 1, 11) == "/_openship/"
        or path == "/.openship" or string.sub(path, 1, 11) == "/.openship/"
        or path == "/.well-known/acme-challenge" or string.sub(path, 1, 28) == "/.well-known/acme-challenge/"
end
M.reserved_path = reserved_path

local function compile_response(e)
    if type(e) ~= "table" or type(e.spec) ~= "table" then return nil end
    local spec, path = e.spec, e.pathPrefix
    if path == nil or path == cjson.null then path = "/" end
    if type(path) ~= "string" or #path > 512 or string.sub(path, 1, 1) ~= "/"
        or string.find(path, "[%z\1-\32\127?#%%\\]") or string.find(path, "//", 1, true)
        or string.find(path .. "/", "/./", 1, true) or string.find(path .. "/", "/../", 1, true)
        or reserved_path(path) then return nil end
    -- Policies are separate entries, selected independently of response matches.
    if spec.access or spec.ban or spec.hotlink or spec.rateLimit or spec.block then return nil end
    local response = spec.response
    if type(response) ~= "table" or type(response.status) ~= "number"
        or response.status < 200 or response.status > 599 or response.status % 1 ~= 0
        or type(response.body) ~= "string" or #response.body > 65536
        or type(response.contentType) ~= "string" or #response.contentType > 256
        or string.find(response.contentType, "[%z\1-\31\127]")
        or (response.match ~= "exact" and response.match ~= "prefix") then return nil end
    local suffix = string.match(response.contentType, "^" .. token .. "/" .. token .. "(.*)$")
    if not suffix or (suffix ~= "" and not string.match(suffix, "^ *;")) then return nil end
    if (response.status == 204 or response.status == 205 or response.status == 304)
        and response.body ~= "" then return nil end
    if type(response.headers) ~= "table" or type(response.methods) ~= "table"
        or #response.methods > 7 then return nil end
    local headers, seen, count, size = {}, {}, 0, 0
    for name, value in pairs(response.headers) do
        if type(name) ~= "string" or #name == 0 or #name > 128
            or not string.match(name, "^" .. token .. "$")
            or managed_headers[string.lower(name)] or seen[string.lower(name)]
            or type(value) ~= "string" or #value > 2048
            or string.find(value, "[%z\1-\31\127]") then return nil end
        count, size = count + 1, size + #name + #value
        if count > 32 or size > 8192 then return nil end
        seen[string.lower(name)], headers[name] = true, value
    end
    local methods = {}
    for i, method in pairs(response.methods) do
        if type(i) ~= "number" or i < 1 or i > #response.methods or i % 1 ~= 0
            or type(method) ~= "string" or not M.response_methods[method] then return nil end
        methods[method] = true
    end
    return { path=path, boundary=string.sub(path, -1) == "/" and path or path .. "/",
        match=response.match, status=response.status, body=response.body,
        contentType=response.contentType, headers=headers,
        methods=#response.methods > 0 and methods or nil }
end

function M.valid_responses(entries)
    if #entries > M.max_responses then return false end
    local seen = {}
    for _, e in ipairs(entries) do
        local r = compile_response(e)
        if not r then return false end
        local key = r.match .. ":" .. r.path
        if seen[key] then return false end
        seen[key] = true
    end
    return true
end

function M.response_revision(raw)
    local hash = require("resty.sha256"):new()
    if not hash or not hash:update(raw) then return nil end
    return hash:final()
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
    -- Response entries can never become empty policies, including malformed
    -- entries left by an interrupted upgrade or an invalid management payload.
    out.isResponse = spec.response ~= nil
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

-- Only the 32-byte revision is read from shared memory on a warm request.
-- Bodies are fetched/decoded once per configuration change per worker. Keep a
-- separate cache so response bodies cannot displace compiled access policies.
local responses_cache = lrucache.new(128)
local response_cache_bytes = 0
local response_cache_budget = 8 * 1024 * 1024
local function response_index(host, revision, dict)
    local hit = responses_cache:get(host)
    if hit and hit.revision == revision then return hit end
    local raw = dict:get("responses:" .. host)
    -- A concurrent management write may have changed the body after we read
    -- its revision. Never cache that body under a different revision.
    if not raw or M.response_revision(raw) ~= revision then return nil end
    local entries = cjson.decode(raw)
    local index = { revision=revision, exact={}, prefixes={}, bytes=#raw }
    if type(entries) == "table" and #entries <= M.max_responses then
        for _, e in ipairs(entries) do
            local r = compile_response(e)
            if r then
                if r.match == "exact" then index.exact[r.path] = r
                else index.prefixes[#index.prefixes + 1] = r end
            end
        end
        table.sort(index.prefixes, function(a, b) return #a.path > #b.path end)
    end
    -- Conservatively count even evicted entries until the next flush. This
    -- bounds retained response payloads without running an eviction scan.
    response_cache_bytes = response_cache_bytes - (hit and hit.bytes or 0) + #raw
    if response_cache_bytes > response_cache_budget then
        responses_cache:flush_all()
        response_cache_bytes = #raw
    end
    responses_cache:set(host, index)
    return index
end

local function accepts_method(r, method)
    return not r.methods or r.methods[method] or method == "HEAD" and r.methods.GET
end

function M.response_for(host, revision, dict, uri, method)
    if not M.response_methods[method] or reserved_path(uri) then return nil end
    local index = response_index(host, revision, dict)
    if not index then return nil end
    local exact = index.exact[uri]
    if exact and accepts_method(exact, method) then return exact end
    for _, r in ipairs(index.prefixes) do
        local path = r.path
        local boundary = r.boundary
        if (path == "/" or uri == path or string.sub(uri, 1, #boundary) == boundary)
            and accepts_method(r, method) then return r end
    end
end

return M
