local M = {}
function M.private()
    ngx.header["Cache-Control"] = "private, no-store"
    ngx.header["CDN-Cache-Control"] = "no-store"
    ngx.header["Cloudflare-CDN-Cache-Control"] = "no-store"
    ngx.header["Surrogate-Control"] = "no-store"
    ngx.header["Expires"] = nil
    ngx.header["ETag"] = nil
    ngx.header["Last-Modified"] = nil
end

return M
