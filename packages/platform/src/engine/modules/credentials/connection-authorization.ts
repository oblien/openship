import { createHash, randomBytes } from "node:crypto";
import { AppError, ConflictError, DESKTOP_CONNECTION_STATE_PREFIX, CONNECTION_OAUTH_TTL_SECONDS, NotFoundError, type ConnectionOAuthProvider } from "@repo/core";
import { repos } from "@repo/db";
import type { ConnectionAuthorizationInput, CompleteConnectionAuthorizationInput } from "@repo/contracts";
import type { ExecutionContext } from "../../../context";
import { cacheStore } from "../../lib/cache-store";
import { encrypt, decrypt } from "../../lib/encryption";
import { createProvisionLock } from "../../lib/provision-lock";
import { resolveDashboardPublicUrl } from "../../lib/public-url";
import {
  readCredentialSecrets,
  writeCredentialSecrets,
  sanitizeCredential,
} from "./credential.service";
import {
  providerJson,
  verifyProviderAccess,
  type MigrationProvider,
  type ProviderAccess,
} from "./provider-api";

const CALLBACK = "/connections/callback";
const tokenEndpoints: Record<ConnectionOAuthProvider, string> = {
  gitlab: "https://gitlab.com/oauth/token",
  railway: "https://backboard.railway.com/oauth/token",
  vercel: "https://api.vercel.com/v2/oauth/access_token",
};
const digest = (value: string) => createHash("sha256").update(value).digest("base64url");
interface AuthorizationState {
  organizationId: string;
  userId: string;
  session: string;
  provider: ConnectionOAuthProvider;
  name: string;
  verifier: string;
  redirectUri: string;
}
interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  team_id?: string | null;
  installation_id?: string;
  configuration_id?: string;
}

function application(provider: ConnectionOAuthProvider) {
  const prefix = `OPENSHIP_CONNECTION_${provider.toUpperCase()}`;
  const clientId = process.env[`${prefix}_CLIENT_ID`]?.trim();
  const clientSecret = process.env[`${prefix}_CLIENT_SECRET`]?.trim();
  const slug = process.env[`${prefix}_INTEGRATION_SLUG`]?.trim();
  if (
    !clientId ||
    !clientSecret ||
    (provider === "vercel" && (!slug || !/^[a-z0-9-]+$/.test(slug)))
  )
    return null;
  return { clientId, clientSecret, slug };
}

export function connectionAuthorizationAvailable(provider: ConnectionOAuthProvider): boolean {
  return !!application(provider);
}

/** Organization connection grants are separate from Better Auth sign-in accounts.
 * The authenticated completion binds state to the initiating user AND session.
 * Redis in Cloud and the shared DB lock make consumption single-use across replicas. */
export async function beginConnectionAuthorization(
  ctx: ExecutionContext,
  input: ConnectionAuthorizationInput,
) {
  const app = application(input.provider);
  if (!app)
    throw new AppError(
      "This connection's OAuth application is not configured. Use an API token.",
      503,
      "CONNECTION_OAUTH_UNAVAILABLE",
    );
  if (!input.name.trim())
    throw new AppError("A connection name is required", 400, "CONNECTION_NAME_REQUIRED");
  if (await repos.credential.nameTaken(ctx.organizationId, input.provider, null, input.name.trim()))
    throw new ConflictError("A connection with this name already exists");
  const state = (input.desktop ? DESKTOP_CONNECTION_STATE_PREFIX : "") + randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const redirectUri = new URL(CALLBACK, resolveDashboardPublicUrl()).href;
  const binding: AuthorizationState = {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    session: digest(ctx.sessionId),
    provider: input.provider,
    name: input.name.trim(),
    verifier,
    redirectUri,
  };
  const store = await cacheStore<string>("connection-authorization", { maxSize: 1000 });
  await store.set(digest(state), encrypt(JSON.stringify(binding)), CONNECTION_OAUTH_TTL_SECONDS);
  const url =
    input.provider === "railway"
      ? new URL("https://backboard.railway.com/oauth/auth")
      : input.provider === "gitlab"
        ? new URL("https://gitlab.com/oauth/authorize")
        : new URL(`https://vercel.com/integrations/${app.slug}/new`);
  url.searchParams.set("state", state);
  if (input.provider !== "vercel") {
    for (const [key, value] of Object.entries({
      response_type: "code",
      client_id: app.clientId,
      redirect_uri: redirectUri,
      ...(input.provider === "railway"
        ? { scope: "openid email profile offline_access workspace:member", prompt: "consent" }
        : { scope: "api read_repository" }),
      code_challenge: digest(verifier),
      code_challenge_method: "S256",
    }))
      url.searchParams.set(key, value);
  }
  return { state, url: url.href };
}

async function exchange(
  provider: ConnectionOAuthProvider,
  fields: Record<string, string>,
): Promise<TokenResponse> {
  const app = application(provider);
  if (!app)
    throw new AppError(
      "Reconnect after configuring the provider's OAuth application",
      503,
      "CONNECTION_OAUTH_UNAVAILABLE",
    );
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  const body = new URLSearchParams(fields);
  if (provider === "railway")
    headers.Authorization = `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString("base64")}`;
  else {
    body.set("client_id", app.clientId);
    body.set("client_secret", app.clientSecret);
  }
  const result = await providerJson<TokenResponse>(new URL(tokenEndpoints[provider]), {
    method: "POST",
    headers,
    body: body.toString(),
  });
  if (
    typeof result.access_token !== "string" ||
    !result.access_token ||
    result.access_token.length > 16_384
  )
    throw new AppError(
      "The provider did not return a usable token. Reconnect.",
      502,
      "CONNECTION_TOKEN_INVALID",
    );
  if (
    provider !== "vercel" &&
    ((provider === "gitlab" && !result.refresh_token) ||
      !Number.isFinite(result.expires_in) ||
      result.expires_in! <= 0 ||
      result.expires_in! > 31_536_000 ||
      (result.refresh_token !== undefined &&
        (typeof result.refresh_token !== "string" ||
          !result.refresh_token ||
          result.refresh_token.length > 16_384)))
  )
    throw new AppError(
      "The provider returned invalid token expiration information. Reconnect.",
      502,
      "CONNECTION_TOKEN_INVALID",
    );
  return result;
}

