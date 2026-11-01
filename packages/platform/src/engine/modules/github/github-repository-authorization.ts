/** Repository grants are independent of Openship sign-in identities. One GitHub
 * user may authorize several Openship accounts without transferring a login. */
import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { repos } from "@repo/db";
import { AppError } from "@repo/core";
import type { ExecutionContext } from "../../../context";
import { env } from "../../config/env";
import { socialProviderCredentials } from "../../lib/auth-providers";
import { authorization } from "../../lib/authorization";
import { buildBackgroundContext } from "../../lib/background-context";
import { encrypt, decrypt } from "../../lib/encryption";
import { resolveAuthBaseUrl } from "../../lib/public-url";
import { createProvisionLock } from "../../lib/provision-lock";
import { ghFetch } from "./github.http";

export const REPOSITORY_OAUTH_STATE_PREFIX = "ghrepo_";
export const REPOSITORY_OAUTH_CALLBACK_PATH = "/api/auth/callback/github";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const grantLock = (userId: string) =>
  createProvisionLock(`github:repository-authorization:${userId}`);
export const repositoryOAuthCookieName = (state: string) =>
  `openship.github-repository.${digest(state).slice(0, 24)}`;
export function repositoryOAuthStateCookie(state: string, nonce: string): string {
  return `${repositoryOAuthCookieName(state)}=${nonce}; Path=${REPOSITORY_OAUTH_CALLBACK_PATH}; Max-Age=600; HttpOnly; SameSite=Lax${resolveAuthBaseUrl().startsWith("https:") ? "; Secure" : ""}`;
}
const redirectURI = () =>
  `${resolveAuthBaseUrl().replace(/\/$/, "")}${REPOSITORY_OAUTH_CALLBACK_PATH}`;

interface RepositoryGrant {
  accessToken: string;
  refreshToken: string | null;
  accessExpiresAt: number | null;
  refreshExpiresAt: number | null;
}
type StoredGrant = RepositoryGrant | { disconnected: true };

function credentials() {
  const configured = socialProviderCredentials("github");
  if (!env.CLOUD_MODE || !configured)
    throw new AppError(
      "GitHub App connection is unavailable. Use a personal token or try again later.",
      503,
      "GITHUB_APP_UNAVAILABLE",
    );
  return configured;
}

function readGrant(encrypted: string): StoredGrant {
  let value: Partial<RepositoryGrant> & { disconnected?: boolean };
  try {
    value = JSON.parse(decrypt(encrypted));
  } catch (diagnosticFailure) {
    observeCaughtError(diagnosticFailure, "platform/engine/modules/github/github-repository-authorization");
    throw new AppError(
      "Saved GitHub authorization is invalid. Reconnect GitHub.",
      409,
      "GITHUB_RECONNECT_REQUIRED",
    );
  }
  if (!value || typeof value !== "object")
    throw new AppError(
      "Saved GitHub authorization is invalid. Reconnect GitHub.",
      409,
      "GITHUB_RECONNECT_REQUIRED",
    );
  if (value.disconnected === true) return { disconnected: true };
  if (
    typeof value.accessToken !== "string" ||
    !value.accessToken ||
    !(value.refreshToken === null || typeof value.refreshToken === "string") ||
    ![value.accessExpiresAt, value.refreshExpiresAt].every(
      (expiry) => expiry === null || (typeof expiry === "number" && Number.isFinite(expiry)),
    )
  ) {
    throw new AppError(
      "Saved GitHub authorization is invalid. Reconnect GitHub.",
      409,
      "GITHUB_RECONNECT_REQUIRED",
    );
  }
  return value as RepositoryGrant;
}

async function exchangeToken(
  fields: Record<string, string>,
  previous?: RepositoryGrant,
): Promise<RepositoryGrant | null> {
  const configured = credentials();
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: configured.clientId,
      client_secret: configured.clientSecret,
      ...fields,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const result = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    refresh_token_expires_in?: number;
    error?: string;
  };
  if (["bad_verification_code", "bad_refresh_token", "invalid_grant"].includes(result.error ?? ""))
    return null;
  if (
    !response.ok ||
    result.error ||
    typeof result.access_token !== "string" ||
    !result.access_token
  ) {
    throw new AppError(
      "GitHub could not complete authorization. Please try again.",
      502,
      "GITHUB_AUTHORIZATION_FAILED",
    );
  }
  const expiry = (seconds: number | undefined) => {
    if (seconds === undefined) return null;
    if (!Number.isFinite(seconds) || seconds <= 0)
      throw new Error("GitHub returned an invalid token expiry.");
    return Date.now() + seconds * 1000;
  };
  return {
    accessToken: result.access_token,
    refreshToken: result.refresh_token ?? previous?.refreshToken ?? null,
    accessExpiresAt: expiry(result.expires_in),
    refreshExpiresAt:
      result.refresh_token_expires_in === undefined
        ? (previous?.refreshExpiresAt ?? null)
        : expiry(result.refresh_token_expires_in),
  };
}

