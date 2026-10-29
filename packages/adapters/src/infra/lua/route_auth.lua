-- Shared-password route gate. Policy is embedded in the validated vhost, not an
-- evictable shared dictionary. A full restart therefore cannot make it public.
local json = require "cjson.safe"
local crypto = require "openship.route_auth_crypto"
local cache = require("resty.lrucache").new(1024)
local M = {}
local endpoint = "/_openship/access"
local cookie_name = "__Host-openship_route"

local function policy()
    local raw = ngx.var.openship_route_auth
    if not raw or #raw > 2048 then return nil end
    local p = cache:get(raw)
    if p then return p end
    p = json.decode(ngx.decode_base64(raw) or "")
    if type(p) ~= "table" or type(p.version) ~= "string" or #p.version ~= 32
        or p.version:find("[^0-9a-f]") or p.iterations ~= 600000
        or type(p.sessionSeconds) ~= "number" or p.sessionSeconds % 1 ~= 0
        or p.sessionSeconds < 300 or p.sessionSeconds > 604800 then return nil end
    for _, key in ipairs({ "salt", "verifier", "signingKey" }) do
        if type(p[key]) ~= "string" or #p[key] ~= 64 or p[key]:find("[^0-9a-f]") then return nil end
    end
    p.key = crypto.unhex(p.signingKey)
    cache:set(raw, p)
    return p
end

local function fail(status, message)
    ngx.status = status
    ngx.header["Content-Type"] = "text/plain; charset=utf-8"
    ngx.say(message)
    return ngx.exit(status)
end

local function signature(p, purpose, value)
    return crypto.sign(p.key, "openship-route-v1\n" .. purpose .. "\n" .. ngx.var.host .. "\n" .. p.version .. "\n" .. value)
end

