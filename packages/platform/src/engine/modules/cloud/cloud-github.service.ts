/**
 * Cloud GitHub service - org-scoped policy around the SaaS-only GitHub
 * App flows (OAuth bridge, install URL, install callback attribution,
 * installation list, installation token mint).
 *
 * Extracted from cloud-saas.controller. The handlers in that file now
 * only do HTML/JSON rendering — every policy decision (browser proof,
 * workspace binding, install-state attribution, installation lookup
 * with 404 mapping) lives here and is unit-testable in isolation.
 *
 * SECURITY: the 404-on-missing-installation guard in
 * `mintOrgInstallationToken` is the privilege-escalation boundary —
 * a caller-supplied installationId is intentionally NOT accepted.
 * The id is resolved server-side from (organizationId, owner).
 */

import { reportCaughtError as observeCaughtError, diagnostics as errorDiagnostics } from "@repo/core/diagnostics";
import crypto from "node:crypto";
import { cloudRuntimeTarget, env } from "../../config/env";
import { repos } from "@repo/db";
import { AppError, safeErrorMessage } from "@repo/core";
import type { GitHubInstallationSelection } from "@repo/contracts";
import * as githubAuth from "../github/github.auth";
import { createEphemeralStore } from "../../lib/ephemeral-store";
import { buildBackgroundContext } from "../../lib/background-context";
import { resolveOrgOwner } from "../../lib/org-actor";
import {
  listGitHubInstallationsForUser,
  verifyGitHubInstallationForUser,
} from "../github/github.installation-verification";
import { REPOSITORY_OAUTH_STATE_PREFIX, beginRepositoryAuthorization, repositoryOAuthStateCookie, repositoryOAuthCookieName, assertRepositoryConnectionActor } from "../github/github-repository-authorization";

// ─── OAuth bridge store (shared between handoff + bridge handlers) ──────────
//
// Single-use bridge tokens stashing (userId, sessionToken) for the
// browser-side popup that completes GitHub OAuth on the SaaS. See
// cloud-saas.controller's `githubOauthHandoff` for the issue path —
// `startGithubLinkFromBridgeToken` below is the consume path.

interface OauthBridgeRow {
  userId: string;
  sessionToken: string;
  organizationId: string;
}

export const OAUTH_BRIDGE_TTL_MS = 5 * 60 * 1000;
// Adapter-backed store — swap to Redis/DB without touching call sites
// when the SaaS scales beyond a single replica. See lib/ephemeral-store.ts.
export const oauthBridgeStore = createEphemeralStore<OauthBridgeRow>();

// ─── Org-owner resolution (SaaS-side) ───────────────────────────────────────

/**
 * Resolve the active org's owner — used for GitHub operations where the
 * App installations are still owner-keyed (the user who installed the
 * App owns the gitInstallation rows). Cloud namespace operations skip
 * this and use organizationId directly.
 */
async function resolveCloudOwnerById(
  organizationId: string,
): Promise<{ ownerUserId: string; organizationId: string }> {
  const owner = await resolveOrgOwner(organizationId, "throw");
  return { ownerUserId: owner!.userId, organizationId };
}

// ─── OAuth bridge: same repository grant without a SaaS browser session ──────

export type GithubLinkStartResult =
  | { kind: "redirect"; url: string; forwardCookies: string[]; forwardedNames: string[]; userId: string }
  | { kind: "missing-token" }
  | { kind: "expired" }
  | { kind: "failed"; error: string };

export async function startGithubLinkFromBridgeToken(token: string | undefined): Promise<GithubLinkStartResult> {
  if (!token) return { kind: "missing-token" };
  const bridge = await oauthBridgeStore.consume(token);
  if (!bridge) return { kind: "expired" };
  try {
    const session = await repos.session.findByToken(bridge.sessionToken);
    if (!session || session.userId !== bridge.userId || session.expiresAt <= new Date()) return { kind: "expired" };
    const install = await buildOrgScopedInstallUrl(bridge.userId, bridge.organizationId);
    const result = await beginRepositoryAuthorization({
      userId: bridge.userId, organizationId: bridge.organizationId, sessionId: session.id,
    }, install.state, "bridge");
    // This is the only cookie issued to the browser. No Openship session moves
    // from a self-hosted caller into the operator's system browser.
    return {
      kind: "redirect", url: result.url, userId: bridge.userId,
      forwardCookies: [repositoryOAuthStateCookie(result.state, result.browserNonce)],
      forwardedNames: [repositoryOAuthCookieName(result.state)],
    };
  } catch (error) {
    observeCaughtError(error, "platform/engine/modules/cloud/cloud-github.service"); return { kind: "failed", error: safeErrorMessage(error) }; }
}

