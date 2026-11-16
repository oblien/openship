require("openship.response_headers").private()
-- A server default may be configured independently of this protected route.
local ok, pages = pcall(require, "openship.edge_pages")
if ok then pages.headers() end
