-- pipe_stream.lua
-- content_by_lua: SSE endpoint for real-time request log streaming.
-- GET /logs/stream?domain=example.com
-- Internal only — 127.0.0.1:9145

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

local SUB_KEY   = "log_pipe:sub:" .. domain
local QUEUE_KEY = "log_pipe:q:"   .. domain

-- Clear stale queue entries, mark subscriber active
sh:delete(QUEUE_KEY)
sh:set(SUB_KEY, true, 30)

ngx.header["Content-Type"]      = "text/event-stream"
ngx.header["Cache-Control"]     = "no-cache, no-store"
ngx.header["Connection"]        = "keep-alive"
ngx.header["X-Accel-Buffering"] = "no"

-- Send initial SSE comment so the first flush has data.
-- Without this, ngx.flush on an empty buffer sends chunked-EOF (0\r\n\r\n)
-- and terminates the response immediately.
ngx.print(": connected\n\n")
if not ngx.flush(true) then
    sh:delete(SUB_KEY)
    return
end

local started  = ngx.now()
local last_hb  = started
local last_ref = started

while true do
    -- Max 1 hour per connection
    if ngx.now() - started > 3600 then
        sh:delete(SUB_KEY)
        return
    end

    -- Drain up to 100 queued entries per cycle
    local sent = 0
    while sent < 100 do
        local entry = sh:rpop(QUEUE_KEY)
        if not entry then break end
        ngx.print("event: request\ndata: ", entry, "\n\n")
        sent = sent + 1
    end

    if sent > 0 then
        if not ngx.flush(true) then
            sh:delete(SUB_KEY)
            return
        end
    end

    local now = ngx.now()

    -- Heartbeat every 15s
    if now - last_hb > 15 then
        ngx.print(": ping\n\n")
        if not ngx.flush(true) then
            sh:delete(SUB_KEY)
            return
        end
        last_hb = now
    end

    -- Refresh subscriber TTL every 10s
    if now - last_ref > 10 then
        sh:set(SUB_KEY, true, 30)
        last_ref = now
    end

    ngx.sleep(0.05)
end
