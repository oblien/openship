import type { AdvertisedAuthProvider } from "@repo/contracts";
export type { AdvertisedAuthProvider } from "@repo/contracts";

// Presentation order and supported icons/labels belong to this client build.
const RENDERABLE_OAUTH_PROVIDERS = ["github", "google"] as const;
export type RenderableOAuthProviderId = (typeof RENDERABLE_OAUTH_PROVIDERS)[number];

export const DEFAULT_OIDC_DISPLAY_NAME = "SSO";

export interface RenderableOidcProvider {
  id: "oidc";
  name: string;
}

/** Render only supported social providers advertised by the server. */
export function renderableOAuthProviders(
  advertised: readonly AdvertisedAuthProvider[] | undefined,
): RenderableOAuthProviderId[] {
  const offered = new Set(
    (advertised ?? []).filter(provider => provider.kind === "social").map(provider => provider.id),
  );
  return RENDERABLE_OAUTH_PROVIDERS.filter(id => offered.has(id));
}

/** Extract the advertised generic OIDC provider (if any) with a normalized label. */
export function renderableOidcProvider(
  advertised: readonly AdvertisedAuthProvider[] | undefined,
): RenderableOidcProvider | null {
  const match = (advertised ?? []).find(
    provider => provider.id === "oidc" && provider.kind === "oidc",
  );
  if (!match) return null;
  const name = match.name?.trim() || DEFAULT_OIDC_DISPLAY_NAME;
  return { id: "oidc", name };
}
