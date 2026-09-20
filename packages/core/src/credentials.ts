/**
 * The catalogue of third-party credentials Openship can hold, and the rules that make
 * ONE table and ONE settings screen serve all of them.
 *
 * Openship needs other people's secrets for several unrelated jobs — write a DNS record,
 * pull a private image, push a backup — and each one grew its own storage, its own
 * verify flow and its own form. `dns_credential` holds a single token column; a backup
 * destination inlines FIVE encrypted columns; a notification channel keeps its own. Same
 * `enc1:` envelope in each, three shapes, three UIs, and no way to reuse one S3 key for
 * two features.
 *
 * WHAT IS UNIFIED, AND WHAT DELIBERATELY IS NOT. The unit here is the CREDENTIAL, not
 * the thing that uses it. A backup destination is a place (bucket, path, retention); a
 * DNS zone is a zone; a notification channel is a route. Each keeps its own row and
 * REFERENCES a credential. Folding those into this table would drown their real config
 * — and the reuse ("one Cloudflare token, every zone") is the actual win, not the
 * smaller number of screens.
 *
 * ALSO NOT HERE: `personal_access_token`. Those are INBOUND — somebody authenticating to
 * Openship — with different scoping and revocation. Same word "token", opposite
 * direction; one screen for both would be the confusing kind of tidy.
 *
 * HOW A PROVIDER IS ADDED: an entry below. The field list drives the storage split
 * (`type: "secret"` → the encrypted envelope, everything else → readable columns), the
 * form the dashboard renders, and the validation both sides run — so a new provider
 * cannot arrive with a form that disagrees with what the server stores. `as const
 * satisfies` makes a malformed entry a COMPILE error rather than a runtime surprise on
 * the settings page.
 */

import { normalizeRegistryHost } from "./image-ref";

/** What a credential is FOR. Consumers ask by capability, never by provider id. */
export type CredentialCapability = "image-pull" | "dns";

export type CredentialFieldType = "text" | "secret" | "select";

export interface CredentialField {
  /** Key inside `publicFields` (text/select) or the encrypted envelope (secret). */
  readonly key: string;
  readonly label: string;
  readonly type: CredentialFieldType;
  readonly required?: boolean;
  readonly placeholder?: string;
  /** One line under the input. Keep it about what to paste, not marketing. */
  readonly help?: string;
  /** `select` only. */
  readonly options?: readonly { readonly value: string; readonly label: string }[];
}

/**
 * The resource a credential applies to, when one credential per provider is not enough.
 *
 * A registry login is meaningless without knowing WHICH registry, so `docker-registry`
 * has one. A Cloudflare API token is org-wide and addresses every zone it can see, so
 * `cloudflare` has none — and `selector` stays null there rather than being filled with
 * a placeholder nobody reads.
 */
export interface CredentialSelector {
  readonly label: string;
  readonly placeholder?: string;
  readonly help?: string;
  /** True when a credential of this provider cannot be saved without one. */
  readonly required: boolean;
}

export interface CredentialProvider {
  readonly id: string;
  readonly label: string;
  readonly capability: CredentialCapability;
  /**
   * Devicon SLUG for the brand logo — not a URL.
   *
   * A slug because core must stay free of both a CDN literal per provider and any icon
   * component: the dashboard builds the URL from the same devicon base `STACK_ICONS` uses
   * and falls back to a generic key glyph when the image does not load, so a provider
   * whose logo devicon lacks still renders.
   */
  readonly icon: string;
  readonly selector: CredentialSelector | null;
  readonly fields: readonly CredentialField[];
  /** One sentence in the picker: what holding this lets Openship do. */
  readonly summary: string;
}

/**
 * Every provider. Adding one is an entry here plus a verify function on the server.
 *
 * `satisfies` (not `:`) keeps the literal types, so `CREDENTIAL_PROVIDERS[n].id` stays a
 * union of the real ids instead of widening to `string` — a typo in a consumer is then a
 * compile error too.
 */