local function safe_path(path)
    return type(path) == "string" and #path <= 2048 and path:sub(1, 1) == "/"
        and path:sub(2, 2) ~= "/" and not path:find("[\\%z\1-\32\127]")
        and path:sub(1, #endpoint) ~= endpoint
end

local function token(p, purpose, value)
    return value .. "." .. signature(p, purpose, value)
end

local function valid_token(p, purpose, value, extra, max_age)
    if type(value) ~= "string" or #value > 100 then return false end
    local expires, mac = value:match("^(%d+)%.([a-f0-9]+)$")
    if not expires or #expires ~= 10 or #mac ~= 64 then return false end
    local expiry = tonumber(expires)
    local now = ngx.time()
    return expiry > now and expiry <= now + max_age
        and crypto.equal(mac, signature(p, purpose, expires .. (extra or "")))
end

local function escape(s)
    return (s:gsub("&", "&amp;"):gsub("<", "&lt;"):gsub(">", "&gt;"):gsub('"', "&quot;"):gsub("'", "&#39;"))
end

local function form(p, path, error_message)
    if not safe_path(path) then path = "/" end
    local expires = tostring(ngx.time() + 600)
    local csrf = expires .. "." .. signature(p, "form", expires .. "\n" .. path)
    ngx.status = 401
    ngx.header["Content-Type"] = "text/html; charset=utf-8"
    ngx.header["X-Frame-Options"] = "DENY"
    ngx.header["X-Content-Type-Options"] = "nosniff"
    -- Preserve Origin on same-origin form POSTs; external referrers stay hidden.
    ngx.header["Referrer-Policy"] = "same-origin"
    ngx.header["Content-Security-Policy"] = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
    ngx.print([[<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Private site</title><style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#111;color:#eee;font:16px system-ui,sans-serif}
main{width:min(420px,calc(100% - 40px));padding:32px;border-radius:24px;background:#1d1d1d}svg{width:28px;height:28px}
h1{font-size:24px;margin:20px 0 8px}p{color:#aaa;line-height:1.5}label{display:block;margin:24px 0 8px}
input,button{width:100%;font:inherit;padding:14px 16px;border-radius:12px}input{background:#111;border:1px solid #444;color:#fff}
input:focus{outline:2px solid #c9ee89;outline-offset:2px}button{margin-top:16px;background:#d0f38a;color:#111;border:0;font-weight:600;cursor:pointer}
.error{color:#ffb4a9}small{display:block;color:#999;margin-top:20px}
</style><main><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/></svg>
<h1>This site is private</h1><p>Enter the password shared by the site owner.</p>]])
    if error_message then ngx.print('<p class="error" role="alert">', escape(error_message), '</p>') end
    ngx.print('<form method="post" action="', endpoint, '"><input type="hidden" name="return" value="', escape(path),
        '"><input type="hidden" name="csrf" value="', csrf,
        '"><label for="password">Site password</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="256" autofocus>',
        '<button type="submit">Continue</button></form><small>Protected by Openship</small></main></html>')
    return ngx.exit(401)
end

local function secure_policy()
    -- Do not trust client-controlled X-Forwarded-Proto. V1 requires TLS at this
    -- edge; a visitor cannot submit a password to the plaintext origin listener.
    if ngx.var.scheme ~= "https" then
        return nil, fail(403, "This private site requires HTTPS.")
    end
    local p = policy()
    if not p then return nil, fail(503, "Site protection is temporarily unavailable.") end
    return p
end

function M.guard()
    -- Verification tokens do not serve project content. Login has its own exact
    -- location. No prefix exemption for hooks, static assets, APIs or WebSockets.
    local path = ngx.var.uri
    if path == endpoint
        or path:match("^/%.well%-known/acme%-challenge/[A-Za-z0-9_-]+$")
        or path:match("^/%.well%-known/oblien%-proxy%-challenge/[A-Za-z0-9_-]+$") then return end
    local p = secure_policy()
    if not p then return end
    -- Internal redirects cannot reset the decision or pass our cookie upstream.
    if ngx.var.openship_route_authorized == p.version then return end
    local found, duplicate
    local keep = {}
    for part in (ngx.var.http_cookie or ""):gmatch("[^;]+") do
        local key, value = part:match("^%s*([^= ]+)=([^;]*)$")
        if key == cookie_name then
            if found then duplicate = true end
            found = value
        else
            keep[#keep + 1] = part
        end
    end
    if not duplicate and valid_token(p, "session", found, nil, p.sessionSeconds) then
        ngx.var.openship_route_authorized = p.version
        if #keep == 0 then ngx.req.clear_header("Cookie")
        else ngx.req.set_header("Cookie", table.concat(keep, ";")) end
        return
    end
    local method = ngx.req.get_method()
    local accept = ngx.var.http_accept or ""
    if (method == "GET" or method == "HEAD") and accept:find("text/html", 1, true) then
        return form(p, ngx.var.request_uri)
    end
    return fail(401, "This site requires a password. Open it in a browser to sign in.")
end

local function count(dict, key, limit)
    local ok, err = dict:safe_add(key, 0, 60)
    if not ok and err ~= "exists" then return false end
    local value = dict:incr(key, 1)
    return value and value <= limit
end

function M.login()
    local p = secure_policy()
    if not p then return end
    if ngx.req.get_method() ~= "POST" then return form(p, "/") end
    if ngx.var.http_origin ~= "https://" .. ngx.var.host
        and ngx.var.http_origin ~= "https://" .. ngx.var.host .. ":" .. ngx.var.server_port then
        return fail(403, "Open this site directly before signing in.")
    end
    if not (ngx.var.content_type or ""):match("^application/x%-www%-form%-urlencoded") then
        return fail(415, "Use the sign-in form.")
    end
    ngx.req.read_body()
    local body = ngx.req.get_body_data()
    if not body or #body > 4096 then return fail(400, "Invalid sign-in request.") end
    local args, err = ngx.req.get_post_args(4)
    if err or type(args.password) ~= "string" or #args.password > 256 or not safe_path(args["return"])
        or not valid_token(p, "form", args.csrf, "\n" .. args["return"], 600) then
        return fail(400, "The sign-in form expired. Reload this page.")
    end
    local limits = ngx.shared.route_auth_limits
    if not limits then return fail(503, "Site protection is temporarily unavailable.") end
    local bucket = tostring(math.floor(ngx.time() / 60))
    -- safe_add never evicts another counter. Exhaustion denies sign-in.
    if not count(limits, "all:" .. bucket, 30)
        or not count(limits, "ip:" .. ngx.var.remote_addr .. ":" .. p.version .. ":" .. bucket, 5) then
        ngx.header["Retry-After"] = "60"
        return fail(429, "Too many sign-in attempts. Try again in a minute.")
    end
    -- Two expensive verifications at a time across ALL nginx workers. A short
    -- lease recovers after a worker dies. The thread pool also has a bounded queue.
    local slot
    for i = 1, 2 do
        local key = "busy:" .. i
        if limits:safe_add(key, true, 60) then slot = key; break end
    end
    if not slot then
        ngx.header["Retry-After"] = "2"
        return fail(429, "Sign-in is busy. Try again shortly.")
    end
    local ok, verified = ngx.run_worker_thread("openship_password", "openship.route_auth_crypto",
        "verify_password", args.password, p.salt, p.verifier)
    args.password = nil
    limits:delete(slot)
    if not ok then return fail(503, "Site protection is temporarily unavailable.") end
    if not verified then return form(p, args["return"], "That password is incorrect. Please try again.") end
    local expires = tostring(ngx.time() + p.sessionSeconds)
    ngx.header["Set-Cookie"] = cookie_name .. "=" .. token(p, "session", expires)
        .. "; Path=/; Max-Age=" .. p.sessionSeconds .. "; Secure; HttpOnly; SameSite=Lax"
    return ngx.redirect(args["return"], 303)
end

return M