function tokenSecrets(
  token: TokenResponse,
  previous: Record<string, string> = {},
): Record<string, string> {
  return {
    ...previous,
    apiToken: token.access_token!,
    _authorization: "oauth",
    ...(typeof token.refresh_token === "string" ? { _refreshToken: token.refresh_token } : {}),
    ...(typeof token.expires_in === "number" && token.expires_in > 0
      ? { _expiresAt: String(Date.now() + token.expires_in * 1000) }
      : {}),
  };
}

export async function completeConnectionAuthorization(
  ctx: ExecutionContext,
  input: CompleteConnectionAuthorizationInput,
) {
  const key = digest(input.state);
  return createProvisionLock(`connection:authorization:${key}`).run(async () => {
    const store = await cacheStore<string>("connection-authorization");
    const stored = await store.get(key);
    if (!stored)
      throw new AppError(
        "Authorization expired or was already used. Connect again.",
        409,
        "CONNECTION_STATE_EXPIRED",
      );
    const state = JSON.parse(decrypt(stored)) as AuthorizationState;
    if (
      state.userId !== ctx.userId ||
      state.organizationId !== ctx.organizationId ||
      state.session !== digest(ctx.sessionId)
    )
      throw new AppError(
        "Complete this connection in the account and workspace that started it",
        403,
        "CONNECTION_STATE_MISMATCH",
      );
    // Burn before exchanging: an ambiguous network failure must never replay a code.
    await store.delete(key);
    if (await repos.credential.nameTaken(ctx.organizationId, state.provider, null, state.name))
      throw new ConflictError("A connection with this name already exists");
    const token = await exchange(state.provider, {
      code: input.code,
      redirect_uri: state.redirectUri,
      ...(state.provider !== "vercel"
        ? { grant_type: "authorization_code", code_verifier: state.verifier }
        : {}),
    });
    const publicFields: Record<string, string> = { authorization: "oauth" };
    if (state.provider === "railway") publicFields.tokenType = "oauth";
    if (state.provider === "vercel" && typeof token.team_id === "string")
      publicFields.teamId = token.team_id;
    const secrets = tokenSecrets(
      token,
      state.provider === "gitlab" ? { _redirectUri: state.redirectUri } : {},
    );
    if (state.provider === "gitlab") {
      const { verifyGitLabToken } = await import("../gitlab/client");
      await verifyGitLabToken(secrets.apiToken);
    } else {
      await verifyProviderAccess({ provider: state.provider, publicFields, secrets });
    }
    return sanitizeCredential(
      await repos.credential.create({
        organizationId: ctx.organizationId,
        provider: state.provider,
        name: state.name,
        selector: null,
        publicFields,
        secretsEnc: writeCredentialSecrets(secrets),
        status: "active",
        lastVerifiedAt: new Date(),
      }),
    );
  });
}

/** Always resolve the selected connection by ID and organization. Never pick the
 * newest token for a provider; two connections can own entirely different teams. */
export async function getConnectionAccess<P extends ConnectionOAuthProvider>(
  organizationId: string,
  connectionId: string,
  accepts: (provider: string) => provider is P,
  options: { allowInvalid?: boolean } = {},
): Promise<ProviderAccess<P>> {
  return createProvisionLock(`connection:token:${organizationId}:${connectionId}`).run(async () => {
    const row = await repos.credential.findById(organizationId, connectionId);
    if (!row || !accepts(row.provider)) throw new NotFoundError("Connection", connectionId);
    let secrets = readCredentialSecrets(row);
    if (!secrets.apiToken || (row.status !== "active" && !options.allowInvalid))
      throw new AppError(
        "Reconnect this account to continue",
        409,
        "CONNECTION_RECONNECT_REQUIRED",
      );
    if (
      secrets._authorization === "oauth" &&
      secrets._expiresAt &&
      Number(secrets._expiresAt) <= Date.now() + 60_000
    ) {
      if (row.provider === "vercel" || !secrets._refreshToken)
        throw new AppError(
          "This connection expired. Reconnect it.",
          409,
          "CONNECTION_RECONNECT_REQUIRED",
        );
      secrets = tokenSecrets(
        await exchange(row.provider, {
          grant_type: "refresh_token",
          refresh_token: secrets._refreshToken,
          ...(row.provider === "gitlab" && { redirect_uri: secrets._redirectUri }),
        }),
        secrets,
      );
      const updated = await repos.credential.update(organizationId, row.id, {
        secretsEnc: writeCredentialSecrets(secrets),
      });
      if (!updated) throw new NotFoundError("Connection", connectionId);
    }
    return { provider: row.provider, publicFields: row.publicFields, secrets };
  });
}

/** Migration callers can only resolve credentials owned by migration providers. */
export function getProviderAccess(organizationId: string, connectionId: string) {
  return getConnectionAccess(
    organizationId,
    connectionId,
    (id): id is MigrationProvider => id === "railway" || id === "vercel",
  );
}
