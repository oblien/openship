import { oidcEndpointAllowed } from "./oidc-endpoint";
import { createHash } from "node:crypto";
import {
  authorizationCodeRequest,
  getOAuth2Tokens,
  refreshAccessTokenRequest,
  type OAuth2UserInfo,
} from "@better-auth/core/oauth2";
import { APIError, createAuthMiddleware, getOAuthState } from "better-auth/api";
import { genericOAuth, type GenericOAuthConfig } from "better-auth/plugins";
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import { reportCaughtError } from "@repo/core/diagnostics";

const SIGNING_ALGORITHMS = [
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
  "EdDSA",
];

function oidcUrl(value: string, nodeEnv: string): URL {
  const url = new URL(value);
  if (!oidcEndpointAllowed(url, nodeEnv)) throw new Error("OIDC endpoints must use HTTPS");
  return url;
}

async function readJson(url: URL, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`OIDC endpoint returned HTTP ${response.status}`);
  const body: unknown = await response.json();
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new Error("Invalid OIDC response");
  return body as Record<string, unknown>;
}

// Bind the ID token to Better Auth's existing single-use, cookie-bound PKCE
// state. Domain separation keeps the nonce distinct from the PKCE challenge.
function nonceFor(codeVerifier: string): string {
  return createHash("sha256").update(`openship:oidc:nonce:${codeVerifier}`).digest("base64url");
}

type OidcRequest = {
  path?: string;
  body?: Record<string, unknown>;
  params?: Record<string, string | undefined>;
};

function isOidcStart(ctx: OidcRequest): boolean {
  return (
    ["/sign-in/oauth2", "/oauth2/link", "/sign-in/social", "/link-social"].includes(
      ctx.path ?? "",
    ) &&
    (ctx.body?.providerId === "oidc" || ctx.body?.provider === "oidc")
  );
}

/** Share the route boundary with the existing account-security mode guard. */
export function isOidcRequest(ctx: OidcRequest): boolean {
  return (
    isOidcStart(ctx) ||
    !!ctx.path?.startsWith("/oauth2/callback/") ||
    (ctx.path?.startsWith("/callback/") === true &&
      (ctx.params?.id === "oidc" || ctx.path === "/callback/oidc"))
  );
}