// ─── Install URL: org-bound state ────────────────────────────────────────────

/**
 * Bind the install state to the authenticated user who initiated the flow and
 * their active workspace. The installation itself is workspace-owned, while
 * the initiating user is the GitHub identity used for anti-spoof verification
 * and audit attribution.
 */
export async function buildOrgScopedInstallUrl(
  initiatingUserId: string,
  organizationId: string,
): Promise<{ url: string; state: string }> {
  const state = `${REPOSITORY_OAUTH_STATE_PREFIX}${crypto.randomBytes(24).toString("base64url")}`;
  await repos.githubInstallState.purgeExpired().catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "platform/engine/modules/cloud/cloud-github.service"); return 0; });
  await repos.githubInstallState.create({
    state,
    userId: initiatingUserId,
    organizationId,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });
  // GitHub sends an already-installed App to its settings page without a setup
  // callback. Start on Openship so the user can explicitly claim that existing
  // installation instead of getting stuck waiting for another GitHub install.
  const url = new URL("/api/cloud/github/install-callback", cloudRuntimeTarget.api);
  url.search = new URLSearchParams({ flow: "select", state }).toString();
  return { url: url.toString(), state };
}

export type GithubInstallSelectionResult =
  | {
      kind: "ready";
      state: string;
      workspaceName: string;
      installUrl: string;
      installations: GitHubInstallationSelection["installations"];
    }
  | { kind: "missing-params" }
  | { kind: "state-expired" }
  | { kind: "forbidden"; message: string }
  | { kind: "failed"; error: string };

/** Offer existing installations without importing them into a workspace.
 * Selection uses the same one-shot, user/workspace-bound callback as a new
 * GitHub install; the claim re-verifies access after the user makes a choice. */
export async function getGithubInstallSelection(
  state: string | undefined,
): Promise<GithubInstallSelectionResult> {
  if (!state) return { kind: "missing-params" };
  try {
    const binding = await repos.githubInstallState.find(state);
    if (!binding?.organizationId || binding.sourceId || binding.flow !== "install") {
      return { kind: "state-expired" };
    }
    await assertRepositoryConnectionActor(
      binding.userId,
      binding.organizationId,
      binding.payload.sessionId,
    );
    const workspace = await repos.organization.findById(binding.organizationId);
    if (!workspace) return { kind: "state-expired" };

    const appId = Number(env.GITHUB_APP_ID);
    if (!Number.isSafeInteger(appId) || appId <= 0) {
      throw new Error("The Openship GitHub App is not configured.");
    }
    const available = await listGitHubInstallationsForUser(binding.userId);
    if (!available) {
      return {
        kind: "forbidden",
        message: "GitHub authorization is missing. Start the connection again from Openship.",
      };
    }
    const installUrl = new URL(githubAuth.getInstallUrl());
    installUrl.searchParams.set("state", state);
    const connected = await repos.gitInstallation.listByOrganization(binding.organizationId);
    return {
      kind: "ready",
      state,
      workspaceName: workspace.name,
      installUrl: installUrl.toString(),
      installations: available
        .filter((installation) => installation.app_id === appId && !installation.suspended_at)
        .map((installation) => ({
          id: installation.id,
          login: installation.account.login,
          avatarUrl: installation.account.avatar_url,
          type: installation.account.type,
          connected: connected.some(
            (entry) => !entry.sourceId && entry.installationId === installation.id,
          ),
        })),
    };
  } catch (error) {
    observeCaughtError(error, "platform/engine/modules/cloud/cloud-github.service");
    if (error instanceof AppError && error.statusCode < 500) {
      return { kind: "forbidden", message: error.message };
    }
    return { kind: "failed", error: safeErrorMessage(error) };
  }
}

// ─── Install callback: state-based attribution ───────────────────────────────

export type GithubInstallAttributionResult =
  | { kind: "ok"; installation: { id: number; account: { login: string; type: string } }; organizationId: string }
  | { kind: "missing-params" }
  | { kind: "state-expired" }
  | { kind: "invalid-installation-id"; raw: string }
  | { kind: "pending-approval" }
  | { kind: "forbidden"; message: string }
  | { kind: "failed"; installationId?: number; error: string };

