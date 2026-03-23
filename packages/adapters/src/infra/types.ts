/**
 * Infrastructure provider interfaces — routing and SSL.
 *
 * Routing and SSL are separate from the runtime because:
 *   - Docker is a runtime, not a reverse proxy. Nginx handles routing.
 *   - SSL is managed by certbot/ACME, not by Docker.
 *   - Cloud routing uses a completely different mechanism (API calls).
 *   - Desktop/dev doesn't need routing or SSL at all.
 *
 * Implementations:
 *   - NginxProvider    → Nginx server blocks + certbot (self-hosted)
 *   - CloudInfra       → Oblien API (cloud)
 *   - NoopInfra        → No-op (desktop/dev)
 */

import type { RouteConfig, SslResult } from "../types";

// ─── Routing ─────────────────────────────────────────────────────────────────

export interface RoutingProvider {
  /** Register a reverse-proxy route (domain → container/process) */
  registerRoute(route: RouteConfig): Promise<void>;

  /** Remove a reverse-proxy route */
  removeRoute(domain: string): Promise<void>;
}

// ─── SSL ─────────────────────────────────────────────────────────────────────

export interface SslProvider {
  /** Provision a new TLS certificate for a domain */
  provisionCert(domain: string): Promise<SslResult>;

  /** Renew an existing TLS certificate */
  renewCert(domain: string): Promise<SslResult>;
}
