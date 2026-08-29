-- pipe_stream.lua
-- content_by_lua: SSE endpoint for real-time request log streaming.
-- GET /logs/stream?domain=example.com
-- Internal only - 127.0.0.1:9145
--
-- Reads the SAME ring buffer site_logger.lua writes (rlog:{domain}:seq +
-- rlog:{domain}:{slot}), by a PER-CONNECTION cursor. Nothing is consumed: N
-- concurrent watchers each walk the ring independently and none steals another's
-- frames. This is what replaced the old single-subscriber log_pipe:q queue —
-- a containerized edge tails this over `docker exec curl`, and a curl that
-- outlives its client (the daemon buffers its stdout, so no EPIPE) can no longer
-- drain the queue out from under the next reader.

local sh = ngx.shared.request_data
if not sh then
    ngx.status = 503
    ngx.say("shared dict unavailable")
    return ngx.exit(503)
end

local domain = ngx.var.arg_domain
if not domain or domain == "" then
    ngx.status = 400
    ngx.say("missing ?domain= parameter")
    return ngx.exit(400)
end

domain = domain:lower()
if domain:sub(1, 4) == "www." then domain = domain:sub(5) end

-- MUST match site_logger.lua's RING — same slot arithmetic on both ends.
local RING    = 1000
local SEQ_KEY = "rlog:" .. domain .. ":seq"
local slot_key = function(seq) return "rlog:" .. domain .. ":" .. (seq % RING) end

ngx.header["Content-Type"]      = "text/event-stream"
ngx.header["Cache-Control"]     = "no-cache, no-store"
ngx.header["Connection"]        = "keep-alive"
ngx.header["X-Accel-Buffering"] = "no"

-- Send initial SSE comment so the first flush has data.
-- Without this, ngx.flush on an empty buffer sends chunked-EOF (0\r\n\r\n)
-- and terminates the response immediately.
ngx.print(": connected\n\n")
if not ngx.flush(true) then return end

-- Start at the current head: stream only requests that arrive AFTER connect.
-- History up to this point is served separately by /logs/recent, and the client
-- dedups the two by the deterministic `{host}:{seq}` id, so a row seen by both
-- collapses to one.
local cursor  = tonumber(sh:get(SEQ_KEY)) or 0
local started = ngx.now()
local last_hb = started

while true do
    -- Max 1 hour per connection.
    if ngx.now() - started > 3600 then return end

    local head = tonumber(sh:get(SEQ_KEY)) or 0

    -- If we've fallen more than a full ring behind, the oldest unread slots have
    -- already been overwritten. Jump to the oldest slot still holding its own
    -- entry (head-RING maps to head's slot, so head-RING+1 is the oldest live one)
    -- and skip the lost range — same bound the old 2000-entry queue had.
    if cursor < head - RING then cursor = head - RING end

    local sent = 0
    while cursor < head and sent < 100 do
        local next_seq = cursor + 1
        local entry = sh:get(slot_key(next_seq))
        if entry then
            ngx.print("event: request\ndata: ", entry, "\n\n")
            sent = sent + 1
            cursor = next_seq
        elseif next_seq < head then
            -- A later seq already exists, so this can't be the incr(seq)→set(slot)
            -- write window: the slot is genuinely lost (expired or wrapped). Skip it.
            cursor = next_seq
        else
            -- next_seq == head: the newest entry's slot may not be written yet
            -- (the microsecond window between incr(seq) and set(slot)). Retry it
            -- next cycle without advancing.
            break
        end
    end

    if sent > 0 then
        if not ngx.flush(true) then return end
    end

    local now = ngx.now()

    -- Heartbeat every 15s. Its flush is also how a dead client is detected: once
    -- the reader (a `docker exec curl`) goes away and its socket closes, this
    -- flush fails and the connection tears down here.
    if now - last_hb > 15 then
        ngx.print(": ping\n\n")
        if not ngx.flush(true) then return end
        last_hb = now
    end

    ngx.sleep(0.05)
end
