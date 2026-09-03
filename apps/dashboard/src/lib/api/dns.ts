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

/**
 * What auto-configure would do to one record, decided before anything is
 * written. Mirrors the API's `RecordPlanAction`.
 *
 *   create   → nothing answers this name+type yet.
 *   update   → an Openship-managed record exists; apply rewrites it in place.
 *   adopt    → one existing record we did NOT create; apply repoints it.
 *   in-sync  → a record already answers with the value apply would write.
 *   conflict → several records answer and none is ours; apply refuses to touch it.
 */
export type RecordPlanAction = "create" | "update" | "adopt" | "in-sync" | "conflict";

export interface DnsRecordPlan {
  name: string;
  type: string;
  action: RecordPlanAction;
  /** The value apply would write. */
  desired: string;
  /** The value of the record apply would touch, when one already exists. */
  current?: string;
}

/**
 * Read-only preview of what apply would do — the on-demand button's input.
 * `status` is the resolver discriminant: only `matched` carries a per-record
 * plan; every other status means we can't (or don't) manage the zone.
 */
export interface DnsPlanResult {
  status: "matched" | "none" | "unauthorized" | "unavailable";
  provider?: string;
  zoneName?: string;
  /** Present for unauthorized/unavailable — safe to show an operator. */
  reason?: string;
  records: DnsRecordPlan[];
}

export interface DnsRecordOutcome {
  name: string;
  type: string;
  /** applied = created/updated/adopted; skipped = in place or no value; failed = see error. */
  outcome: "applied" | "skipped" | "failed";
  action?: RecordPlanAction;
  error?: string;
}

export interface DnsProvisionResult {
  /** True only when a provider managed the zone AND every record is in place. */
  provisioned: boolean;
  /** Present when we did not (or could not) act — safe to show an operator. */
  reason?: string;
  records: DnsRecordOutcome[];
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

  /** List available DNS zones for a connected credential. */
  listZones: (id: string) =>
    api.get<{ data: Array<{ id: string; name: string; status: string }> }>(`/api/dns/credentials/${id}/zones`),
};
