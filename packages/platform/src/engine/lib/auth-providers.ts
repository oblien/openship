import type { OAuth2UserInfo } from "@better-auth/core/oauth2";
import type { AdvertisedAuthProvider } from "@repo/contracts";
import {
  diagnostics as errorDiagnostics,
  reportCaughtError as observeCaughtError,
} from "@repo/core/diagnostics";
import { createOidcProvider } from "./oidc";
import { env, selfHostedOidcAllowed } from "../config/env";

const SOCIAL_AUTH_PROVIDERS = ["github", "google"] as const;
type SocialAuthProviderId = (typeof SOCIAL_AUTH_PROVIDERS)[number];

export const DEFAULT_OIDC_DISPLAY_NAME = "SSO";
const AUTH_PROVIDERS_COMPONENT = "platform/engine/lib/auth-providers";

export type OidcProviderConfig = ReturnType<typeof createOidcProvider> & {
  providerId: "oidc";
  displayName: string;
};

/**
 * Normalize OIDC profile claims for Better Auth user creation and account linking.
 * Trust `email_verified` only when the IdP explicitly sends boolean `true`.
 */
export function mapOidcProfileToUser(profile: Record<string, unknown>): {
  emailVerified: boolean;
  name?: string;
} {
  const emailVerified = profile.email_verified === true;
  const rawName = typeof profile.name === "string" ? profile.name.trim() : "";
  const preferredUsername =
    typeof profile.preferred_username === "string" ? profile.preferred_username.trim() : "";
  const nickname = typeof profile.nickname === "string" ? profile.nickname.trim() : "";
  const emailPrefix =
    typeof profile.email === "string" && profile.email.includes("@")
      ? (profile.email.split("@")[0]?.trim() ?? "")
      : "";
  const name = rawName || preferredUsername || nickname || emailPrefix;
  return {
    ...(name ? { name } : {}),
    emailVerified,
  };
}

/** Shared credential predicate for Better Auth registration and public discovery. */
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

const warnedPartialOidc = new Set<string>();

function warnPartialOidc(missing: string[]): void {
  const message = `[auth] OIDC login is partially configured (missing ${missing.join(", ")}); skipping oidc provider registration.`;
  if (warnedPartialOidc.has(message)) return;
  warnedPartialOidc.add(message);
  errorDiagnostics.warn(AUTH_PROVIDERS_COMPONENT, message);
}

function nonEmpty(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** User-table fields only. Raw claims such as `sub` or `groups` are not columns. */
function toOidcUser(issuer: string, profile: Record<string, unknown>): OAuth2UserInfo | null {
  // OIDC subjects are opaque, case-sensitive identifiers. Normalizing one can
  // select a different already-linked account at the same issuer.
  const id = typeof profile.sub === "string" ? profile.sub : "";
  const email = nonEmpty(profile.email);
  // The shared invite-only gate identifies invitees by email. An unverified
  // address cannot prove ownership of an invitation or an existing account.
  if (!id || !email || profile.email_verified !== true) return null;
  const mapped = mapOidcProfileToUser(profile);
  const image = nonEmpty(profile.picture) || nonEmpty(profile.image);
  return {
    // The OIDC identity is (issuer, subject), not subject alone. Reconfiguring
    // the instance's IdP must not reuse another issuer's account bindings.
    id: JSON.stringify([issuer, id]),
    email,
    emailVerified: mapped.emailVerified,
    ...(mapped.name ? { name: mapped.name } : {}),
    ...(image ? { image } : {}),
  };
}

/** Register generic OIDC only when issuer, client id, and secret are all set. */
export function oidcProviderConfig(): OidcProviderConfig | undefined {
  if (!selfHostedOidcAllowed) return undefined;
  const issuer = env.OIDC_ISSUER?.trim() ?? "";
  const clientId = env.OIDC_CLIENT_ID?.trim() ?? "";
  const clientSecret = env.OIDC_CLIENT_SECRET?.trim() ?? "";
  if (!issuer && !clientId && !clientSecret) return undefined;
  if (!issuer || !clientId || !clientSecret) {
    const missing: string[] = [];
    if (!issuer) missing.push("OIDC_ISSUER");
    if (!clientId) missing.push("OIDC_CLIENT_ID");
    if (!clientSecret) missing.push("OIDC_CLIENT_SECRET");
    warnPartialOidc(missing);
    return undefined;
  }
  try {
    return {
      ...createOidcProvider({ issuer, clientId, clientSecret, nodeEnv: env.NODE_ENV }, (profile) =>
        toOidcUser(issuer, profile),
      ),
      providerId: "oidc",
      displayName: env.OIDC_DISPLAY_NAME?.trim() || DEFAULT_OIDC_DISPLAY_NAME,
    };
  } catch (error) {
    observeCaughtError(error, AUTH_PROVIDERS_COMPONENT);
    return undefined;
  }
}

/** Public response: IDs and kinds only; never return the registration credentials. */
export function configuredAuthProviders(): AdvertisedAuthProvider[] {
  const providers: AdvertisedAuthProvider[] = SOCIAL_AUTH_PROVIDERS.filter(
    (id) => socialProviderCredentials(id) !== null,
  ).map((id) => ({ id, kind: "social" }));
  const oidc = oidcProviderConfig();
  if (oidc) providers.push({ id: "oidc", kind: "oidc", name: oidc.displayName });
  return providers;
}