/** undefined permits legacy sign-in-token fallback; null is an explicit
 * disconnected/expired grant and must not silently select another identity. */
export async function getRepositoryAuthorizationToken(
  userId: string,
): Promise<string | null | undefined> {
  const encrypted = (await repos.settings.findByUser(userId))?.githubAuthorizationEncrypted;
  if (!encrypted) return undefined;
  let initial: StoredGrant;
  try {
    initial = readGrant(encrypted);
  } catch (diagnosticFailure) {
    observeCaughtError(diagnosticFailure, "platform/engine/modules/github/github-repository-authorization");
    return null;
  } // A corrupt grant requires reconnect, never login-token fallback.
  if ("disconnected" in initial) return null;
  if (initial.accessExpiresAt === null || initial.accessExpiresAt > Date.now() + 30_000)
    return initial.accessToken;
  return grantLock(userId).run(async () => {
    const saved = (await repos.settings.findByUser(userId))?.githubAuthorizationEncrypted;
    if (!saved) return null;
    const grant = readGrant(saved);
    if ("disconnected" in grant) return null;
    if (grant.accessExpiresAt === null || grant.accessExpiresAt > Date.now() + 30_000)
      return grant.accessToken;
    if (
      !grant.refreshToken ||
      (grant.refreshExpiresAt !== null && grant.refreshExpiresAt <= Date.now())
    )
      return null;
    const refreshed = await exchangeToken(
      { grant_type: "refresh_token", refresh_token: grant.refreshToken },
      grant,
    );
    await repos.settings.setGitHubAuthorization(
      userId,
      encrypt(JSON.stringify(refreshed ?? { disconnected: true })),
    );
    return refreshed?.accessToken ?? null;
  });
}

export async function disconnectRepositoryAuthorization(userId: string): Promise<void> {
  await grantLock(userId).run(async () => {
    await repos.githubInstallState.cancelAuthorizations(
      userId,
      encrypt(JSON.stringify({ disconnected: true })),
    );
  });
}

export async function assertRepositoryConnectionActor(
  userId: string,
  organizationId: string,
  sessionId?: string,
): Promise<void> {
  const [session, member] = await Promise.all([
    sessionId ? repos.session.findById(sessionId) : null,
    repos.member.find(organizationId, userId),
  ]);
  if (sessionId && (!session || session.userId !== userId || session.expiresAt <= new Date()))
    throw new AppError(
      "Your session or workspace access changed. Sign in and start GitHub connection again.",
      401,
      "GITHUB_SESSION_EXPIRED",
    );
  if (!member)
    throw new AppError(
      "You no longer have access to the Openship workspace that started this install.",
      403,
      "GITHUB_WORKSPACE_ACCESS_CHANGED",
    );
  const ctx = {
    ...buildBackgroundContext({
      userId,
      organizationId,
      role: member.role as ExecutionContext["role"],
      membershipId: member.id,
    }),
    ...(sessionId ? { sessionId } : {}),
  };
  try {
    await authorization.authorize(ctx, {
      resourceType: "github",
      resourceId: "*",
      action: "write",
    });
  } catch (error) {
    if (error instanceof AppError && (error.statusCode === 403 || error.statusCode === 404))
      throw new AppError(
        "You no longer have permission to connect GitHub in this workspace.",
        403,
        "GITHUB_WORKSPACE_ACCESS_CHANGED",
      );
    throw error;
  }
}

