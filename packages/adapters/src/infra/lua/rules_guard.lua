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
-- Lua pattern or written into a response header.

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
if not raw then return end          -- fast path: nothing configured for this host

local lib = require "openship.rules_lib"
local entries = lib.get(host, raw)
local n = #entries
if n == 0 then return end

-- ── Longest matching pathPrefix wins ──
local uri = ngx.var.uri or "/"
local chosen, chosen_len = nil, -1
for i = 1, n do
    local e = entries[i]
    -- rules_lib.parse already coerces cjson.null to nil; re-check on the hot path
    -- anyway — `#p` on userdata aborts the access phase for every request.
    local p = e.pathPrefix
    if type(p) ~= "string" then p = nil end
    if p == nil or p == "" or p == "/" then
        if chosen_len < 0 then chosen, chosen_len = e, 0 end
    elseif uri == p or string.sub(uri, 1, #p) == p then
        if #p > chosen_len then chosen, chosen_len = e, #p end
    end
end
if not chosen then return end

local spec = chosen.spec
local deny_status = spec.blockStatus or 403

local ips = ngx.var.remote_addr or "0.0.0.0"
local ipi = lib.ipv4_to_int(ips)

-- Country resolved at most once per request (only when a country rule exists).
local country_cache
local function country_of()
    if country_cache == nil then
        local ok, geo = pcall(require, "openship.geo_country")
        country_cache = (ok and geo and geo.get_country_code(ips)) or false
    end
    return country_cache or nil
end

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
    if access.allowCountries and not access.allowCountries[country_of() or ""] then
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
        local cc = country_of()
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