export const CREDENTIAL_PROVIDERS = [
  {
    id: "docker-registry",
    label: "Container registry",
    capability: "image-pull",
    icon: "docker",
    summary: "Pull private images from a registry during deploys.",
    selector: {
      label: "Registry host",
      placeholder: "ghcr.io",
      help: "The host as it appears in your image reference — ghcr.io, registry.example.com:5000, or docker.io for Docker Hub.",
      required: true,
    },
    fields: [
      {
        key: "username",
        label: "Username",
        type: "text",
        required: true,
        placeholder: "your-user",
      },
      {
        key: "secret",
        label: "Password or access token",
        type: "secret",
        required: true,
        help: "Prefer a token scoped to read-only registry access over an account password.",
      },
    ],
  },
  {
    id: "cloudflare",
    label: "Cloudflare",
    capability: "dns",
    icon: "cloudflare",
    summary: "Let Openship write the DNS records a custom domain needs, instead of printing them to paste.",
    // Org-wide: the token addresses every zone it can see, so there is nothing to scope
    // it to. See CredentialSelector.
    selector: null,
    fields: [
      {
        key: "apiToken",
        label: "API token",
        type: "secret",
        required: true,
        help: "A token with Zone:Read and DNS:Edit on the zones you want Openship to manage.",
      },
    ],
  },
] as const satisfies readonly CredentialProvider[];

export type CredentialProviderId = (typeof CREDENTIAL_PROVIDERS)[number]["id"];

/** The provider, or undefined for an id this build does not know. */
export function getCredentialProvider(id: string): CredentialProvider | undefined {
  return CREDENTIAL_PROVIDERS.find((p) => p.id === id);
}

/** Providers that can serve a capability — how a consumer asks, never by id. */
export function credentialProvidersFor(
  capability: CredentialCapability,
): readonly CredentialProvider[] {
  return CREDENTIAL_PROVIDERS.filter((p) => p.capability === capability);
}

/**
 * What the API returns in place of a secret.
 *
 * A CONSTANT, never a prefix or a length hint of the real value: a mask that varies with
 * the secret leaks part of it, and a UI that shows `sk-live-…` has published the useful
 * half of the key.
 */
export const CREDENTIAL_MASK = "••••••••";

/**
 * Split submitted values into what is stored readable and what is encrypted.
 *
 * ONE place decides that split, from the field declarations, so the storage layer never
 * has to know a provider's field names. Unknown keys are dropped rather than passed
 * through — otherwise a client could park arbitrary data (or a second copy of a secret)
 * in the readable column.
 */
export function splitCredentialValues(
  provider: CredentialProvider,
  values: Record<string, string | undefined>,
): { publicFields: Record<string, string>; secrets: Record<string, string> } {
  const publicFields: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  for (const field of provider.fields) {
    const raw = values[field.key];
    if (raw == null || raw === "") continue;
    if (field.type === "secret") secrets[field.key] = raw;
    else publicFields[field.key] = raw.trim();
  }
  return { publicFields, secrets };
}

/**
 * Field-level validation, run on the server and reusable by the form.
 *
 * On UPDATE a secret may legitimately be absent — "leave blank to keep" — so
 * `existingSecretKeys` names the secrets already stored, and a required secret is only
 * missing when it is neither submitted nor already held.
 */
export function validateCredentialValues(
  provider: CredentialProvider,
  values: Record<string, string | undefined>,
  opts?: { existingSecretKeys?: readonly string[] },
): string[] {
  const held = new Set(opts?.existingSecretKeys ?? []);
  const errors: string[] = [];
  for (const field of provider.fields) {
    if (!field.required) continue;
    const submitted = values[field.key];
    if (submitted != null && submitted !== "") continue;
    if (field.type === "secret" && held.has(field.key)) continue; // kept as-is
    errors.push(`${field.label} is required`);
  }
  for (const field of provider.fields) {
    if (field.type !== "select") continue;
    const submitted = values[field.key];
    if (!submitted) continue;
    if (!field.options?.some((o) => o.value === submitted)) {
      errors.push(`${field.label} is not a valid choice`);
    }
  }
  return errors;
}

/**
 * The stored form of a selector, or null when the provider has none.
 *
 * Normalizing HERE is what makes a credential findable: `docker-registry` selectors go
 * through {@link normalizeRegistryHost}, the same function a pull uses to derive the
 * registry from an image reference, so `https://GHCR.IO/` typed in the form matches
 * `ghcr.io/org/img` at deploy time. A provider without a selector always stores null —
 * never `""`, which would make the unique index treat two org-wide tokens as distinct.
 */
export function normalizeCredentialSelector(
  provider: CredentialProvider,
  raw: string | null | undefined,
): string | null {
  if (!provider.selector) return null;
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  return provider.id === "docker-registry" ? normalizeRegistryHost(trimmed) : trimmed.toLowerCase();
}
