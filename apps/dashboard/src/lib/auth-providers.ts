/**
 * Which social-login buttons should the auth pages draw?
 *
 * The server answers the first half — GET /health/env advertises the providers
 * it actually has credentials for (`apps/api/src/lib/auth-providers.ts`), so the
 * dashboard no longer infers it from `selfHosted`. That inference was wrong in
 * both directions: it hid working buttons from a self-hosted operator who HAD
 * configured GitHub, and it would have drawn dead buttons on any cloud deploy
 * missing a credential pair.
 *
 * This module answers the second half — of the advertised providers, which ones
 * can this build actually RENDER? A button needs an icon and a translated label,
 * both of which live in the client. So an advertised id the dashboard doesn't
 * recognise is dropped rather than rendered as an unlabeled mystery button; the
 * server-advertised list is the authority on availability, not on how the UI
 * looks. Adding a provider is a one-line edit to RENDERABLE_OAUTH_PROVIDERS plus
 * its icon/label in components/oauth-buttons.tsx.
 *
 * Pure and DOM-free on purpose, so the mapping is testable without a browser.
 */

/** One entry of the server's advertised list. Loosely typed on purpose: it
 *  arrives over the wire from a server that may be newer than this build. */
export type AdvertisedAuthProvider = {
  id: string;
  /** "social" today. A future SSO/OIDC entry will carry a different kind and is
   *  deliberately NOT rendered as a social button by this build. */
  kind?: string;
};

/**
 * The providers this build can draw, in the order they should appear. Order
 * lives here rather than following the server's array so the login page looks
 * the same on every instance.
 */
export const RENDERABLE_OAUTH_PROVIDERS = ["github", "google"] as const;
export type RenderableOAuthProviderId = (typeof RENDERABLE_OAUTH_PROVIDERS)[number];

/**
 * Advertised list → the buttons to render. Empty in, empty out: a default
 * self-hosted instance advertises nothing and gets no divider and no buttons,
 * which is what it renders today — just for a true reason instead of the
 * `!selfHosted` guess.
 */
export function renderableOAuthProviders(
  advertised: readonly AdvertisedAuthProvider[] | undefined,
): RenderableOAuthProviderId[] {
  if (!advertised?.length) return [];

  const offered = new Set(
    advertised
      // An entry with an explicit non-social kind is something else (SSO/OIDC);
      // rendering it as a "Continue with …" button would misrepresent it.
      .filter((p) => p.kind === undefined || p.kind === "social")
      .map((p) => p.id),
  );

  return RENDERABLE_OAUTH_PROVIDERS.filter((id) => offered.has(id));
}
