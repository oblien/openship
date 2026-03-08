/**
 * No-op infrastructure provider — for desktop and development.
 *
 * Desktop apps and local dev environments don't need reverse proxies
 * or SSL certificates. This provider silently accepts all calls.
 */

import type { RouteConfig, SslResult } from "../types";
import type { RoutingProvider, SslProvider } from "./types";

export class NoopInfraProvider implements RoutingProvider, SslProvider {
  async registerRoute(_route: RouteConfig): Promise<void> {
    // Desktop/dev — no reverse proxy
  }

  async removeRoute(_domain: string): Promise<void> {
    // No-op
  }

  async provisionCert(domain: string): Promise<SslResult> {
    return { domain, expiresAt: "", issuer: "none" };
  }

  async renewCert(domain: string): Promise<SslResult> {
    return { domain, expiresAt: "", issuer: "none" };
  }
}
