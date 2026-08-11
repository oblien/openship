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
-- Bare "ok", NOT JSON. probeMgmt() in apps/api/src/lib/project-analytics.ts
-- asserts `body.trim() === "ok"`, so anything richer here silently reports every
-- edge as unreachable and stops the analytics scrape. Richer diagnostics go on
-- /status below.

if uri == "/health" then
    ngx.say("ok")
    return ngx.exit(200)
end

-- ── GET /status - diagnosable edge health ────────────────────────────────────
-- Why this exists: geo failing is INVISIBLE otherwise. geo_country.lua pcalls its
-- FFI binding and returns nil on failure, so a missing libmaxminddb.so or a
-- missing database presents exactly like "nobody visited from a known country" —
-- an empty map with no error anywhere. This reports which it is.
--
-- Also reports shared-dict headroom: these zones LRU-EVICT when full rather than
-- erroring, so a full `visitors` zone silently UNDERCOUNTS. Callers surface that
-- as "approximate" instead of presenting an eviction artifact as a measurement.

if uri == "/status" then
    local geo_available, geo_reason, geo_db = false, "geo_country module not loadable", nil
    local geo_ok, geo = pcall(require, "openship.geo_country")
    if geo_ok and geo and geo.status then
        geo_available, geo_reason, geo_db = geo.status()
    end

    local dicts = {}
    for _, name in ipairs({ "analytics", "request_data", "rules", "rl_counters", "visitors" }) do
        local d = ngx.shared[name]
        if d then
            dicts[name] = {
                capacity   = d.capacity and d:capacity() or nil,
                free_space = d.free_space and d:free_space() or nil,
            }
        end
    end

    return json({
        ok  = true,
        geo = { available = geo_available, reason = geo_reason, db = geo_db },
        dicts = dicts,
    })
end

-- ── /rules - per-route rules cache (written by the API, read by rules_guard) ──
-- POST /rules  body: { "host": "...", "rules": [ { "pathPrefix": "/", "spec": {...} } ] }
--   → replaces the ruleset for that host in the `rules` shared dict (reload-free).
--   An empty/absent `rules` array clears the host.
-- GET  /rules?host=...   → the stored ruleset (debug).
-- DELETE /rules?host=... → clear the host's ruleset.
-- Handled BEFORE the analytics guard: rules use their own dict.
-- ── /analytics/config - per-host collection switches ─────────────────────────
--
-- POST body: { "hosts": [ { "host": "...", "paths": true|false }, ... ] }
-- GET  ?host=...  → { host, paths }
--
-- A LIST, not a single host: a shared dict is RAM, so a full nginx restart (a reboot, a
-- `docker restart`, a package upgrade) empties it and every host on the box has to be
-- re-set at once. `openresty -s reload` preserves the zone — verified — so only a real
-- restart loses it, which is why the reconcile below exists and why it needs to cost one
-- round trip per server rather than one per domain.
--
-- Lives in the `rules` zone rather than `analytics` for the reason site_logger states:
-- the analytics zone is a 256 MB churn of counters under LRU pressure, and an evicted
-- config flag would silently change what is collected. This zone holds a few small values.
--
-- Deliberately its own endpoint rather than a field on /rules: the API only pushes /rules
-- for hosts that HAVE rules, so a project with none would never receive this flag.
--
-- No TTL — a shared dict is RAM and is lost on restart either way, so the API re-pushes on
-- every route apply and the database stays the source of truth.
if uri == "/analytics/config" then
    local rules = ngx.shared.rules
    if not rules then return json({ error = "rules dict unavailable" }, 503) end
    local method = ngx.req.get_method()

    if method == "GET" then
        local host = ngx.var.arg_host
        if not host or host == "" then return bad("missing ?host=") end
        host = host:lower()
        return json({ host = host, paths = rules:get("cfg:" .. host .. ":paths") == 1 })
    end

    if method == "POST" then
        ngx.req.read_body()
        local body = ngx.req.get_body_data()
        if not body then return bad("empty body") end
        local payload = cjson.decode(body)
        if type(payload) ~= "table" or type(payload.hosts) ~= "table" then
            return bad("expected { hosts: [ { host, paths } ] }")
        end
        local applied = 0
        for _, entry in ipairs(payload.hosts) do
            if type(entry) == "table" and entry.host then
                local key = "cfg:" .. tostring(entry.host):lower() .. ":paths"
                if entry.paths == true then
                    rules:set(key, 1)
                else
                    -- Deleted rather than set to 0, so "absent" is the only off state there
                    -- is. Two representations of off is how a reader ends up treating one of
                    -- them as on — and absent is also what a restarted box starts from, so
                    -- off has to mean exactly the same thing in both cases.
                    rules:delete(key)
                end
                applied = applied + 1
            end
        end
        return json({ ok = true, applied = applied })
    end

    return json({ error = "method not allowed" }, 405)
