/**
 * THE list of social/OAuth login providers this instance actually has
 * credentials for — and the single place the condition "is <provider>
 * configured?" is written.
 *
 * Why this exists: a provider is registered with Better Auth only when its
 * client id AND secret are both present (`socialProviders` in lib/auth.ts), but
 * nothing told the dashboard which ones made it in. So the dashboard guessed —
 * `{!selfHosted && <OAuthButtons/>}` — and the guess was wrong in both
 * directions: a self-hosted operator who HAD set GITHUB_CLIENT_ID/SECRET got no
 * button at all, and any cloud deploy missing a pair would have rendered a
 * button that dead-ends at Better Auth's "provider not found".
 *
 * The rule is written once, here, and read by two callers:
 *   - lib/auth.ts        → whether to register the provider (needs the creds)
 *   - GET /health/env    → whether to ADVERTISE it (never the creds)
 * Keeping the predicate in one place is the same discipline as lib/auth-mode.ts:
 * a second copy of a security-shaped condition drifts, and the drift is only
 * visible as a login screen that disagrees with what the API enforces.
 *
 * SECRET DISCIPLINE: `configuredAuthProviders()` is served UNAUTHENTICATED. It
 * returns provider IDs and nothing else — never a client id, never a secret, not
 * even a redacted one. `socialProviderCredentials()` is the only export that
 * touches credential values, it is server-internal, and its return value must
 * never reach a response body.
 */

import { env } from "../config/env";

/** Every social provider the server knows how to register. */
export const SOCIAL_AUTH_PROVIDERS = ["github", "google"] as const;
export type SocialAuthProviderId = (typeof SOCIAL_AUTH_PROVIDERS)[number];

/**
 * One advertised provider. Deliberately a RECORD, not a bare string: this is the
 * public shape and it has to grow without breaking older dashboards.
 *
 * `kind` is the discriminator that growth will need. Today the only value is
 * "social" (an env-configured OAuth provider whose button the dashboard already
 * knows how to draw). A later SSO/OIDC provider is a different thing to render —
 * one operator-named issuer rather than a branded button — and gets its own
 * kind then. Nothing here implements SSO; the field only means a client can
 * filter on it instead of assuming every entry is a github-shaped button.
 *
 * (The git-provider capability record the GitLab work needs is a SEPARATE
 * surface — these are login providers. See TODO.md "Git providers".)
 */
export interface AdvertisedAuthProvider {
  id: SocialAuthProviderId;
  kind: "social";
}

/**
 * The credential pair for a provider, or null when the operator hasn't
 * configured it. Both halves are required: a client id without a secret cannot
 * complete a redirect flow, so half-configured counts as not configured.
 *
 * SERVER-INTERNAL. Callers pass the result straight into Better Auth's provider
 * config; it must not be serialised into any response.
 */
export function socialProviderCredentials(
  id: SocialAuthProviderId,
): { clientId: string; clientSecret: string } | null {
  const pair =
    id === "github"
      ? { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET }
      : { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET };

  if (!pair.clientId || !pair.clientSecret) return null;
  return { clientId: pair.clientId, clientSecret: pair.clientSecret };
}

/** True when this provider is registered with Better Auth on this instance. */
export function isSocialProviderConfigured(id: SocialAuthProviderId): boolean {
  return socialProviderCredentials(id) !== null;
}

/**
 * The public, read-only answer to "which login providers can I actually use?",
 * in a stable order. Empty array = password login only, which is the correct
 * answer for a default self-hosted instance and the reason the dashboard can
 * render this list unconditionally instead of gating on `selfHosted`.
 */
export function configuredAuthProviders(): AdvertisedAuthProvider[] {
  return SOCIAL_AUTH_PROVIDERS.filter(isSocialProviderConfigured).map((id) => ({
    id,
    kind: "social" as const,
  }));
}
