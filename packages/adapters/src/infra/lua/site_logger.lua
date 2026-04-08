-- site_logger.lua
-- OpenResty log_by_lua — runs AFTER the response is sent.
-- Pure shared-dict analytics.  No Redis, no timers for counters, no batching.
-- Every incr() is atomic across workers.
--
-- Shared dict key schema (analytics zone):
--   s:{domain}:{epoch_min}:r        request count               (TTL 24h)
--   s:{domain}:{epoch_min}:i        bandwidth in  bytes         (TTL 24h)
--   s:{domain}:{epoch_min}:o        bandwidth out bytes         (TTL 24h)
--   s:{domain}:{epoch_min}:t        response time sum (seconds) (TTL 24h)
--   s:{domain}:{epoch_min}:u        unique (non-static) reqs    (TTL 24h)
--   g:{domain}:{YYYYMMDD}:{CC}      country hit count           (TTL 48h)
--   c:{domain}:{epoch_min}:{CC}     country per minute          (TTL 24h)
--   t:{domain}:r / :i / :o          lifetime totals             (no TTL)
--   d:{domain}                      domain index marker         (no TTL)
--
-- Shared dict key schema (request_data zone):
--   rlog:{domain}:seq               monotonic write pointer
--   rlog:{domain}:{slot}            JSON entry (ring buf)       (TTL 1h)
--   log_pipe:sub:{domain}           live subscriber flag        (TTL 30s)
--   log_pipe:q:{domain}             live log queue entries

local cjson = require "cjson.safe"

-- SAFE LOAD: GeoIP Module (per-worker, cached by require)
local geo_ok, geo = pcall(require, "openship.geo_country")
if not geo_ok then
    geo = nil
    ngx.log(ngx.WARN, "[site_logger] geo_country module not available. GeoIP disabled.")
end

-- SAFE LOAD: Pipe module (per-worker, cached by require)
local pipe_ok, pipe_log = pcall(require, "openship.pipe_log")
if not pipe_ok then pipe_log = nil end

local analytics    = ngx.shared.analytics
local request_data = ngx.shared.request_data
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

local RING   = 1000
local D24H   = 86400
local D48H   = 172800
local D1H    = 3600

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

-- ── 1. Minute-bucket counters ────────────────────────────────────────────────

local minute = math.floor(ts / 60)
local p = "s:" .. host .. ":" .. minute

analytics:incr(p .. ":r", 1,      0, D24H)
analytics:incr(p .. ":i", req_len, 0, D24H)
analytics:incr(p .. ":o", bytes,   0, D24H)

-- Response time as float seconds (matches original precision)
if rt > 0 then
    -- safe_add initializes, incr adds — emulate HINCRBYFLOAT with integer micros
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

-- Domain index (set once, ignore subsequent "exists" errors)
analytics:safe_add("d:" .. host, 1)

-- ── 3. GeoIP ─────────────────────────────────────────────────────────────────

if geo then
    local cc = geo.get_country_code(ip)
    if cc and cc ~= "" then
        -- Daily geo (for /analytics/geo endpoint)
        analytics:incr("g:" .. host .. ":" .. today() .. ":" .. cc, 1, 0, D48H)
        -- Per-minute geo (for time-series country breakdown)
        analytics:incr("c:" .. host .. ":" .. minute .. ":" .. cc, 1, 0, D24H)
    end
end

-- ── 4. Raw request ring buffer ──────────────────────────────────────────────

pcall(function()
    local ok_j, j = pcall(cjson.encode, {
        ip     = ip,
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
        local seq  = request_data:incr("rlog:" .. host .. ":seq", 1, 0)
        local slot = seq % RING
        request_data:set("rlog:" .. host .. ":" .. slot, j, D1H)
    end
end)

-- ── 5. Live-log pipe (only when a subscriber is watching) ───────────────────
-- Fire via timer to avoid blocking the log phase

if pipe_log and pipe_log.pipe_request_log
   and request_data:get("log_pipe:sub:" .. host) then
    ngx.timer.at(0, pipe_log.pipe_request_log,
                 host, ip, ts, ua, uri, req_len, bytes, rt, method, status)
end
