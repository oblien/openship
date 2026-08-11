import { api } from "./client";
import { endpoints } from "./endpoints";

export interface DnsProviderDescriptor {
  name: "cloudflare";
  displayName: string;
  description: string;
  /** The exact token scopes to grant, shown on the connect form. */
  requiredScopes: string[];
  /** Where to mint the token. */
  tokenUrl?: string;
}

export interface SanitizedDnsCredential {
  id: string;
  organizationId: string;
  provider: string;
  name: string;
  /** "active" | "invalid" — "invalid" means the provider rejected the token. */
  status: string;
  /** Always the constant mask. No endpoint returns the token or a prefix of it. */
  tokenMasked: string;
  lastVerifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AddDnsCredentialInput {
  provider: "cloudflare";
  name: string;
  apiToken: string;
}

/**
 * Four outcomes, not two. "We asked and nobody hosts this zone" and "we could
 * not ask" need different words — telling an operator their domain isn't managed
 * because Cloudflare rate-limited us sends them to fix a token that is fine.
 */
export interface VerifyZoneResult {
  matched: boolean;
  status: "matched" | "none" | "unauthorized" | "unavailable";
  provider?: string;
  credentialId?: string;
  zoneName?: string;
  zoneId?: string;
  message?: string;
}

export const dnsApi = {
  /** List supported DNS providers and the token scopes they need. */
  listProviders: () => api.get<{ data: DnsProviderDescriptor[] }>(endpoints.dns.providers),

  /** List connected DNS credentials for the active organization. */
  listCredentials: () => api.get<{ data: SanitizedDnsCredential[] }>(endpoints.dns.credentials),

  /** Get a single connected DNS credential. */
  getCredential: (id: string) =>
    api.get<{ data: SanitizedDnsCredential }>(endpoints.dns.credentialById(id)),

  /** Connect a credential. The token is verified against the provider first. */
  addCredential: (input: AddDnsCredentialInput) =>
    api.post<{ data: SanitizedDnsCredential }>(endpoints.dns.credentials, input),

  /** Disconnect a credential. Records already written are left in place. */
  removeCredential: (id: string) => api.delete(endpoints.dns.credentialById(id)),

  /** Check whether a connected provider manages a hostname's zone. */
  verifyZone: (hostname: string) =>
    api.post<VerifyZoneResult>(endpoints.dns.verifyZone, { hostname }),
};
