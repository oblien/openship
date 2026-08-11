import { Hono } from "hono";
import { localOnly } from "../../middleware/local-only";
import { authMiddleware } from "../../middleware/auth";
import { secureRouter } from "../../lib/secure-router";
import { issueTicket, terminalWsHandler } from "./terminal.controller";
import { repos } from "@repo/db";

/**
 * Interactive terminal routes - self-hosted only (cloud mode 404s here).
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

r.use("*", localOnly);

// Ticket endpoint - normal HTTP auth.
r.post("/ticket", { tag: "terminal:write" }, issueTicket);

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

// Boot-time sweep: any audit rows left open by a prior crash are
// finalized as 'server_error'. Their underlying ssh2 channels are dead
// (process died), so the rows are accurate after this. Runs once at
// module load - no top-level await in the route file itself, so we
// chain it onto a fire-and-forget promise.
void repos.terminalSession
  .closeAllActive("server_error")
  .then((n) => {
    if (n > 0) {
      // eslint-disable-next-line no-console
      console.log(`[terminal] swept ${n} orphan session row(s) from previous run`);
    }
  })
  .catch(() => {
    // Sweep failure is non-fatal; the rows just remain open until the
    // next restart succeeds.
  });

export const terminalRoutes = r.hono;

