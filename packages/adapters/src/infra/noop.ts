/**
 * No-op infrastructure provider - for desktop and development.
 *
 * Desktop apps and local dev environments don't need reverse proxies
 * or SSL certificates. This provider silently accepts all calls.
 */

import type { ManualCert, RouteConfig, SslResult } from "../types";
import type { RoutingProvider, SslProvider, ProvisionCertOptions } from "./types";

export class NoopInfraProvider implements RoutingProvider, SslProvider {
  async registerRoute(_route: RouteConfig): Promise<void> {
    // Desktop/dev - no reverse proxy
  }

  async removeRoute(_domain: string, _opts?: { signal?: AbortSignal }): Promise<void> {
    // No-op
  }

  async provisionCert(domain: string, _opts?: ProvisionCertOptions): Promise<SslResult> {
    return { domain, expiresAt: "", issuer: "none", verified: false };
  }

  async renewCert(domain: string): Promise<SslResult> {
    return { domain, expiresAt: "", issuer: "none", verified: false };
  }

  async verifyCert(domain: string): Promise<SslResult> {
    return { domain, expiresAt: "", issuer: "none", verified: false };
  }

  async installCert(domain: string, _cert: ManualCert): Promise<SslResult> {
    // Desktop/dev - no reverse proxy to serve the cert from.
    return { domain, expiresAt: "", issuer: "none", verified: false };
  }
}
