-- site_logger.lua
-- OpenResty log_by_lua - runs AFTER the response is sent.
-- Pure shared-dict analytics.  No Redis, no timers for counters, no batching.
-- Every incr() is atomic across workers.
--
-- Shared dict key schema (analytics zone):
--   s:{domain}:{epoch_min}:r        request count               (TTL 24h)
--   s:{domain}:{epoch_min}:i        bandwidth in  bytes         (TTL 24h)
--   s:{domain}:{epoch_min}:o        bandwidth out bytes         (TTL 24h)
--   s:{domain}:{epoch_min}:t        response time sum (seconds) (TTL 24h)
--   s:{domain}:{epoch_min}:u        page (non-static) requests  (TTL 24h)
--   c:{domain}:{epoch_min}:{CC}     country per minute          (TTL 24h)
--   t:{domain}:r / :i / :o          lifetime totals             (no TTL)
--   d:{domain}                      domain index marker         (no TTL)
--
--   Daily rollup, all under one `g:{domain}:{YYYYMMDD}:` prefix so mgmt_api's
--   /analytics/geo serves the whole day in a SINGLE dict scan:
--   g:{domain}:{YYYYMMDD}:{CC}      country hit count           (TTL 48h)
--   g:{domain}:{YYYYMMDD}:v         distinct visitors           (TTL 48h)
--   g:{domain}:{YYYYMMDD}:p:{path}  path hit count              (TTL 48h)
--   g:{domain}:{YYYYMMDD}:s:{code}  status-code count           (TTL 48h)
--
-- Shared dict key schema (visitors zone):
--   vsalt:{YYYYMMDD}                per-day hash salt           (TTL 48h)
--   vd:{domain}:{YYYYMMDD}:{hash}   distinct-visitor marker     (TTL 48h)
--
-- Shared dict key schema (request_data zone):
--   rlog:{domain}:seq               monotonic write pointer
--   rlog:{domain}:{slot}            JSON entry (ring buf)       (TTL 1h)
--
-- The ring is ALSO the live source: pipe_stream.lua's SSE endpoint reads these
-- slots by a per-connection cursor, so there is no separate live queue or
-- subscriber flag — every watcher sees the full stream and steals from none.
--
-- NOTE on `:u` — it counts non-static REQUESTS, not people. It was surfaced as
-- "unique IPs" all the way to the dashboard, which it never was. Real distinct
-- visitors are the `vd:`/`:v` pair below.

local cjson = require "cjson.safe"

-- SAFE LOAD: GeoIP Module (per-worker, cached by require)
local geo_ok, geo = pcall(require, "openship.geo_country")
if not geo_ok then
    geo = nil
    ngx.log(ngx.WARN, "[site_logger] geo_country module not available. GeoIP disabled.")
end

