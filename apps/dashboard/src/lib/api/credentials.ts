import { api } from "./client";
import { endpoints } from "./endpoints";
import type { CredentialProvider } from "@repo/core";

/**
 * Third-party credentials — registry logins, DNS tokens, and whatever comes next.
 *
 * The provider catalogue is fetched, not duplicated here: `CREDENTIAL_PROVIDERS` in
 * @repo/core is the single declaration of every provider's fields, and the server filters
 * it to the ones it can actually verify. A hardcoded copy in the client is how a form ends
 * up asking for a field the server does not store.
 */

export interface Credential {
  id: string;
  provider: string;
  providerLabel: string;
  name: string;
  /** What it applies to — a registry host; null for an org-wide provider. */
  selector: string | null;
  /** Non-secret values (username, region). Safe to render. */
  publicFields: Record<string, string>;
  /** Secret field key → a CONSTANT mask. Tells the form which inputs exist, nothing more. */
  secretsMasked: Record<string, string>;
  /** "active" | "invalid" */
  status: string;
  lastVerifiedAt: string | null;
  /** Redacted reason the last verify failed — shown when status is "invalid". */
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export const credentialsApi = {
  /** The providers this instance can store and verify, with their field schema. */
  providers: () =>
    api.get<{ data: CredentialProvider[] }>(endpoints.credentials.providers),

  list: () => api.get<{ data: Credential[] }>(endpoints.credentials.list),

  create: (input: {
    provider: string;
    name: string;
    selector?: string | null;
    values: Record<string, string>;
  }) => api.post<{ data: Credential }>(endpoints.credentials.list, input),

  /**
   * Rename, re-scope, or rotate.
   *
   * OMIT a secret from `values` to keep the stored one — the server treats an absent
   * secret as "unchanged". Sending `""` would be a different request, so the form must
   * drop blank secret fields rather than pass them through.
   */
  update: (
    id: string,
    input: { name?: string; selector?: string | null; values?: Record<string, string> },
  ) => api.patch<{ data: Credential }>(endpoints.credentials.byId(id), input),

  remove: (id: string) => api.delete<{ success: boolean }>(endpoints.credentials.byId(id)),

  /** Re-check with the provider and record the verdict (so "invalid" becomes visible). */
  verify: (id: string) => api.post<{ data: Credential }>(endpoints.credentials.verify(id), {}),
};
