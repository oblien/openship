-- rules_guard.lua
-- access_by_lua driver: enforce per-route rules (method · IP/CIDR allow-deny ·
-- country allow/ban · bad user-agent · hotlink · rate-limit) for the request's
-- host. Rules are pushed reload-free by mgmt_api `POST /rules`; the DB
-- `route_rule` table is the source of truth. All parsing/compiling/matching
-- lives in openship.rules_lib (loaded ONCE per worker) — this file is re-run
-- every request so it stays minimal. See rules_lib.lua for the compiled shape.
--
-- Enforcement uses the connecting peer (ngx.var.remote_addr); front a real_ip
-- config if behind a trusted proxy. No user-supplied value is ever used as a
-- Lua pattern. Static response headers are validated at the API and compile boundary.

-- GeoIP owns the worker's IP cache; share its result with rules and analytics.
-- A lookup failure must not turn ordinary app traffic into a 500.
local geo_ok, geo = pcall(require, "openship.geo_country")
local country
if geo_ok then
    local ok_cc, cc = pcall(geo.get_country_code, ngx.var.remote_addr)
    if ok_cc then country = cc or nil end
end
ngx.ctx.openship_country = country or false
ngx.req.set_header("x-visitor-country", country)

local rules = ngx.shared.rules
if not rules then return end

-- Rate-limit counters live in their OWN dict so a high-cardinality flood (a new
-- rl: key per source IP per second) can't LRU-evict the rulesets and silently
-- disable enforcement. Fall back to `rules` on a box whose config predates the
-- separate dict (still works, just shares the zone until the next reload).
local counters = ngx.shared.rl_counters or rules

local host = ngx.var.host
if not host then return end

local raw = rules:get(host)
local response_revision = rules:get("responses-version:" .. host)
if not raw and not response_revision then
    -- A wildcard vhost's rules are stored under its server_name ("*.example.com"),
    -- while $host is the concrete name the visitor asked for. Each vhost declares
    -- exactly one server_name, so it is the rule key for any subdomain depth.
    local name = ngx.var.server_name
    if name and name ~= host and string.sub(name, 1, 2) == "*." then
        host = name
        raw = rules:get(host)
        response_revision = rules:get("responses-version:" .. host)
    end
end
if not raw and not response_revision then return end -- nothing configured for this host

local lib = require "openship.rules_lib"
local entries = raw and lib.get(host, raw) or {}
-- Longest policy prefix wins independently of the virtual response.
local uri = ngx.var.uri or "/"
local chosen, chosen_len = nil, -1
for i = 1, #entries do
    local e = entries[i]
    local p = e.pathPrefix
    if not e.spec.isResponse then
        if p == nil or p == "" or p == "/" then
            if chosen_len < 0 then chosen, chosen_len = e, 0 end
        elseif uri == p or string.sub(uri, 1, #p) == p then
            if #p > chosen_len then chosen, chosen_len = e, #p end
        end
    end
end
if not chosen and not response_revision then return end

-- Select policy independently: a static response can never replace a more
-- general ban, method allow-list, or rate limit simply by matching its path.
local spec = chosen and chosen.spec or {}
local deny_status = spec.blockStatus or 403

local ips = ngx.var.remote_addr or "0.0.0.0"
local ipi = lib.ipv4_to_int(ips)

-- ── 1. Access: method allow-list, IP allow/deny, country allow-list ──
local access = spec.access
if access then
    if access.methods and not access.methods[ngx.req.get_method()] then
        return ngx.exit(deny_status)
    end
    if lib.match_compiled(access.deny, ipi, ips) then return ngx.exit(deny_status) end
    if access.allow and not lib.match_compiled(access.allow, ipi, ips) then
        return ngx.exit(deny_status)
    end
    -- Allow-list: an unresolved country is not on the list → blocked (default-deny).
    if access.allowCountries and not access.allowCountries[country or ""] then
        return ngx.exit(deny_status)
    end
end

-- ── 2. Ban: IP/CIDR, country, user-agent ──
local ban = spec.ban
if ban then
    if lib.match_compiled(ban.ips, ipi, ips) or lib.match_compiled(ban.cidrs, ipi, ips) then
        return ngx.exit(deny_status)
    end
    if ban.countries then
        local cc = country
        -- Fail CLOSED (matches the allow-list above): if geo is unavailable we
        -- cannot prove the client is NOT from a banned country, so block rather
        -- than silently letting banned traffic through. A blocked host is a loud
        -- signal to fix geo; fail-open would be a silent security hole.
        if not cc then
            ngx.log(ngx.WARN, "rules_guard: country ban active but geo unavailable — blocking (fail-closed)")
            return ngx.exit(deny_status)
        end
        if ban.countries[cc] then return ngx.exit(deny_status) end
    end
    if ban.emptyUA or ban.uas then
        local ua = ngx.var.http_user_agent
        if ban.emptyUA and (ua == nil or ua == "") then return ngx.exit(deny_status) end
        if ban.uas and ua and ua ~= "" then
            local ual = string.lower(ua)
            for i = 1, #ban.uas do
                if string.find(ual, ban.uas[i], 1, true) then return ngx.exit(deny_status) end
            end
        end
    end
end

-- ── 3. Hotlink: only listed referer hosts (empty referer per allowEmpty) ──
local hot = spec.hotlink
if hot then
    local ref = ngx.var.http_referer
    if ref == nil or ref == "" then
        if not hot.allowEmpty then return ngx.exit(deny_status) end
    else
        local rhost = string.match(ref, "^%w+://([^/]+)")          -- authority
        if rhost then rhost = string.lower(string.match(rhost, "^([^:]+)") or rhost) end -- strip :port
        if not (rhost and hot.referers[rhost]) then return ngx.exit(deny_status) end
    end
end

-- ── 4. Rate limit — fixed 1s window per (host, path, ip) ──
local rl = spec.rl
if rl then
    local key = "rl:" .. host .. ":" .. (chosen.pathPrefix or "/") .. ":" .. ips
        .. ":" .. math.floor(ngx.now())
    local c = counters:incr(key, 1, 0, 2)  -- init 0, 2s TTL → self-expiring buckets
    if c and c > rl.limit then
        ngx.header["Retry-After"] = "1"
        return ngx.exit(rl.status)
    end
end

local response, method
-- During a rolling script update this file can be new while require() still
-- holds the previous worker library. Keep ordinary policy enforcement working.
if response_revision and lib.static_responses == true and type(lib.response_for) == "function"
    and not lib.reserved_path(uri) then
    -- Internal SPA/index rewrites must not turn an unrelated request into a
    -- virtual route. Decode the original path only on configured domains.
    local response_uri = ngx.unescape_uri(string.match(ngx.var.request_uri or uri, "^[^?]*"))
    method = ngx.req.get_method()
    response = lib.response_for(host, response_revision, rules, response_uri, method)
end

-- Literal content only, after ALL access policies. Never generated nginx/Lua
-- source. ngx.print preserves the exact body (including an empty response).
if response then
    ngx.status = response.status
    ngx.header["Content-Type"] = response.contentType
    for name, value in pairs(response.headers) do ngx.header[name] = value end
    if response.status ~= 204 and response.status ~= 304 then
        ngx.header["Content-Length"] = #response.body
    end
    ngx.send_headers()
    if method ~= "HEAD" and response.body ~= "" then ngx.print(response.body) end
    return ngx.exit(ngx.HTTP_OK)
end