end

if uri == "/rules" then
    local rules = ngx.shared.rules
    if not rules then return json({ error = "rules dict unavailable" }, 503) end
    local method = ngx.req.get_method()

    if method == "GET" then
        local host = ngx.var.arg_host
        if not host or host == "" then return bad("missing ?host=") end
        host = host:lower()
        local raw = rules:get(host)
        return json({ host = host, rules = raw and cjson.decode(raw) or {} })
    end

    if method == "DELETE" then
        local host = ngx.var.arg_host
        if not host or host == "" then return bad("missing ?host=") end
        rules:delete(host:lower())
        return json({ ok = true })
    end

    if method == "POST" then
        ngx.req.read_body()
        local body = ngx.req.get_body_data()
        if not body then return bad("empty body") end
        local payload = cjson.decode(body)
        if type(payload) ~= "table" or not payload.host then
            return bad("expected { host, rules: [...] }")
        end
        local host = tostring(payload.host):lower()
        local list = payload.rules
        if type(list) ~= "table" or #list == 0 then
            rules:delete(host)                 -- empty set = clear the host
            return json({ ok = true, host = host, count = 0 })
        end
        local ok, err = rules:set(host, cjson.encode(list))
        if not ok then return json({ error = "set failed: " .. (err or "?") }, 500) end
        return json({ ok = true, host = host, count = #list })
    end

    return json({ error = "method not allowed" }, 405)
end

if not analytics then
    return json({ error = "analytics dict unavailable" }, 503)
end

-- ── Per-minute country index ─────────────────────────────────────────────────
--
-- site_logger writes one key per (domain, minute, country): `c:{domain}:{min}:{CC}`.
-- Reading them back needs key DISCOVERY, and `get_keys` is the only mechanism.
--
-- This used to sit INSIDE the per-minute loop, so a 24h window ran up to 1440
-- `get_keys(10000)` calls — each a full scan of a 256 MB zone, each holding the
-- dict lock against every worker. One scan per request instead, bucketed by
-- minute in a single pass; the loop then does plain table lookups.
--
-- `get_keys(0)` (all keys) rather than 10000: the cap silently TRUNCATED, so a
-- busy box just lost countries with no error. Unbounded is safe precisely because
-- this is now called once — see the comment on the call.
--- Read an enumerable set written by site_logger's index_add.
--
-- Replaces `get_keys`, which walked EVERY key in the 256 MB zone holding its lock — cost
-- proportional to zone population rather than to the answer, on a path called four
-- different ways. Here the counter says how many members exist and the slots name them, so
-- a read costs exactly as much as the data it returns.
--
-- Over-reads slightly by design: a slot can be written twice if two workers race on a
-- member's first sighting, and slots outlive nothing (same TTL as their counters). Both
-- collapse harmlessly because the caller keys results by member.
local function read_index(counter_key, slot_prefix)
    local n = tonumber(analytics:get(counter_key)) or 0
    if n <= 0 then return {} end
    local out, seen = {}, {}
    for i = 1, n do
        local m = analytics:get(slot_prefix .. i)
        if m and not seen[m] then
            seen[m] = true
            out[#out + 1] = m
        end
    end
    return out
end

--- Drain a counter WITHOUT losing a concurrent increment.
--
-- Was `get` then `delete`: a request landing between the two had its count deleted along
-- with the value that had just been read. Subtracting exactly what was read leaves any
-- concurrent increment behind as a residual the next scrape collects.
local function drain(key)
    local v = tonumber(analytics:get(key)) or 0
    if v ~= 0 then analytics:incr(key, -v) end
    return v
end

--- One day's rollup for one domain, read through its indexes.
--
-- Returns the same `suffix → value` shape the old whole-zone classifier produced, so both
-- callers stayed unchanged: bare country codes, `s:{code}`, `p:{path}`, `v`, `pn`.
local function read_rollup(domain, day)
    local gpfx = "g:" .. domain .. ":" .. day .. ":"
    local out = {}

    for _, cc in ipairs(read_index(gpfx .. "cn", gpfx .. "ci:")) do
        out[cc] = tonumber(analytics:get(gpfx .. cc)) or 0
    end
    for _, code in ipairs(read_index(gpfx .. "sn", gpfx .. "si:")) do
        out["s:" .. code] = tonumber(analytics:get(gpfx .. "s:" .. code)) or 0
    end
    -- `pn` doubles as the path index's counter, so paths need no separate one. When path
    -- collection is switched off for this host there is no counter and this reads nothing.
    for _, path in ipairs(read_index(gpfx .. "pn", gpfx .. "pi:")) do
        out["p:" .. path] = tonumber(analytics:get(gpfx .. "p:" .. path)) or 0
    end
    -- The over-cap bucket has a fixed name, so it is not in the index.
    local other = tonumber(analytics:get(gpfx .. "p:other"))
    if other then out["p:other"] = other end

    local v = tonumber(analytics:get(gpfx .. "v"))
    if v then out["v"] = v end
    return out
end

local function scan_country_index(domain, from_m, to_m)
    -- Walks the requested MINUTES and reads each one's own index. Bounded by the window
    -- (capped at 1440 by the caller), not by how much is in the zone.
    local by_minute = {}
    for m = from_m, to_m do
        local mpfx = "c:" .. domain .. ":" .. m .. ":"
        local ccs = read_index(mpfx .. "n", mpfx .. "i:")
        if #ccs > 0 then
            local slot = {}
            for i = 1, #ccs do
                -- Full key, because the flush drains by key.
                slot[ccs[i]] = mpfx .. ccs[i]
            end
            by_minute[m] = slot
        end
    end
    return by_minute
end

--- Split a namespaced analytics key into kind / domain / mid / rest.
--
-- Layouts: `c:{domain}:{minute}:{CC}` and `g:{domain}:{day}:{suffix}`.
-- Positional, NOT a full split on ":", because `suffix` legitimately contains
-- colons — a normalized path key looks like `g:x.com:20260803:p:/users/:id`.
-- Hostnames cannot contain ":", so the first three separators are unambiguous.
local function split_key(k)
    local p1 = k:find(":", 1, true)
    if not p1 then return nil end
    local p2 = k:find(":", p1 + 1, true)
    if not p2 then return nil end
    local p3 = k:find(":", p2 + 1, true)
    if not p3 then
        return k:sub(1, p1 - 1), k:sub(p1 + 1, p2 - 1), k:sub(p2 + 1), nil
    end
    return k:sub(1, p1 - 1), k:sub(p1 + 1, p2 - 1), k:sub(p2 + 1, p3 - 1), k:sub(p3 + 1)
end

--- Read one minute's country counts out of a scanned index.
-- @param slot table|nil  CC → full dict key, from scan_country_index
-- @param del boolean     drain each key after reading (flush semantics)
-- @return table|nil counts, or nil when the minute had no country data
local function read_minute_countries(slot, del)
    if not slot then return nil end
    local counts, any = {}, false
    for cc, key in pairs(slot) do
        -- `drain` subtracts what it read instead of deleting, so a request arriving
        -- mid-flush is not thrown away with the value that was just read.
        counts[cc] = del and drain(key) or (tonumber(analytics:get(key)) or 0)
        any = true
    end
    return any and counts or nil
end

-- ── POST /analytics/collect - the SCRAPER's endpoint: every domain, ONE scan ──
--
-- Body: { "day": "YYYYMMDD", "domains": [ { "domain": "x.com", "from": M, "to": M } ] }
-- Returns: { "domains": { "x.com": { buckets: [...], flushed: N, rollup: {...} } } }
--
-- Why this exists rather than looping the single-domain endpoints:
--
-- `get_keys` is the only key-discovery mechanism a shared dict offers, it walks the
-- WHOLE zone, and it holds the dict lock against every nginx worker while it does.
-- The scraper needs both the per-minute countries (flush) and the daily rollup for
-- each domain, so calling the per-domain endpoints cost 2N+1 unbounded scans of a
-- 256 MB zone — plus 2N+1 SSH/exec round trips — every sweep. On a 50-domain box
-- that is 101 full scans and 101 round trips, on a schedule, to collect data that
-- one pass already has in hand.
--
-- So: one `get_keys(0)`, classify every key by (kind, domain) in a single pass, then
-- serve all domains from the in-memory index. 2N+1 scans → 1, and 2N+1 round trips
-- → 1. The per-domain GET endpoints stay for the READ path, where a page view wants
-- one domain's live tail and a single scan is the honest cost.
--
-- Flush semantics are unchanged and still atomic per key: minute counters and their
-- country keys are deleted as they are read, so a bucket is handed to exactly one
-- caller no matter how many collectors race. The daily rollup is read-only — the
-- edge keeps running totals for the day, and deleting them would lose the totals for
-- every later scrape of the same day.

if uri == "/analytics/collect" and ngx.req.get_method() == "POST" then
    ngx.req.read_body()
    local body = ngx.req.get_body_data()
    if not body then return bad("empty body") end
    local payload = cjson.decode(body)
    if type(payload) ~= "table" or type(payload.domains) ~= "table" then
        return bad('expected { day, domains: [{domain, from, to}] }')
    end

    local day = payload.day
    if type(day) ~= "string" or #day ~= 8 then day = os.date("!%Y%m%d") end

    -- Requested domains → their minute window. Also the membership test the scan
    -- uses, so an unrequested domain's keys are skipped without a string compare
    -- per domain.
    local want, order = {}, {}
    for i = 1, #payload.domains do
        local d = payload.domains[i]
        if type(d) == "table" and type(d.domain) == "string" and d.domain ~= "" then
            local name = d.domain:lower()
            local from_m, to_m = tonumber(d.from), tonumber(d.to)
            if from_m and to_m then
                if to_m - from_m > 1440 then to_m = from_m + 1440 end -- cap at 24h
                if not want[name] then order[#order + 1] = name end
                want[name] = { from = from_m, to = to_m }
            end
        end
    end
    if #order == 0 then return json({ domains = {} }) end

    -- ── Per-domain index reads ───────────────────────────────────────────────
    --
    -- Was a single `get_keys(0)` pass classifying every key in the zone. One scan is better
    -- than 2N+1, but it still walked keys belonging to domains nobody asked about, and held
    -- the zone lock while doing it. Now each requested domain reads only its own indexes.
    local countries = {}   -- domain → minute → CC → dict key
    local rollups = {}     -- domain → suffix → value
    for i = 1, #order do
        local domain = order[i]
        local w = want[domain]
        countries[domain] = scan_country_index(domain, w.from, w.to)
        rollups[domain] = read_rollup(domain, day)
    end

    -- ── Serve each domain from the index ─────────────────────────────────────
    local out = {}
    for i = 1, #order do
        local domain = order[i]
        local w = want[domain]
        local cidx = countries[domain] or {}

        local buckets, flushed = {}, 0
        for m = w.from, w.to do
            local p = "s:" .. domain .. ":" .. m
            -- Drain FIRST, then decide: `drain` returns what it took, and a counter left
            -- at 0 by an earlier flush must not emit a bucket of zeros. (Zero is truthy in
            -- Lua, so the old `if r then` would have started doing exactly that the moment
            -- keys stopped being deleted.)
            local r = drain(p .. ":r")
            if r > 0 then
                local rt_us = drain(p .. ":t")
                buckets[#buckets + 1] = {
                    minute          = m,
                    requests        = r,
                    unique_requests = drain(p .. ":u"),
                    bandwidth_in    = drain(p .. ":i"),
                    bandwidth_out   = drain(p .. ":o"),
                    response_time   = rt_us / 1000000,
                    countries       = read_minute_countries(cidx[m], true),
                }
                flushed = flushed + 1
            end
        end

        -- Daily rollup, same key classification the single-domain endpoint uses.
        local geo, paths, statuses, visitors = {}, {}, {}, 0
        for suffix, v in pairs(rollups[domain] or {}) do
            if suffix == "v" then
                visitors = v
            elseif suffix:sub(1, 2) == "p:" then
                paths[suffix:sub(3)] = v
            elseif suffix:sub(1, 2) == "s:" then
                statuses[suffix:sub(3)] = v
            elseif suffix:match("^%u%u$") then
                geo[suffix] = v
            end
            -- Anything else (`pn`) is bookkeeping: never reported as a country.
        end

        out[domain] = {
            buckets = buckets,
            flushed = flushed,
            rollup  = {
                day = day, countries = geo, visitors = visitors,
                paths = paths, statuses = statuses,
            },
        }
    end

    return json({ day = day, domains = out })
end

-- ── GET /analytics - minute-bucket time series ───────────────────────────────
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

    -- ONE scan for the whole window (see scan_country_index).
    local country_index = scan_country_index(domain, from_m, to_m)

    local buckets = {}
    for m = from_m, to_m do
        local p = "s:" .. domain .. ":" .. m
        local r = analytics:get(p .. ":r")
        if r then
            -- Response time stored as microseconds, convert to seconds (float)
            local rt_us = analytics:get(p .. ":t") or 0
            buckets[#buckets + 1] = {
                minute           = m,
                requests         = r,
                unique_requests  = analytics:get(p .. ":u") or 0,
                bandwidth_in     = analytics:get(p .. ":i") or 0,
                bandwidth_out    = analytics:get(p .. ":o") or 0,
                response_time    = rt_us / 1000000,
                countries        = read_minute_countries(country_index[m], false),
            }
        end
    end

    return json({ domain = domain, buckets = buckets })
end

-- ── POST /analytics/flush - read + delete minute buckets ─────────────────────
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

    -- ONE scan for the whole window (see scan_country_index).
    local country_index = scan_country_index(domain, from_m, to_m)

    local buckets = {}
    local flushed = 0
    for m = from_m, to_m do
        local p = "s:" .. domain .. ":" .. m
        -- Drain, don't delete — see `drain`. A counter already at 0 is not a bucket.
        local r = drain(p .. ":r")
        if r > 0 then
            local rt_us = drain(p .. ":t")
            buckets[#buckets + 1] = {
                minute           = m,
                requests         = r,
                unique_requests  = drain(p .. ":u"),
                bandwidth_in     = drain(p .. ":i"),
                bandwidth_out    = drain(p .. ":o"),
                response_time    = rt_us / 1000000,
                -- Drained too: this endpoint hands the minute to the DB, so the country
                -- keys must go with it or they would be counted twice.
                countries        = read_minute_countries(country_index[m], true),
            }
            flushed = flushed + 1
        end
    end

    return json({ domain = domain, buckets = buckets, flushed = flushed })
end

-- ── GET /analytics/totals - lifetime counters ────────────────────────────────
-- ?domain=example.com      → single domain
-- (no domain)              → all known domains

if uri == "/analytics/totals" then
    local domain = ngx.var.arg_domain

    if not domain or domain == "" then
        -- The scraper's domain-discovery call. Read from the `dn`/`di:` index that
        -- site_logger appends to the first time it ever sees a host, so this no longer
        -- walks the zone. It was the worst place for a scan: a cap here silently dropped
        -- whole domains from every subsequent flush.
        local domains = {}
        for _, d in ipairs(read_index("dn", "di:")) do
            -- A host can be indexed but have had its lifetime totals evicted; report it
            -- with zeros rather than omitting it, so the scraper still asks for its buckets.
            domains[#domains + 1] = {
                domain        = d,
                requests      = analytics:get("t:" .. d .. ":r") or 0,
                bandwidth_in  = analytics:get("t:" .. d .. ":i") or 0,
                bandwidth_out = analytics:get("t:" .. d .. ":o") or 0,
            }
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

-- ── GET /analytics/geo - daily rollup for a day ──────────────────────────────
-- ?domain=example.com&day=YYYYMMDD
--
-- Named /geo for compatibility; it now returns the whole daily rollup — countries,
-- distinct visitors, top paths, status-code mix. One scan serves all four: they
-- share the `g:{domain}:{day}:` prefix precisely so a reader never needs a second
-- pass over the zone.
--
-- Key layout under that prefix (written by site_logger.lua):
--   <CC>            EXACTLY two uppercase letters → country hit count
--   v               distinct visitors today
--   p:<path>        path counter
--   pn              distinct-path counter (cardinality cap bookkeeping)
--   s:<status>      status-code counter
--
-- Country matching is strict (^%u%u$) rather than "whatever's left": a bookkeeping
-- key like `pn` would otherwise surface as a country named "pn" and get plotted.

if uri == "/analytics/geo" then
    local domain = ngx.var.arg_domain
    if not domain or domain == "" then return bad("missing ?domain=") end
    domain = domain:lower()

    local day = ngx.var.arg_day
    if not day or #day ~= 8 then
        day = os.date("!%Y%m%d")
    end

    -- Read through the write-time indexes — same helper /analytics/collect uses, so the two
    -- endpoints cannot disagree about what a day contains. Replaces a `get_keys(0)` that
    -- walked the whole zone to find keys under one prefix.
    local rollup = read_rollup(domain, day)
    local countries, paths, statuses = {}, {}, {}
    local visitors = tonumber(rollup["v"]) or 0
    for suffix, v in pairs(rollup) do
        if suffix == "v" or suffix == "pn" then
            -- bookkeeping, not data
        elseif suffix:sub(1, 2) == "p:" then
            paths[suffix:sub(3)] = v
        elseif suffix:sub(1, 2) == "s:" then
            statuses[suffix:sub(3)] = v
        elseif suffix:match("^%u%u$") then
            -- Country codes only. Anything else under this prefix is bookkeeping, and
            -- letting one through made `pn` plot as a country and skew every percentage.
            countries[suffix] = v
        end
    end
    return json({
        domain    = domain,
        day       = day,
        countries = countries,
        visitors  = visitors,
        paths     = paths,
        statuses  = statuses,
    })
end

-- ── GET /logs/recent - raw request ring buffer ───────────────────────────────
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