export function createOidcProvider(
  options: { issuer: string; clientId: string; clientSecret: string; nodeEnv: string },
  toUser: (profile: Record<string, unknown>) => OAuth2UserInfo | null,
) {
  const { issuer, clientId, clientSecret, nodeEnv } = options;
  const issuerUrl = oidcUrl(issuer, nodeEnv);
  if (issuerUrl.search) throw new Error("OIDC issuer must not contain a query");
  const discoveryUrl = oidcUrl(
    `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`,
    nodeEnv,
  );
  let jwks: { url: string; resolver: ReturnType<typeof createRemoteJWKSet> } | undefined;

  async function discovery() {
    const doc = await readJson(discoveryUrl);
    if (doc.issuer !== issuer) throw new Error("OIDC discovery issuer does not match OIDC_ISSUER");
    const endpoint = (key: string) => {
      if (typeof doc[key] !== "string") throw new Error(`OIDC discovery is missing ${key}`);
      return oidcUrl(doc[key], nodeEnv);
    };
    const advertised = doc.id_token_signing_alg_values_supported ?? ["RS256"];
    if (!Array.isArray(advertised)) throw new Error("Invalid OIDC signing algorithms");
    const algorithms = SIGNING_ALGORITHMS.filter((alg) => advertised.includes(alg));
    if (!algorithms.length) throw new Error("OIDC requires an asymmetric ID-token signature");
    return {
      authorization: endpoint("authorization_endpoint"),
      token: endpoint("token_endpoint"),
      keys: endpoint("jwks_uri"),
      userInfo: doc.userinfo_endpoint === undefined ? undefined : endpoint("userinfo_endpoint"),
      algorithms,
    };
  }

  const config: GenericOAuthConfig = {
    providerId: "oidc",
    issuer,
    clientId,
    clientSecret,
    scopes: ["openid", "email", "profile"],
    pkce: true,
    // Do not hand discovery to generic OAuth: it does not validate the issuer or
    // endpoint transports before sending credentials. Prepare explicit endpoints.
    async getToken(data) {
      if (!data.codeVerifier) throw new Error("OIDC requires PKCE");
      const doc = await discovery();
      const request = await authorizationCodeRequest({
        ...data,
        options: { clientId, clientSecret },
      });
      return getOAuth2Tokens(await readJson(doc.token, { method: "POST", ...request }));
    },
    async getUserInfo(tokens) {
      try {
        if (!tokens.idToken) return null;
        const state = await getOAuthState();
        if (!state?.codeVerifier) return null;
        const doc = await discovery();
        if (jwks?.url !== doc.keys.href) {
          jwks = {
            url: doc.keys.href,
            resolver: createRemoteJWKSet(doc.keys, {
              [customFetch]: (url, init) => fetch(url, { ...init, redirect: "error" }),
            }),
          };
        }
        const { payload } = await jwtVerify(tokens.idToken, jwks.resolver, {
          issuer,
          audience: clientId,
          algorithms: doc.algorithms,
          requiredClaims: ["iss", "sub", "aud", "exp", "iat", "nonce"],
          clockTolerance: 30,
        });
        if (
          !payload.sub ||
          payload.nonce !== nonceFor(state.codeVerifier) ||
          payload.iat! > Math.floor(Date.now() / 1000) + 30 ||
          (payload.azp !== undefined && payload.azp !== clientId) ||
          (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId)
        ) {
          throw new Error("OIDC token is not bound to this client and sign-in");
        }
        // UserInfo is only a profile fallback AFTER verification. An invalid ID
        // token can never fall through to an unrelated access-token identity.
        if (typeof payload.email === "string" && payload.email.trim()) return toUser(payload);
        if (!doc.userInfo || !tokens.accessToken) return null;
        const profile = await readJson(doc.userInfo, {
          headers: { Authorization: `Bearer ${tokens.accessToken}` },
        });
        if (profile.sub !== payload.sub)
          throw new Error("OIDC UserInfo subject does not match the ID token");
        return toUser({
          ...profile,
          // This email came from UserInfo, so its verification must too. A
          // stale positive flag in a token without email cannot verify a newly
          // changed profile address; an explicit signed negative also denies.
          email_verified:
            profile.email_verified === true &&
            (!Object.hasOwn(payload, "email_verified") || payload.email_verified === true),
        });
      } catch (error) {
        reportCaughtError(error, "platform/engine/lib/oidc");
        return null;
      }
    },
  };

  return {
    ...config,
    async prepare() {
      const doc = await discovery();
      this.authorizationUrl = doc.authorization.href;
      this.tokenUrl = doc.token.href;
    },
    async refresh(refreshToken: string) {
      const doc = await discovery();
      const request = await refreshAccessTokenRequest({
        refreshToken,
        options: { clientId, clientSecret },
      });
      return getOAuth2Tokens(await readJson(doc.token, { method: "POST", ...request }));
    },
  };
}

/** Add only OIDC validation; Better Auth still owns OAuth state, accounts and sessions. */
export function oidcOAuthPlugin(provider?: ReturnType<typeof createOidcProvider>) {
  const plugin = genericOAuth({ config: provider ? [provider] : [] });
  const isStart = (ctx: OidcRequest) => !!provider && isOidcStart(ctx);
  return {
    ...plugin,
    init: ((ctx) => {
      const result = plugin.init(ctx);
      const oidc = result.context.socialProviders.find((p) => p.id === "oidc");
      if (oidc && provider) oidc.refreshAccessToken = provider.refresh;
      return result;
    }) as typeof plugin.init,
    hooks: {
      before: [
        {
          matcher: isStart,
          handler: createAuthMiddleware(async () => {
            try {
              await provider!.prepare();
            } catch (error) {
              reportCaughtError(error, "platform/engine/lib/oidc");
              throw new APIError("BAD_REQUEST", {
                message: "The OIDC provider configuration could not be verified.",
              });
            }
          }),
        },
      ],
      after: [
        {
          matcher: isStart,
          handler: createAuthMiddleware(async (ctx) => {
            const body = ctx.context.returned;
            if (
              !body ||
              typeof body !== "object" ||
              !("url" in body) ||
              typeof body.url !== "string"
            )
              return;
            const state = await getOAuthState();
            if (!state?.codeVerifier)
              throw new APIError("BAD_REQUEST", { message: "OIDC state is missing." });
            const url = new URL(body.url);
            url.searchParams.set("nonce", nonceFor(state.codeVerifier));
            // Social sign-in also sets Location even though its response is JSON.
            if (ctx.context.responseHeaders?.has("location"))
              ctx.context.responseHeaders.set("location", url.href);
            return ctx.json({ ...body, url: url.href });
          }),
        },
      ],
    },
  };
}
