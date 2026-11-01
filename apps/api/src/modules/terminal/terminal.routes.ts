import { Hono } from "hono";
import { secureRouter } from "../../lib/secure-router";
import { issueTicket, terminalWsHandler } from "./terminal.controller";

/**
 * Interactive server terminals over the shared authorized connection boundary.
 *
 *   POST /api/terminal/ticket           one-shot WS auth ticket (cookie-authed)
 *   GET  /api/terminal/ws/:serverId    WebSocket upgrade
 *
 * The WS route deliberately does NOT apply the HTTP authMiddleware: a
 * normal middleware that returns 401 would prevent the upgrade from
 * completing. Auth happens inside upgradeWebSocket's factory (ticket OR
 * session-cookie fallback) so we can send a structured error frame
 * before the close, instead of a bare HTTP 401.
 */
const r = secureRouter(new Hono(), {
  module: "terminal",
  basePath: "/api/terminal",
});

// Ticket endpoint - normal HTTP auth.
r.post("/ticket", { tag: "terminal:write", mcpExcluded: "Single-use browser WebSocket terminal ticket. Use the exec tool for bounded commands over MCP." }, issueTicket);

// WebSocket upgrade - auth is inside the upgrade factory (ticket via
// Sec-WebSocket-Protocol, with session-cookie fallback). A normal HTTP
// authMiddleware would 401 before the upgrade completes, so the route
// is intentionally public at the router level.
r.public(
  "get",
  "/ws/:serverId",
  {
    reason:
      "WebSocket upgrade - auth happens inside upgradeWebSocket factory via single-use ticket (issued by POST /ticket under terminal:write) or session-cookie fallback; HTTP middleware would block the upgrade handshake",
  },
  terminalWsHandler,
);

export const terminalRoutes = r.hono;
