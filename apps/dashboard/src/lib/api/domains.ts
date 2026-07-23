import { ApiError, api } from "./client";
import { endpoints } from "./endpoints";

export interface DomainVerifyResult {
  verified: boolean;
  recordVerified?: boolean;
  /** @deprecated Compatibility alias for API versions before recordVerified. */
  cnameVerified?: boolean;
  txtVerified?: boolean;
  message?: string;
  sslStatus?: string;
}

/** One DNS record to add. `host` = zone-relative label (`@`/`app`); `name` =
 *  the always-correct FQDN (what verification resolves) — show it as the
 *  fallback when the provider rejects the relative host (multi-part TLDs). */
export interface DomainDnsRecord {
  type: "CNAME" | "A" | "TXT";
  host: string;
  name: string;
  value: string;
}

export interface DomainDnsRecords {
  mode: "cloud" | "selfhosted" | "external";
  records: DomainDnsRecord[];
}

export interface DomainSslVerifyResult {
  domain: string;
  sslStatus: string;
  expiresAt?: string | null;
  issuer?: string | null;
  verified: boolean;
}

export const domainsApi = {
  /** Get DNS records preview for a hostname (no domain creation needed). */
  previewRecords: (hostname: string) =>
    api.post<{ data: DomainDnsRecords }>(endpoints.domains.preview, { hostname }),

  /**
   * Re-run DNS verification for a domain.
   *
   * Returns the verify result on BOTH success and failure — the backend
   * returns 422 with the same shape when verification fails so the UI
   * can surface recordVerified/txtVerified/message inline without a
   * second request. Any error other than 422 (network, 4xx, 5xx) is
   * re-thrown so callers can show a generic failure toast.
   */
  verify: async (domainId: string): Promise<DomainVerifyResult> => {
    try {
      return await api.post<DomainVerifyResult>(endpoints.domains.verify(domainId));
    } catch (err) {
      if (err instanceof ApiError && err.status === 422 && err.body && typeof err.body === "object") {
        return err.body as DomainVerifyResult;
      }
      throw err;
    }
  },

  /** Fetch the DNS records for an EXISTING (e.g. pending) domain so the user can
   *  re-see exactly what to add at any time — not only right after connect. */
  records: (domainId: string) =>
    api.get<{ data: DomainDnsRecords }>(endpoints.domains.records(domainId)),

  /**
   * Recheck SSL: read-only verification that the Let's Encrypt cert is actually
   * issued + valid on the serving host. No certbot / rate-limit cost. Recovers a
   * domain stuck in "provisioning" once its cert is in place.
   */
  verifySsl: (domainId: string) =>
    api.post<{ data: DomainSslVerifyResult }>(endpoints.domains.verifySsl(domainId)),

  /**
   * Install an operator-supplied certificate (bring-your-own / Cloudflare
   * Origin CA). Serves TLS from the uploaded cert and disables certbot for this
   * domain — the way to get origin TLS behind an external edge (Full-strict).
   */
  uploadCertificate: (domainId: string, body: { certPem: string; keyPem: string }) =>
    api.post<{ data: DomainSslVerifyResult }>(endpoints.domains.certificate(domainId), body),

  /** Make this domain the project's primary (canonical) hostname. Unsets any
   *  prior primary; exactly one row stays primary per project. */
  setPrimary: (domainId: string) =>
    api.post<{ data: { id: string; hostname: string; isPrimary: boolean } }>(
      endpoints.domains.primary(domainId),
    ),
};
