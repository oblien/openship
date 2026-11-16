-- HTML is inert response data on the edge. No file IO, subrequests, eval or shared
-- dictionary eviction: configurations are part of nginx's validated generation.
local json = require "cjson.safe"
local cache = require("resty.lrucache").new(32)
local M = {}
local server_defaults

local function decode(raw)
    if not raw or raw == "" then return nil end
    local found = cache:get(raw)
    if found then return found end
    local value = json.decode(ngx.decode_base64(raw) or "")
    if type(value) ~= "table" then return nil end
    cache:set(raw, value)
    return value
end

-- Loaded once per validated nginx generation, before workers fork. No request
-- performs filesystem IO and large HTML never enters nginx's short map tokens.
function M.set_defaults(raw)
    server_defaults = decode(raw)
end

local private_headers = require("openship.response_headers").private

local maintenance_html = [[<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Back shortly</title><style>:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#101010;color:#f5f5f5;font:16px/1.6 system-ui,sans-serif}main{max-width:460px;padding:40px}small{color:#aaa}h1{font-size:32px;letter-spacing:-.03em;margin:20px 0 12px}p{color:#aaa}svg{width:44px;height:44px}</style><main><svg viewBox="0 0 48 48" fill="none" aria-hidden="true"><rect x="5" y="8" width="38" height="30" rx="9" fill="#242424"/><path d="M15 23h18m-18 6h10" stroke="#eee" stroke-width="3" stroke-linecap="round"/><circle cx="15" cy="16" r="2" fill="#888"/></svg><h1>We’ll be back shortly.</h1><p>This site is undergoing scheduled maintenance. Please try again in a little while.</p><small>503 · Temporarily unavailable</small></main></html>]]

function M.maintenance(raw)
    local config = decode(raw)
    local m = config and config.maintenance
    if not m or not m.enabled then return end
    local path = ngx.var.uri
    if path:match("^/%.well%-known/acme%-challenge/[A-Za-z0-9_-]+$")
        or path:match("^/%.well%-known/oblien%-proxy%-challenge/[A-Za-z0-9_-]+$")
        or path == "/_openship/access" then return end
    ngx.ctx.openship_maintenance = true
    ngx.status = 503
    ngx.header["Content-Type"] = "text/html; charset=utf-8"
    ngx.header["Retry-After"] = tostring(m.retryAfter)
    ngx.header["X-Content-Type-Options"] = "nosniff"
    private_headers()
    local html = m.html or maintenance_html
    ngx.header["Content-Length"] = #html
    ngx.send_headers()
    if ngx.req.get_method() ~= "HEAD" then ngx.print(html) end
    return ngx.exit(ngx.HTTP_OK)
end

function M.headers(raw)
    -- Authentication always owns 401/403/429 and its own UI; maintenance owns
    -- its 503. An error-page binding must not disguise either state.
    if ngx.ctx.openship_maintenance or ngx.ctx.openship_auth_response
        or ngx.var.server_port == "9145" or ngx.var.uri:match("^/%.well%-known/") then return end
    local status = ngx.status
    if status < 400 then return end
    local local_pages, server = decode(raw), server_defaults
    local code = tostring(status)
    local html = local_pages and local_pages.errors and local_pages.errors[code]
    if not html and server then
        if ngx.var.server_name == "_" and status == 404 then html = server.defaultHtml end
        html = html or (server.errors and server.errors[code])
    end
    if type(html) ~= "string" then return end
    ngx.ctx.openship_error_html = html
    ngx.header["Content-Type"] = "text/html; charset=utf-8"
    ngx.header["Content-Length"] = #html
    ngx.header["Content-Encoding"] = nil
    ngx.header["Content-Range"] = nil
    ngx.header["Accept-Ranges"] = nil
    ngx.header["X-Content-Type-Options"] = "nosniff"
    -- CSP from the failed application belongs to its body, not this page.
    ngx.header["Content-Security-Policy"] = nil
    ngx.header["Content-Security-Policy-Report-Only"] = nil
    private_headers()
end

function M.body()
    local html = ngx.ctx.openship_error_html
    if not html then return end
    if ngx.ctx.openship_error_sent or ngx.req.get_method() == "HEAD" then ngx.arg[1] = nil
    else ngx.arg[1] = html; ngx.ctx.openship_error_sent = true end
    ngx.arg[2] = true
end

return M
