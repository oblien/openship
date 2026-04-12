-- mgmt_api.lua
-- REST analytics endpoints backed by ngx.shared.dict.
-- Internal management port only (127.0.0.1:9145).

local cjson = require "cjson.safe"

local analytics    = ngx.shared.analytics
local request_data = ngx.shared.request_data
local uri          = ngx.var.uri

local function json(data, code)
    ngx.status = code or 200
    ngx.header["Content-Type"] = "application/json"
    ngx.say(cjson.encode(data))
    return ngx.exit(ngx.status)
end

local function bad(msg)
    return json({ error = msg }, 400)
end

-- ── GET /health ──────────────────────────────────────────────────────────────

if uri == "/health" then
    ngx.say("ok")
    return ngx.exit(200)
end

if not analytics then
    return json({ error = "analytics dict unavailable" }, 503)
end

-- ── GET /analytics — minute-bucket time series ───────────────────────────────
-- ?domain=example.com&from=EPOCH_MIN&to=EPOCH_MIN

if uri == "/analytics" then
    local domain = ngx.var.arg_domain
    if not domain or domain == "" then return bad("missing ?domain=") end
    domain = domain:lower()

    local from_m = tonumber(ngx.var.arg_from)
    local to_m   = tonumber(ngx.var.arg_to)
    if not from_m or not to_m then
        return bad("missing ?from= and ?to= (epoch minutes)")
    end
    -- Cap at 24h
    if to_m - from_m > 1440 then to_m = from_m + 1440 end

    local buckets = {}
    for m = from_m, to_m do
        local p = "s:" .. domain .. ":" .. m
        local r = analytics:get(p .. ":r")
        if r then
            -- Response time stored as microseconds, convert to seconds (float)
            local rt_us = analytics:get(p .. ":t") or 0
            local bucket = {
                minute           = m,
                requests         = r,
                unique_requests  = analytics:get(p .. ":u") or 0,
                bandwidth_in     = analytics:get(p .. ":i") or 0,
                bandwidth_out    = analytics:get(p .. ":o") or 0,
                response_time    = rt_us / 1000000,
            }

            -- Collect per-minute country data if present
            local cpfx = "c:" .. domain .. ":" .. m .. ":"
            local all_keys = analytics:get_keys(10000)
            local countries = {}
            local has_countries = false
            for _, k in ipairs(all_keys) do
                if k:sub(1, #cpfx) == cpfx then
                    countries[k:sub(#cpfx + 1)] = analytics:get(k) or 0
                    has_countries = true
                end
            end
            if has_countries then
                bucket.countries = countries
            end

            buckets[#buckets + 1] = bucket
        end
    end

    return json({ domain = domain, buckets = buckets })
end

-- ── POST /analytics/flush — read + delete minute buckets ─────────────────────
-- Same as GET /analytics but deletes the returned buckets from shared memory.
-- Used by the scraper to atomically move data from OpenResty → DB.
-- ?domain=example.com&from=EPOCH_MIN&to=EPOCH_MIN

if uri == "/analytics/flush" and ngx.req.get_method() == "POST" then
    local domain = ngx.var.arg_domain
    if not domain or domain == "" then return bad("missing ?domain=") end
    domain = domain:lower()

    local from_m = tonumber(ngx.var.arg_from)
    local to_m   = tonumber(ngx.var.arg_to)
    if not from_m or not to_m then
        return bad("missing ?from= and ?to= (epoch minutes)")
    end
    if to_m - from_m > 1440 then to_m = from_m + 1440 end

    local buckets = {}
    local flushed = 0
    for m = from_m, to_m do
        local p = "s:" .. domain .. ":" .. m
        local r = analytics:get(p .. ":r")
        if r then
            local rt_us = analytics:get(p .. ":t") or 0
            local bucket = {
                minute           = m,
                requests         = r,
                unique_requests  = analytics:get(p .. ":u") or 0,
                bandwidth_in     = analytics:get(p .. ":i") or 0,
                bandwidth_out    = analytics:get(p .. ":o") or 0,
                response_time    = rt_us / 1000000,
            }

            -- Collect per-minute country data
            local cpfx = "c:" .. domain .. ":" .. m .. ":"
            local all_keys = analytics:get_keys(10000)
            local countries = {}
            local has_countries = false
            for _, k in ipairs(all_keys) do
                if k:sub(1, #cpfx) == cpfx then
                    countries[k:sub(#cpfx + 1)] = analytics:get(k) or 0
                    analytics:delete(k)
                    has_countries = true
                end
            end
            if has_countries then bucket.countries = countries end

            buckets[#buckets + 1] = bucket

            -- Delete the minute-bucket counter keys
            analytics:delete(p .. ":r")
            analytics:delete(p .. ":i")
            analytics:delete(p .. ":o")
            analytics:delete(p .. ":t")
            analytics:delete(p .. ":u")
            flushed = flushed + 1
        end
    end

    return json({ domain = domain, buckets = buckets, flushed = flushed })
end

-- ── GET /analytics/totals — lifetime counters ────────────────────────────────
-- ?domain=example.com      → single domain
-- (no domain)              → all known domains

if uri == "/analytics/totals" then
    local domain = ngx.var.arg_domain

    if not domain or domain == "" then
        local keys = analytics:get_keys(10000)
        local domains = {}
        for _, k in ipairs(keys) do
            local d = k:match("^d:(.+)$")
            if d then
                domains[#domains + 1] = {
                    domain        = d,
                    requests      = analytics:get("t:" .. d .. ":r") or 0,
                    bandwidth_in  = analytics:get("t:" .. d .. ":i") or 0,
                    bandwidth_out = analytics:get("t:" .. d .. ":o") or 0,
                }
            end
        end
        return json({ domains = domains })
    end

    domain = domain:lower()
    return json({
        domain        = domain,
        requests      = analytics:get("t:" .. domain .. ":r") or 0,
        bandwidth_in  = analytics:get("t:" .. domain .. ":i") or 0,
        bandwidth_out = analytics:get("t:" .. domain .. ":o") or 0,
    })
end

-- ── GET /analytics/geo — country breakdown for a day ─────────────────────────
-- ?domain=example.com&day=YYYYMMDD

if uri == "/analytics/geo" then
    local domain = ngx.var.arg_domain
    if not domain or domain == "" then return bad("missing ?domain=") end
    domain = domain:lower()

    local day = ngx.var.arg_day
    if not day or #day ~= 8 then
        day = os.date("!%Y%m%d")
    end

    local prefix = "g:" .. domain .. ":" .. day .. ":"
    local keys = analytics:get_keys(10000)
    local countries = {}
    for _, k in ipairs(keys) do
        if k:sub(1, #prefix) == prefix then
            countries[k:sub(#prefix + 1)] = analytics:get(k) or 0
        end
    end

    return json({ domain = domain, day = day, countries = countries })
end

-- ── GET /logs/recent — raw request ring buffer ───────────────────────────────
-- ?domain=example.com&limit=50

if uri == "/logs/recent" then
    if not request_data then
        return json({ error = "request_data dict unavailable" }, 503)
    end

    local domain = ngx.var.arg_domain
    if not domain or domain == "" then return bad("missing ?domain=") end
    domain = domain:lower()

    local limit = math.min(tonumber(ngx.var.arg_limit) or 50, 1000)
    local seq   = request_data:get("rlog:" .. domain .. ":seq") or 0
    local out   = {}

    for i = 0, limit - 1 do
        local slot = (seq - i) % 1000
        if slot < 0 then slot = slot + 1000 end
        local raw = request_data:get("rlog:" .. domain .. ":" .. slot)
        if raw then out[#out + 1] = raw end
    end

    -- Return pre-encoded JSON entries as a JSON array
    ngx.header["Content-Type"] = "application/json"
    ngx.print("[")
    for idx, entry in ipairs(out) do
        if idx > 1 then ngx.print(",") end
        ngx.print(entry)
    end
    ngx.say("]")
    return ngx.exit(200)
end

-- ── 404 ──────────────────────────────────────────────────────────────────────
return json({ error = "not found" }, 404)
