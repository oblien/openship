/**
 * Cloud infrastructure provider — routing + SSL via Oblien API.
 *
 * All operations are API calls to the Oblien platform. No local reverse
 * proxy or ACME configuration needed.
 */

import type { RouteConfig, SslResult } from "../types";
import type { RoutingProvider, SslProvider } from "./types";

export class CloudInfraProvider implements RoutingProvider, SslProvider {
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
  ) {}

  // ── Routing ──────────────────────────────────────────────────────────

  async registerRoute(route: RouteConfig): Promise<void> {
    // TODO: POST /routes to Oblien API
    void route;
  }

  async removeRoute(domain: string): Promise<void> {
    // TODO: DELETE /routes/:domain
    void domain;
  }

  // ── SSL ──────────────────────────────────────────────────────────────

  async provisionCert(domain: string): Promise<SslResult> {
    // TODO: POST /ssl/provision — Oblien manages certs
    return { domain, expiresAt: "", issuer: "oblien" };
  }

  async renewCert(domain: string): Promise<SslResult> {
    // TODO: POST /ssl/renew
    return { domain, expiresAt: "", issuer: "oblien" };
  }
}