export async function attributeGithubInstall(input: {
  installationIdRaw: string | undefined;
  setupAction: string | undefined;
  state: string | undefined;
  clientIp: string | null;
  userAgent: string | null;
}): Promise<GithubInstallAttributionResult> {
  const { installationIdRaw, setupAction, state, clientIp, userAgent } = input;

  if (!state || (!installationIdRaw && setupAction !== "request")) {
    return { kind: "missing-params" };
  }

  console.log(
    `[github install-callback] hit installation_id=${installationIdRaw} setup_action=${setupAction} state_present=true`,
  );
  const installationId = installationIdRaw ? Number(installationIdRaw) : undefined;
  if (installationIdRaw && (!Number.isSafeInteger(installationId) || installationId! <= 0)) {
    return { kind: "invalid-installation-id", raw: installationIdRaw };
  }

  // The callback is intentionally public because GitHub redirects the browser
  // here without an Openship session. The durable, one-shot state recovers the
  // exact initiating user + workspace and works across SaaS replicas/restarts.
  // Peek first; the atomic claim below consumes only after GitHub verification.
  const stateRow = await repos.githubInstallState.find(state).catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "platform/engine/modules/cloud/cloud-github.service"); return null; });
  if (!stateRow || !stateRow.organizationId || stateRow.flow !== "install" || stateRow.sourceId) {
    console.log("[github install-callback] state not found or expired");
    return { kind: "state-expired" };
  }
  const userId = stateRow.userId;
  const organizationId = stateRow.organizationId;

  // Recheck permission and, for repository OAuth, the initiating session through
  // installation completion. Logging out or losing access invalidates the flow.
  try {
    await assertRepositoryConnectionActor(userId, organizationId, stateRow.payload.sessionId);
  } catch (error) {
    observeCaughtError(error, "platform/engine/modules/cloud/cloud-github.service");
    const message = error instanceof AppError ? error.message : "Could not verify workspace access. Try again.";
    await repos.githubInstallState.recordFailure(state, userId, organizationId, message).catch((diagnosticFailure) => {
      observeCaughtError(diagnosticFailure, "platform/engine/modules/cloud/cloud-github.service");
    });
    return error instanceof AppError && error.statusCode < 500
      ? { kind: "forbidden", message }
      : { kind: "failed", installationId, error: message };
  }

  // setup_action="request" means the user lacked admin perms on the org
  // and submitted an approval request instead of installing directly.
  // The later installation.created webhook has no Openship workspace binding,
  // so the user must restart the state-bound install after approval.
  if (setupAction === "request") {
    const consumed = await repos.githubInstallState.pendingApproval(state, userId, organizationId);
    return consumed ? { kind: "pending-approval" } : { kind: "state-expired" };
  }

  if (!installationId) return { kind: "missing-params" };

  try {
    // GitHub documents installation_id as attacker-controlled. The canonical
    // verifier requires BOTH the initiating user's token and this SaaS App's
    // JWT to resolve the same installation before any durable claim occurs.
    const verification = await verifyGitHubInstallationForUser(userId, installationId);
    if (verification.kind === "forbidden") {
      await repos.githubInstallState.recordFailure(state, userId, organizationId, verification.message);
      return { kind: "forbidden", message: verification.message };
    }
    const installation = verification.installation;

    // Consume the state, upsert the workspace installation, and rebind every
    // matching project source in one DB transaction. A failed write leaves the
    // nonce retryable; concurrent replay has exactly one winner.
    const claimed = await repos.gitInstallation.claimWithState(state, {
      userId,
      organizationId,
      provider: "github",
      installationId,
      owner: installation.account.login.toLowerCase(),
      ownerType: installation.account.type,
      // providerUserId is the GitHub user id of the installer; we don't
      // have it here (GitHub doesn't include it on /app/installations/X
      // — it's only in the webhook payload's `sender`). Leaving null;
      // the webhook will fill it in on subsequent uninstall events.
      providerUserId: undefined,
      providerOwnerId: String(installation.account.id),
      isOrg: installation.account.type === "Organization",
    });
    if (!claimed) {
      return { kind: "state-expired" };
    }

    await Promise.all([
      githubAuth.invalidateUserGitHubCache(userId),
      githubAuth.invalidateOrgGitHubCache(organizationId),
    ]).catch((error) => {
      // The durable claim already committed. Cache eviction is an optimization,
      // so do not misreport success as failure or strand a consumed nonce.
      errorDiagnostics.warn("platform/engine/modules/cloud/cloud-github.service",
        `[github install-callback] cache invalidation failed: ${safeErrorMessage(error)}`, error,
      );
    });

    const { cloudAnalytics } = await import("../cloud-analytics");
    cloudAnalytics.capture({ organizationId, userId, source: "dashboard" }, "cloud_github_connected", { method: "app" }, `github:${organizationId}:app:${installationId}`);
    await repos.auditEvent
      .create({
        organizationId,
        actorUserId: userId,
        eventType: "github.install",
        resourceType: "github",
        resourceId: String(installationId),
        source: "dashboard",
        ipAddress: clientIp,
        userAgent: userAgent,
        before: null,
        after: {
          installationId,
          owner: installation.account.login,
          ownerType: installation.account.type,
        },
      })
      .catch((err) =>
        errorDiagnostics.warn("platform/engine/modules/cloud/cloud-github.service",
          "[github install-callback] audit emit failed:",
          safeErrorMessage(err), err,
        ),
      );

    return {
      kind: "ok",
      installation: {
        id: installation.id,
        account: { login: installation.account.login, type: installation.account.type },
      },
      organizationId,
    };
  } catch (err) {
    observeCaughtError(err, "platform/engine/modules/cloud/cloud-github.service");
    const error = safeErrorMessage(err);
    await repos.githubInstallState.recordFailure(state, userId, organizationId, error).catch((diagnosticFailure) => {
      observeCaughtError(diagnosticFailure, "platform/engine/modules/cloud/cloud-github.service");
    });
    return { kind: "failed", installationId, error };
  }
}

