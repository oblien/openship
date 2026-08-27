/**
 * Cloud infrastructure provider - routing + SSL via Oblien API.
 *
 * All operations are API calls to the Oblien platform. No local reverse
 * proxy or ACME configuration needed.
 */

import { Oblien } from "oblien";
import type { ManualCert, RouteConfig, SslResult } from "../types";
import type { RoutingProvider, SslProvider, ProvisionCertOptions } from "./types";

export class CloudInfraProvider implements RoutingProvider, SslProvider {
  private readonly client: Oblien;

  constructor(client: Oblien) {
    this.client = client;
  }

  // ── Routing ──────────────────────────────────────────────────────────

  async registerRoute(route: RouteConfig): Promise<void> {
    // TODO: POST /routes to Oblien API
    void route;
  }

  async removeRoute(domain: string, _opts?: { signal?: AbortSignal }): Promise<void> {
    // TODO: DELETE /routes/:domain
    void domain;
  }

  // ── SSL ──────────────────────────────────────────────────────────────

  async provisionCert(domain: string, _opts?: ProvisionCertOptions): Promise<SslResult> {
    // TODO: POST /ssl/provision - Oblien manages certs
    return { domain, expiresAt: "", issuer: "oblien", verified: false };
  }

  async renewCert(domain: string): Promise<SslResult> {
    // TODO: POST /ssl/renew
    return { domain, expiresAt: "", issuer: "oblien", verified: false };
  }

  async verifyCert(domain: string): Promise<SslResult> {
    // TODO: GET /ssl/status - Oblien is the source of truth for managed certs.
    return { domain, expiresAt: "", issuer: "oblien", verified: false };
  }

  async installCert(_domain: string, _cert: ManualCert): Promise<SslResult> {
    // Oblien manages TLS at its own edge — no operator-supplied certs.
    throw new Error("Manual certificates are not supported on Openship Cloud");
  }
}
