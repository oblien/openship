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
import type { OutputProbeResult, StaticProbeOptions } from "../system/output-exists";

// ─── Routing ─────────────────────────────────────────────────────────────────

export interface RoutingProvider {
  /** Register a reverse-proxy route (domain → container/process) */
  registerRoute(route: RouteConfig): Promise<void>;

  /** Remove a reverse-proxy route. Providers that can roll back a failed
   * removal must not recreate it after the caller has abandoned the attempt. */
  removeRoute(domain: string, opts?: { signal?: AbortSignal }): Promise<void>;

  /**
   * Re-emit vhosts an older generator wrote, so a fix to the EMITTED config shape reaches
   * a box that isn't redeploying. Converged boxes do nothing; see
   * `NginxProvider.reapplyStoredRoutes`.
   *
   * Optional: only a provider that keeps generated config on disk has anything to replay.
   * Cloud routes through Oblien's API and desktop has no edge at all.
   */
  reapplyStoredRoutes?(): Promise<{
    scanned: number;
    repaired: string[];
    failed: { slug: string; reason: string }[];
  }>;

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
   * `opts.hostname` opts into the HTTP half — one real request through the edge
   * for that host and path. Same vantage-point argument, taken one step further:
   * the filesystem check proves the bytes are reachable, an actual request proves
   * they are SERVED (readable modes, a vhost that exists, a root the container can
   * see). Omit it and the probe stays filesystem-only.
   *
   * Advisory: implementations never throw — `checked:false` means "no signal", and
   * an absent `served` likewise.
   */
  probeStaticRoot?(servedPath: string, opts?: StaticProbeOptions): Promise<OutputProbeResult>;

  /**
   * Serve edge-target challenge tokens for `host`, so Openship Cloud's shared edge
   * can prove this box controls a routing target it is asked to forward to.
   *
   * Optional for the same reason `probeStaticRoot` is: only a provider that owns an
   * HTTP surface on this box can answer, and "this provider has no
   * `serveEdgeChallenge`" is a clean, reportable reason rather than a silent no-op.
   * Cloud routes through Oblien's own edge and has nothing to serve from.
   *
   * Call with `{ host }` alone at edge-ensure to make the box ABLE to answer before
   * any challenge exists (the location serves a directory, so it is valid empty), and
   * with `{ host, tokens }` from the verify flow to serve the issued tokens.
   *
   * `tokens` is a LIST because a re-issued verification resets the token while an
   * older record may still be probed, and because two orgs can target one box. Every
   * token given is served, and none is ever removed — Oblien re-probes the same token
   * near its 90-day expiry, so dropping one silently breaks that route months later.
   */
  serveEdgeChallenge?(input: { host: string; tokens?: readonly string[] }): Promise<{
    served: boolean;
    /** How it is answered — an existing vhost for the host, or our own single-purpose one. */
    via: "existing-vhost" | "challenge-vhost" | null;
    /** Set when an unmanaged//stale vhost already claims the host; names the file. */
    claimedBy?: string;
    reason?: string;
  }>;
}

// ─── SSL ─────────────────────────────────────────────────────────────────────

export interface ProvisionCertOptions {
  onLog?: (line: string) => void;
  force?: boolean;
  challenge?: "http-01" | "dns-01";
  /** Existing hook commands already present in the Certbot execution environment. */
  dnsAuthHook?: string;
  dnsCleanupHook?: string;
  /** Hook bodies that the provider must materialize beside Certbot on its target. */
  dnsAuthHookScript?: string;
  dnsCleanupHookScript?: string;
}

export interface SslProvider {
  /** Provision a new TLS certificate for a domain. `onLog`, when given, streams
   *  certbot's output line-by-line (powers the live-log verify modal). `force`
   *  bypasses the "cert already on disk" short-circuit and passes certbot
   *  `--force-renewal`, so a present-but-stale/near-expiry cert is actually
   *  reissued instead of returned as-is. */
  provisionCert(domain: string, opts?: ProvisionCertOptions): Promise<SslResult>;

  /** Renew an existing TLS certificate */
  renewCert(domain: string, opts?: ProvisionCertOptions): Promise<SslResult>;

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
