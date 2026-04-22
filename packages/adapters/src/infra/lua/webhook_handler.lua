-- webhook_handler.lua
-- Handles incoming webhook events forwarded from the SaaS edge.
-- Internal management port only (127.0.0.1:9145).
--
-- Routes:
--   POST /_hooks/push          — receive a forwarded GitHub push event
--   GET  /_hooks/pending       — fetch stored events (for local app polling)
--   POST /_hooks/ack           — acknowledge consumed events
--
-- Behavior on POST /_hooks/push:
--   1. Try to proxy to a local Openship API (configurable via X-Openship-Url header)
--   2. If Openship is not reachable, store the event in shared dict for later polling

local cjson = require "cjson.safe"

local webhook_events = ngx.shared.webhook_events
local uri            = ngx.var.uri
local method         = ngx.req.get_method()

local function json_response(data, code)
    ngx.status = code or 200
    ngx.header["Content-Type"] = "application/json"
    ngx.say(cjson.encode(data))
    return ngx.exit(ngx.status)
end

-- ── POST /_hooks/push ────────────────────────────────────────────────────────
-- Receives forwarded webhook payload from SaaS.
-- Headers:
--   X-Openship-Url: http://127.0.0.1:3456 (if Openship runs on this server)
--   X-Hook-Id: the subscription hookId (for correlation)

if uri == "/_hooks/push" and method == "POST" then
    ngx.req.read_body()
    local body = ngx.req.get_body_data()
    if not body then
        return json_response({ error = "empty body" }, 400)
    end

    local openship_url = ngx.req.get_headers()["x-openship-url"]

    -- If Openship runs on this server, proxy directly
    if openship_url and openship_url ~= "" then
        local http = require "resty.http"
        local httpc = http.new()
        httpc:set_timeout(5000)

        local target = openship_url .. "/api/webhooks/push"
        local res, err = httpc:request_uri(target, {
            method  = "POST",
            body    = body,
            headers = {
                ["Content-Type"] = "application/json",
                ["X-Hook-Id"]    = ngx.req.get_headers()["x-hook-id"] or "",
            },
        })

        if res and res.status < 500 then
            -- Openship handled it (2xx or 4xx)
            return json_response({ ok = true, proxied = true, status = res.status })
        end

        -- Openship unreachable or errored — fall through to store
    end

    -- Store for later polling by local/desktop app
    local event_id = ngx.now() .. ":" .. math.random(100000, 999999)
    local event = cjson.encode({
        id       = event_id,
        hook_id  = ngx.req.get_headers()["x-hook-id"] or "",
        payload  = body,
        received = ngx.now(),
    })

    -- Use a slot-based ring buffer (max 200 events)
    local max_events = 200
    local idx = webhook_events:incr("_idx", 1, 0) or 0
    local slot = (idx % max_events)
    webhook_events:set("evt:" .. slot, event, 3600) -- 1h TTL
    webhook_events:set("_count", math.min(idx, max_events))

    return json_response({ ok = true, stored = true, event_id = event_id })
end

-- ── GET /_hooks/pending ──────────────────────────────────────────────────────
-- Returns stored webhook events for local app to consume.

if uri == "/_hooks/pending" and method == "GET" then
    if not webhook_events then
        return json_response({ events = {} })
    end

    local count = webhook_events:get("_count") or 0
    local idx   = webhook_events:get("_idx") or 0
    local events = {}

    -- Read all stored events (newest first)
    local max_events = 200
    local start = math.max(0, idx - count)
    for i = start, idx - 1 do
        local slot = i % max_events
        local raw = webhook_events:get("evt:" .. slot)
        if raw then
            local parsed = cjson.decode(raw)
            if parsed then
                events[#events + 1] = parsed
            end
        end
    end

    return json_response({ events = events })
end

-- ── POST /_hooks/ack ─────────────────────────────────────────────────────────
-- Acknowledge events have been consumed — clears the store.

if uri == "/_hooks/ack" and method == "POST" then
    if webhook_events then
        webhook_events:flush_all()
        webhook_events:flush_expired()
    end
    return json_response({ ok = true })
end

-- ── Fallback ─────────────────────────────────────────────────────────────────
return json_response({ error = "not found" }, 404)
