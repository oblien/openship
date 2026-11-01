-- Applies to assets, redirects, errors and upstream responses alike.
-- A CDN must not cache an authenticated representation for the next visitor.
ngx.header["Cache-Control"] = "private, no-store"
ngx.header["CDN-Cache-Control"] = "no-store"
ngx.header["Cloudflare-CDN-Cache-Control"] = "no-store"
ngx.header["Surrogate-Control"] = "no-store"
ngx.header["Expires"] = nil
ngx.header["ETag"] = nil