export async function beginRepositoryAuthorization(
  ctx: Pick<ExecutionContext, "userId" | "organizationId" | "sessionId">,
  state: string,
  callbackMode: "dashboard" | "bridge" = "dashboard",
) {
  const configured = credentials();
  if (!ctx.sessionId)
    throw new AppError("Sign in and start GitHub connection again.", 401, "GITHUB_SESSION_EXPIRED");
  await assertRepositoryConnectionActor(ctx.userId, ctx.organizationId, ctx.sessionId);
  if (!state.startsWith(REPOSITORY_OAUTH_STATE_PREFIX))
    throw new AppError("Start a new GitHub connection attempt.", 409, "GITHUB_ATTEMPT_EXPIRED");
  const browserNonce = randomBytes(32).toString("base64url");
  const codeVerifier = randomBytes(32).toString("base64url");
  const started = await repos.githubInstallState.beginAuthorization(
    state,
    ctx.userId,
    ctx.organizationId,
    {
      sessionId: ctx.sessionId,
      browserNonceHash: digest(browserNonce),
      codeVerifierEncrypted: encrypt(codeVerifier),
      callbackMode,
    },
  );
  if (!started)
    throw new AppError(
      "This GitHub connection attempt expired or belongs to another workspace. Start again.",
      409,
      "GITHUB_ATTEMPT_EXPIRED",
    );
  const url = new URL("https://github.com/login/oauth/authorize");
  url.search = new URLSearchParams({
    client_id: configured.clientId,
    redirect_uri: redirectURI(),
    state,
    scope: "read:user",
    code_challenge: createHash("sha256").update(codeVerifier).digest("base64url"),
    code_challenge_method: "S256",
  }).toString();
  return { url: url.toString(), state, browserNonce };
}

export async function completeRepositoryAuthorization(input: {
  state: string;
  code?: string;
  browserNonce?: string;
  error?: string;
}) {
  const binding = await repos.githubInstallState.find(input.state);
  if (
    !binding ||
    binding.flow !== "repository-oauth" ||
    !binding.organizationId ||
    !binding.payload.sessionId ||
    !binding.payload.codeVerifierEncrypted ||
    binding.payload.browserNonceHash?.length !== 64 ||
    !input.browserNonce ||
    !timingSafeEqual(
      Buffer.from(digest(input.browserNonce)),
      Buffer.from(binding.payload.browserNonceHash),
    )
  ) {
    throw new AppError(
      "This GitHub connection attempt expired or was opened in another browser. Start again.",
      400,
      "GITHUB_ATTEMPT_EXPIRED",
    );
  }
  return grantLock(binding.userId).run(async () => {
    // Re-read under the lock: only one callback may exchange a single-use code,
    // and a concurrent disconnect must prevent the callback restoring access.
    const current = await repos.githubInstallState.find(input.state);
    if (!current || current.flow !== "repository-oauth")
      throw new AppError(
        "This GitHub connection attempt has already completed. Refresh and try again.",
        409,
        "GITHUB_ATTEMPT_EXPIRED",
      );
    try {
      await assertRepositoryConnectionActor(
        binding.userId,
        binding.organizationId!,
        binding.payload.sessionId!,
      );
      if (input.error)
        throw new AppError(
          "GitHub authorization was cancelled. You can try again or use a personal token.",
          400,
          "GITHUB_AUTHORIZATION_CANCELLED",
        );
      if (!input.code)
        throw new AppError(
          "GitHub did not return an authorization code. Start again.",
          400,
          "GITHUB_AUTHORIZATION_FAILED",
        );
      const grant = await exchangeToken({
        code: input.code,
        code_verifier: decrypt(binding.payload.codeVerifierEncrypted!),
        redirect_uri: redirectURI(),
      });
      if (!grant)
        throw new AppError(
          "GitHub authorization expired. Start the connection again.",
          400,
          "GITHUB_AUTHORIZATION_FAILED",
        );
      const profile = await ghFetch<{ id: number; login: string }>(grant.accessToken, {
        url: "https://api.github.com/user",
      });
      if (!Number.isSafeInteger(profile.id) || profile.id <= 0 || !profile.login)
        throw new Error("GitHub did not return a valid account.");
      await assertRepositoryConnectionActor(
        binding.userId,
        binding.organizationId!,
        binding.payload.sessionId!,
      );
      if (
        !(await repos.githubInstallState.completeAuthorization(
          input.state,
          binding.userId,
          encrypt(JSON.stringify(grant)),
        ))
      ) {
        throw new AppError(
          "This GitHub connection attempt has already completed. Refresh and try again.",
          409,
          "GITHUB_ATTEMPT_EXPIRED",
        );
      }
    } catch (error) {
      const message =
        error instanceof AppError
          ? error.message
          : "GitHub could not complete authorization. Please try again.";
      await repos.githubInstallState
        .failAuthorization(input.state, binding.userId, message)
        .catch((diagnosticFailure) => {
          observeCaughtError(diagnosticFailure, "platform/engine/modules/github/github-repository-authorization");
        });
      throw error;
    }
    return { state: input.state, callbackMode: binding.payload.callbackMode ?? "dashboard" };
  });
}
