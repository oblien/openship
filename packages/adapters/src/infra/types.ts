/**
 * Infrastructure provider interfaces - routing and SSL.
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

import type { ManualCert, RouteConfig, SslResult } from "../types";
import type { OutputProbeResult } from "../system/output-exists";

// ─── Routing ─────────────────────────────────────────────────────────────────

export interface RoutingProvider {
  /** Register a reverse-proxy route (domain → container/process) */
  registerRoute(route: RouteConfig): Promise<void>;

  /** Remove a reverse-proxy route */
  removeRoute(domain: string): Promise<void>;

  /**
   * Does a static `root` actually resolve WHERE THE PROXY LOOKS?
   *
   * Optional: only a provider that serves files from a path answers. The point is
   * the vantage point, not the check — for a containerized edge the vhost `root`
   * is a HOST path that must be bind-mounted into the container, so probing the
   * host FS reports the files present while nginx sees an empty directory and
   * 404s. Only the provider knows which executor sees what nginx sees, so the
   * probe belongs here rather than in a caller guessing at edge topology.
   *
   * Advisory: implementations never throw — `checked:false` means "no signal".
   */
  probeStaticRoot?(servedPath: string): Promise<OutputProbeResult>;
}

// ─── SSL ─────────────────────────────────────────────────────────────────────

export interface SslProvider {
  /** Provision a new TLS certificate for a domain. `onLog`, when given, streams
   *  certbot's output line-by-line (powers the live-log verify modal). `force`
   *  bypasses the "cert already on disk" short-circuit and passes certbot
   *  `--force-renewal`, so a present-but-stale/near-expiry cert is actually
   *  reissued instead of returned as-is. */
  provisionCert(
    domain: string,
    opts?: { onLog?: (line: string) => void; force?: boolean },
  ): Promise<SslResult>;

  /** Renew an existing TLS certificate */
  renewCert(domain: string): Promise<SslResult>;

  /**
   * Install an operator-supplied certificate (bring-your-own / Cloudflare
   * Origin CA) for a domain — no ACME. Writes the cert + key to the same
   * on-disk location certbot would use, then re-registers the vhost with TLS.
   * Powers origin TLS behind an upstream proxy (Cloudflare Full-strict) and
   * plain BYO certs on direct domains.
   */
  installCert(domain: string, cert: ManualCert): Promise<SslResult>;

  /**
   * Read-only verification: report whether a valid cert is currently present
   * for the domain (and its expiry/issuer) WITHOUT running certbot. Powers the
   * "Recheck SSL" action and lets a redeploy confirm an existing cert instead
   * of mistaking a transient read failure for "no cert".
   */
  verifyCert(domain: string): Promise<SslResult>;
}
