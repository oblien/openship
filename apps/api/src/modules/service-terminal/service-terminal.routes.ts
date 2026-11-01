import { Hono } from "hono";
import { secureRouter } from "../../lib/secure-router";
import {
  issueTicket,
  serviceTerminalWsHandler,
} from "./service-terminal.controller";

/**
 * Service-level interactive terminal routes.
 *
 * Unlike the server-terminal routes, this is NOT `localOnly` —
 * service terminals work on BOTH self-hosted (Docker exec into the
 * service's container) AND openship cloud (Oblien workspace terminal).
 * The adapter selection happens inside the controller via
 * resolveDeploymentRuntime(), driven by the deployment's meta.
 *
 *   POST /api/services/terminal/ticket       one-shot WS auth ticket
 *   GET  /api/services/terminal/ws/:serviceId WebSocket upgrade
 *
 * The WS endpoint deliberately does NOT apply authMiddleware: a normal
 * middleware that returns 401 would prevent the upgrade from completing.
 * Auth happens inside the upgradeWebSocket factory (ticket subprotocol
 * OR session-cookie fallback).
 */
export const serviceTerminalRoutes = new Hono();
const r = secureRouter(serviceTerminalRoutes, {
  module: "service-terminal",
  basePath: "/api/services/terminal",
});

// Ticket endpoint — normal HTTP auth + permission gate.
r.post("/ticket", { tag: "terminal:write", mcpExcluded: "Single-use browser WebSocket terminal ticket. Use the service exec tool for bounded commands over MCP." }, issueTicket);

// WS upgrade — auth happens inside upgradeWebSocket via single-use
// ticket (issued by POST /ticket under terminal:write) or session-cookie
// fallback. HTTP middleware would block the handshake, so this is
// explicitly public and documented.
r.public(
  "get",
  "/ws/:serviceId",
  {
    reason:
      "WebSocket upgrade — auth happens inside upgradeWebSocket via ticket subprotocol or session-cookie fallback (HTTP middleware blocks the handshake)",
  },
  serviceTerminalWsHandler,
);