// ─── Installation list (org-scoped DTO) ──────────────────────────────────────

export async function listOrgInstallations(
  organizationId: string,
): Promise<Array<{ id: number; login: string; avatarUrl: string; type: string }>> {
  const { ownerUserId } = await resolveCloudOwnerById(organizationId);
  // Background path: the org owner is the canonical attribution. Build
  // a minimal ctx so getUserInstallations can use ctx.organizationId
  // for its install-sync writes without re-guessing memberships[0].
  const installations = await githubAuth.getUserInstallations(
    buildBackgroundContext({
      userId: ownerUserId,
      organizationId,
      label: "cloud:list-org-installations",
    }),
  );
  return installations.map((i) => ({
    id: i.id,
    login: i.account.login,
    avatarUrl: i.account.avatar_url,
    type: i.account.type,
  }));
}

// ─── Installation token mint (org-scoped, privilege-escalation guarded) ─────

/**
 * Mint a short-lived (~60min) installation access token for the given
 * owner. Cloud signs the JWT with its private key and hits GitHub's
 * /access_tokens endpoint.
 *
 * SECURITY: `installationId` is intentionally NOT accepted from the
 * caller — a caller-supplied id is a privilege-escalation surface
 * (Bob could pass Alice's installation id and mint a token against her
 * GitHub App installation). The id is resolved server-side from
 * (organizationId, owner) via the workspace-scoped installation row. If the
 * org doesn't have an installation for `owner`, returns
 * `not-found` so the caller can respond 404.
 */
export async function mintOrgInstallationToken(
  organizationId: string,
  owner: string,
  repos_?: string[],
  permissions?: Record<string, "read" | "write">,
): Promise<
  | { kind: "ok"; token: string; expiresAt: string }
  | { kind: "not-found"; owner: string }
> {
  const { ownerUserId } = await resolveCloudOwnerById(organizationId);

  // Resolve installationId from the workspace row. The owner user remains the
  // background actor, but must not select an installation they connected in a
  // different Openship workspace.
  const installation = await repos.gitInstallation.findByOrgAndOwner(organizationId, owner);
  if (!installation) {
    return { kind: "not-found", owner };
  }

  const token = await githubAuth
    .getInstallationToken(
      buildBackgroundContext({
        userId: ownerUserId,
        organizationId,
        label: "cloud:mint-installation-token",
      }),
      owner,
      installation.installationId,
      // Honor the caller's repo narrowing. Dropping it here silently widened every
      // narrowed mint that proxies through the cloud (`cloud-app` mode, which is the
      // canonical self-hosted path once an org is cloud-connected): the caller asked
      // for a token scoped to one repo and got an installation-wide one back — the
      // "authorized for repo A, credential reaches repo B" shape of
      // GHSA-hp2g-hw7g-f3vm, one layer down in the proxy.
      { repositories: repos_, ...(permissions ? { permissions, noCache: true } : {}) },
    )
    .catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "platform/engine/modules/cloud/cloud-github.service"); return null; });
  if (!token) {
    return { kind: "not-found", owner };
  }

  // getInstallationToken caches the token for 50min; the returned
  // expiresAt is approximate — clients should not rely on it being
  // exact. The cloud-client refreshes ~5min before this.
  return {
    kind: "ok",
    token,
    expiresAt: new Date(Date.now() + 55 * 60 * 1000).toISOString(),
  };
}