local analytics    = ngx.shared.analytics
local request_data = ngx.shared.request_data
-- Per-host edge config, pushed by the API (see mgmt_api's /analytics/config).
--
-- The `rules` zone, NOT `analytics`: this holds a handful of small config values and is
-- never under eviction pressure, whereas the analytics zone is a 256 MB churn of counters.
-- An evicted flag there would silently stop path collection with nothing to explain why.
local rules_dict   = ngx.shared.rules
-- Optional: a box whose nginx.conf predates this zone keeps working, just without
-- distinct-visitor counts. Never assume a dict exists.
local visitors     = ngx.shared.visitors
if not analytics or not request_data then return end

-- ── Helpers ──────────────────────────────────────────────────────────────────

local function normalize(host)
    if not host then return nil end
    local h = host:lower()
    if h:sub(1, 4) == "www." then h = h:sub(5) end
    return h
end

local _day = { str = "", ts = 0 }
local function today()
    local now = ngx.now()
    if now - _day.ts > 60 then
        _day.str = os.date("!%Y%m%d", now)
        _day.ts = now
    end
    return _day.str
end

-- Fast check if URI is a static asset (for unique_requests counter)
local function is_static_asset(u)
    local lower = u:lower()

    -- Static file extensions
    if lower:match("%.js$") or lower:match("%.css$") or
       lower:match("%.jpg$") or lower:match("%.jpeg$") or
       lower:match("%.png$") or lower:match("%.gif$") or
       lower:match("%.svg$") or lower:match("%.webp$") or
       lower:match("%.ico$") or lower:match("%.bmp$") or
       lower:match("%.woff2?$") or lower:match("%.ttf$") or
       lower:match("%.eot$") or lower:match("%.otf$") or
       lower:match("%.mp4$") or lower:match("%.webm$") or
       lower:match("%.mp3$") or lower:match("%.wav$") or
       lower:match("%.pdf$") or lower:match("%.zip$") or
       lower:match("%.tar$") or lower:match("%.gz$") or
       lower:match("%.xml$") or lower:match("%.json$") or
       lower:match("%.txt$") or lower:match("%.map$") then
        return true
    end

    -- Common static paths
    if lower:match("^/_next/static/") or
       lower:match("^/static/") or
       lower:match("^/assets/") or
       lower:match("^/public/") or
       lower:match("/favicon%.ico") then
        return true
    end

    return false
end

-- Collapse a request URI into a low-cardinality bucket suitable as a dict key.
-- Without this, "top paths" is unbounded: every ?token=, every /orders/48219, and
-- every 404 a scanner probes mints a permanent key, and the analytics zone
-- LRU-evicts real counters to store junk.
local function normalize_path(u)
    -- Query string carries ids/tokens and never identifies the route.
    local path = u:match("^([^?#]*)") or u
    if path == "" then return "/" end
    -- Numeric and UUID/hex segments are ids, not routes: /orders/48219 and
    -- /orders/48220 are one path.
    path = path:gsub("/%d+", "/:id")
    path = path:gsub("/%x%x%x%x%x%x%x%x%-?%x*%-?%x*%-?%x*%-?%x*", "/:id")
    -- Bound the key itself — a long URI must not become a long key.
    if #path > 120 then path = path:sub(1, 120) .. "…" end
    return path
end

-- ── Enumerable sets, without a zone scan ─────────────────────────────────────
--
-- Reading these counters back used to need key DISCOVERY, and a shared dict offers exactly
-- one mechanism for that: `get_keys`, which walks EVERY key in the zone holding its lock.
-- Cost scaled with how much was in the 256 MB zone, not with what was being asked for, and
-- it ran on the mgmt path four different ways.
--
-- So every unbounded set now carries its own index: a counter plus numbered slots.
--
--     <counter>        how many distinct members
--     <prefix><n>      the n-th member
--
-- A reader reads the counter and then reads slots 1..n. Bounded by the answer.
--
-- The write only happens on a member's FIRST sighting, so steady state costs nothing: the
-- millionth request from Germany today takes the plain `incr` path and touches no index.
local function index_add(counter_key, slot_prefix, member, ttl)
    local n = analytics:incr(counter_key, 1, 0, ttl)
    if n then analytics:set(slot_prefix .. n, member, ttl) end
end

--- Add 1 to a counter, creating it (with TTL) and indexing it on first sighting.
--
-- `incr` with no `init` returns nil for an absent key, which doubles as the existence
-- probe — so the common case is ONE hash operation. TTL is set by the creating `safe_add`
-- rather than passed to `incr`: shdict rejects `init_ttl` without `init`, and that raises a
-- Lua error which aborts the whole log handler (it has silently zeroed every counter below
-- it before).
local function bump_indexed(key, ttl, counter_key, slot_prefix, member)
    if analytics:incr(key, 1) then return end
    if analytics:safe_add(key, 1, ttl) then
        index_add(counter_key, slot_prefix, member, ttl)
    else
        -- Another worker created it between our probe and our add; our +1 still counts.
        analytics:incr(key, 1)
    end
end

local RING   = 1000
local D24H   = 86400
local D48H   = 172800
local D1H    = 3600

-- Distinct paths tracked per domain per day. Past this the tail folds into
-- "other" rather than growing the zone — a URL-fuzzing bot is capped at one
-- extra key, not thousands.
local PATH_CARDINALITY_CAP = 2000

-- ── Capture ──────────────────────────────────────────────────────────────────

local host = normalize(ngx.var.host)
if not host then return end

local ip      = ngx.var.remote_addr    or "0.0.0.0"
local ts      = ngx.now()
local ua      = ngx.var.http_user_agent or ""
local uri     = ngx.var.request_uri    or "/"
local req_len = tonumber(ngx.var.request_length) or 0
local bytes   = tonumber(ngx.var.bytes_sent)     or 0
local rt      = tonumber(ngx.var.request_time)   or 0  -- seconds (float)
local method  = ngx.var.request_method or "GET"
local status  = ngx.var.status         or "0"

-- Client country, resolved ONCE per request.
--
-- Hoisted out of the geo block because both the daily/per-minute rollups and the raw
-- ring buffer need it. The ring is the single source for the request log — /logs/recent
-- reads it directly and the live SSE stream (pipe_stream.lua) reads the same slots by
-- cursor — so resolving the country here means every row carries its flag no matter
-- which path delivered it. An earlier split (looked up in the rollup, again in a
-- separate live pipe) left the ring with no country at all.
--
-- pcall'd because a corrupt or partially-written mmdb makes the lookup raise, and an
-- error here would abort every counter below it (see the section header).
local cc = nil
if geo and geo.get_country_code then
    local ok_cc, res = pcall(geo.get_country_code, ip)
    if ok_cc and type(res) == "string" and res ~= "" then cc = res end
end

-- ── 1. Minute-bucket counters ────────────────────────────────────────────────

local minute = math.floor(ts / 60)
local p = "s:" .. host .. ":" .. minute

analytics:incr(p .. ":r", 1,      0, D24H)
analytics:incr(p .. ":i", req_len, 0, D24H)
analytics:incr(p .. ":o", bytes,   0, D24H)

-- Response time as float seconds (matches original precision)
if rt > 0 then
    -- safe_add initializes, incr adds - emulate HINCRBYFLOAT with integer micros
    local rt_us = math.floor(rt * 1000000)
    analytics:incr(p .. ":t", rt_us, 0, D24H)
end

-- Unique (non-static) request counter
if not is_static_asset(uri) then
    analytics:incr(p .. ":u", 1, 0, D24H)
end

-- ── 2. Lifetime totals ──────────────────────────────────────────────────────

analytics:incr("t:" .. host .. ":r", 1,       0)
analytics:incr("t:" .. host .. ":i", req_len, 0)
analytics:incr("t:" .. host .. ":o", bytes,   0)

-- Domain index. `safe_add` returning true means this is the first request this box has
-- ever seen for the host, which is exactly when the enumerable index needs appending —
-- so domain discovery no longer costs a zone scan either.
if analytics:safe_add("d:" .. host, 1) then
    index_add("dn", "di:", host)
end

-- ── 3. Daily rollup: geo, visitors, paths, statuses ──────────────────────────
--
-- Each sub-block is pcall'd SEPARATELY, and that is load-bearing rather than
-- defensive habit. A raised error in log_by_lua aborts the remainder of the
-- handler, so one bad shdict call silently zeroes every counter written after it —
-- which is exactly what an `incr(..., nil, ttl)` here did: paths AND statuses read
-- as "no traffic" while requests and bandwidth looked perfect. Isolating them
-- means a future edit can lose at most its own metric.

local day  = today()
local gpfx = "g:" .. host .. ":" .. day .. ":"

-- 3a. GeoIP. `cc` was resolved once above and is reused by the ring buffer and the
-- live pipe, so a request costs exactly one mmdb lookup no matter how many consumers
-- report its country.
if cc then
    pcall(function()
        -- Daily geo (for /analytics/geo endpoint)
        bump_indexed(gpfx .. cc, D48H, gpfx .. "cn", gpfx .. "ci:", cc)
        -- Per-minute geo (for the time-series country breakdown). Indexed per MINUTE, so
        -- the scraper reads only the minutes in its window.
        local mpfx = "c:" .. host .. ":" .. minute .. ":"
        bump_indexed(mpfx .. cc, D24H, mpfx .. "n", mpfx .. "i:", cc)
    end)
end

-- 3b. Distinct visitors — a COUNT, never an identity.
--
-- The address is hashed with a salt that is generated on this box, rotates daily,
-- and is never written anywhere but this shared dict, so the marker keys are not
-- reversible to an IP and are worthless the next day. Only the resulting counter
-- is ever flushed to Postgres; no per-visitor row exists at any layer. That is
-- what lets us report real visitor numbers while still not collecting behavioural
-- analytics on anyone's end users.
--
-- Per DAY, not per minute: a per-minute set is ~1440x the keys for a number
-- nobody reads, and would evict the counters it exists to annotate.
pcall(function()
if visitors then
    local salt_key = "vsalt:" .. day
    local salt = visitors:get(salt_key)
    if not salt then
        -- First writer wins; a racing worker's safe_add fails and it re-reads. The
        -- salt only has to be unpredictable and stable for the day.
        salt = tostring(ngx.now()) .. tostring(math.random(1, 2147483647))
        local ok = visitors:safe_add(salt_key, salt, D48H)
        if not ok then salt = visitors:get(salt_key) or salt end
    end
    -- safe_add is the dedup: it succeeds ONLY on this visitor's first request
    -- today, so the counter below increments exactly once per distinct visitor.
    local marker = "vd:" .. host .. ":" .. day .. ":" .. ngx.crc32_long(salt .. ip)
    if visitors:safe_add(marker, 1, D48H) then
        analytics:incr(gpfx .. "v", 1, 0, D48H)
    end
end
end)

-- 3c. Top paths — OPT-IN, non-static only, normalized and cardinality-capped.
--
-- Off unless the project turned it on, because this one block is the most expensive thing
-- the log handler does. Measured on the shipped edge image, per request:
--
--     paths (whole block)        1.72 us      <- 57% of the counter path
--       of which string work     1.38 us      normalize_path + is_static_asset
--     minute buckets (5 incr)    0.61 us
--     country (2 incr)           0.24 us
--     status (1 incr)            0.14 us
--     this flag read (1 get)     0.07 us
--
-- So the gate costs 0.07 us and saves 1.72 us — the counter path drops from ~3.0 us to
-- ~1.35 us with paths off. It is also the highest-cardinality dimension (up to
-- PATH_CARDINALITY_CAP keys per domain per day, against ~200 countries and a few dozen
-- statuses) and the largest column in the daily rollup.
--
-- Absent flag = off. A box whose dict was just restarted therefore collects nothing until
-- the API re-pushes, which is the safe direction: no data beats data nobody asked to pay
-- for. The DB is the source of truth and re-pushes on every route apply.
local collect_paths = rules_dict and rules_dict:get("cfg:" .. host .. ":paths")

pcall(function()
if collect_paths and not is_static_asset(uri) then
    -- Hoisted: normalize_path is the single most expensive call in this handler (~1.4 us
    -- of string work), so it runs exactly once even though both the counter key and the
    -- index slot need its result.
    local norm = normalize_path(uri)
    local path_key = gpfx .. "p:" .. norm
    -- incr-then-add: the hot path is ONE hash hit on an existing key. `incr` with
    -- no init returns nil for an absent key, which doubles as the existence probe,
    -- so only a path unseen today reaches the cap check below.
    --
    -- Deliberately no init_ttl here: shdict rejects init_ttl unless init is also
    -- given ("'init_ttl' must be used with 'init'"), and that raises a Lua error
    -- which aborts the whole log handler — taking the status counters below down
    -- with it. The TTL is set by the safe_add on the creating request instead.
    if not analytics:incr(path_key, 1) then
        local distinct = analytics:incr(gpfx .. "pn", 1, 0, D48H) or 0
        if distinct > PATH_CARDINALITY_CAP then
            analytics:incr(gpfx .. "p:other", 1, 0, D48H)
        else
            -- `pn` was already the distinct-path counter, so the slots just give it an
            -- enumerable side. Stored WITHOUT the "p:" prefix; the reader adds it back.
            if analytics:safe_add(path_key, 1, D48H) then
                analytics:set(gpfx .. "pi:" .. distinct, norm, D48H)
            end
        end
    end
end
end)

-- 3d. Status-code mix. Bounded by construction (a few dozen codes).
pcall(function()
    bump_indexed(gpfx .. "s:" .. status, D48H, gpfx .. "sn", gpfx .. "si:", status)
end)

-- ── 4. Raw request ring buffer (also the live SSE source) ────────────────────
--
-- `seq` is claimed BEFORE encoding so the stored JSON can carry a deterministic
-- id (`{host}:{seq}`). That id is the dedup key everywhere downstream: /logs/recent
-- returns these entries verbatim, and pipe_stream.lua streams the same slots live,
-- so the same request reaches the client with one stable id instead of a fresh
-- random one per source. `incr` with init 0 never returns nil here; guard anyway
-- so a shdict hiccup can't index a nil into the slot key.

pcall(function()
    local seq = request_data:incr("rlog:" .. host .. ":seq", 1, 0)
    if not seq then return end
    local ok_j, j = pcall(cjson.encode, {
        id     = host .. ":" .. seq,
        ip     = ip,
        -- nil is simply omitted by cjson, so a box with no GeoIP writes the same shape
        -- minus this key rather than a null the reader has to special-case.
        country = cc,
        ts     = ts,
        method = method,
        status = status,
        uri    = uri,
        ua     = ua,
        bw_in  = req_len,
        bw_out = bytes,
        rt     = rt,
    })
    if ok_j and j then
        request_data:set("rlog:" .. host .. ":" .. (seq % RING), j, D1H)
    end
end)
