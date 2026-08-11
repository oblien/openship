/**
 * Cloud GitHub service - org-scoped policy around the SaaS-only GitHub
 * App flows (OAuth bridge, install URL, install callback attribution,
 * installation list, installation token mint).
 *
 * Extracted from cloud-saas.controller. The handlers in that file now
 * only do HTML/JSON rendering — every policy decision (cookie allowlist,
 * org-owner binding, install-state attribution, installation lookup
 * with 404 mapping) lives here and is unit-testable in isolation.
 *
 * SECURITY: the 404-on-missing-installation guard in
 * `mintOrgInstallationToken` is the privilege-escalation boundary —
 * a caller-supplied installationId is intentionally NOT accepted.
 * The id is resolved server-side from (ownerUserId, owner).
 */

import { auth, COOKIE_PREFIX } from "../../lib/auth";
import { cloudRuntimeTarget } from "../../config/env";
import { repos } from "@repo/db";
import { safeErrorMessage } from "@repo/core";
import * as githubAuth from "../github/github.auth";
import {
  issueInstallState,
  peekAndConsumeInstallState,
} from "../../lib/github-install-state";
import { createEphemeralStore } from "../../lib/ephemeral-store";
import { buildBackgroundContext } from "../../lib/request-context";
import { resolveOrgOwner } from "../../lib/org-actor";

// ─── OAuth bridge store (shared between handoff + bridge handlers) ──────────
//
// Single-use bridge tokens stashing (userId, sessionToken) for the
// browser-side popup that completes GitHub OAuth on the SaaS. See
// cloud-saas.controller's `githubOauthHandoff` for the issue path —
// `startGithubLinkFromBridgeToken` below is the consume path.

interface OauthBridgeRow {
  userId: string;
  sessionToken: string;
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

// ─── OAuth bridge: cookie allowlist policy ───────────────────────────────────

/**
 * SECURITY INVARIANT: forward ONLY the OAuth state cookies, NEVER the
 * SaaS session cookie. The state cookie carries the encrypted
 * link.userId binding (better-auth/dist/state.mjs lines 14-19,
 * callback.mjs:102-128 reads link.userId straight out of the decrypted
 * state — it never consults c.context.session). So the popup browser
 * doesn't need any session cookie to complete the OAuth callback.
 *
 * If we ever forwarded the SaaS session cookie here, we'd silently log
 * the popup window into the SaaS dashboard at api.openship.io from a
 * popup opened by a local self-hosted instance — that's confused-deputy
 * territory. Future Better Auth versions might start emitting unexpected
 * Set-Cookie headers during linkSocialAccount; this allowlist makes that
 * change inert.
 *
 * Better Auth's default state strategy is verification-table-backed
 * (picked because `database: drizzleAdapter(...)` is set in lib/auth.ts),
 * and that strategy names the signed state cookie "state" — NOT
 * "oauth_state". See node_modules/better-auth/dist/state.mjs:43
 * (`settings?.cookieName ?? "state"`). The "oauth_state" name only
 * applies when advanced.storeStateStrategy === "cookie". We forward
 * both names so this stays correct if the strategy ever changes.
 */
export function filterForwardableStateCookies(
  cookies: string[],
  cookiePrefix: string,
): { forwarded: string[]; names: string[] } {
  const allowedCookieNames = [
    "state",                                       // default (verification-table) strategy
    `${cookiePrefix}.state`,                       // prefixed
    `__Secure-${cookiePrefix}.state`,              // secure-prefixed (HTTPS prod)
    "oauth_state",                                 // cookie-strategy default name
    `${cookiePrefix}.oauth_state`,                 // cookie-strategy prefixed
    `__Secure-${cookiePrefix}.oauth_state`,        // cookie-strategy secure-prefixed
  ];
  const forwarded: string[] = [];
  const names: string[] = [];
  for (const cookie of cookies) {
    const cookieName = cookie.split("=")[0]?.trim() ?? "";
    if (allowedCookieNames.some((n) => cookieName === n || cookieName.startsWith(`${n}.`))) {
      forwarded.push(cookie);
      names.push(cookieName);
    }
  }
  return { forwarded, names };
}

function getSetCookieHeaders(headers: Headers): string[] {
  // Node 18+ exposes getSetCookie on Headers; fall back for older envs.
  const anyHeaders = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof anyHeaders.getSetCookie === "function") {
    return anyHeaders.getSetCookie();
  }
  const out: string[] = [];
  headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") out.push(value);
  });
  return out;
}

// ─── OAuth bridge: bridge-token → linkSocialAccount → redirect ──────────────

export type GithubLinkStartResult =
  | { kind: "redirect"; url: string; forwardCookies: string[]; forwardedNames: string[]; userId: string }
  | { kind: "missing-token" }
  | { kind: "expired" }
  | { kind: "no-url"; status: number; bodySnippet: string }
  | { kind: "failed"; error: string };

export async function startGithubLinkFromBridgeToken(
  token: string | undefined,
): Promise<GithubLinkStartResult> {
  if (!token) {
    return { kind: "missing-token" };
  }

  const bridge = await oauthBridgeStore.consume(token);
  if (!bridge) {
    return { kind: "expired" };
  }

  try {
    // The Better Auth `bearer` plugin (configured in lib/auth.ts) accepts
    // `Authorization: Bearer <session.token>` and converts it to the
    // signed cookie format internally. This avoids us having to
    // hand-construct the signed cookie value (which is what was failing
    // before — Better Auth's wire format is very particular about
    // encoding + ordering and getting it wrong silently returns 401).
    const linkHeaders = new Headers();
    linkHeaders.set("Authorization", `Bearer ${bridge.sessionToken}`);

    const linkResult = await auth.api.linkSocialAccount({
      body: {
        provider: "github",
        callbackURL: `${cloudRuntimeTarget.api}/api/cloud/github/oauth-success`,
        disableRedirect: true,
      },
      headers: linkHeaders,
      asResponse: true,
    });

    if (linkResult instanceof Response) {
      // Read the body ONCE into text up-front. Trying to .clone() after
      // .json() throws "Body has already been consumed" — so we capture
      // the bytes once and parse the same string for both the success
      // path (looking for { url }) and the error log fallback.
      const status = linkResult.status;
      const bodyText = await linkResult.text().catch(() => "");

      let redirectUrl: string | null = linkResult.headers.get("location");
      if (!redirectUrl && bodyText) {
        try {
          const body = JSON.parse(bodyText) as { url?: string };
          redirectUrl = body?.url ?? null;
        } catch {
          // Not JSON; redirectUrl stays null and we log below.
        }
      }

      if (redirectUrl) {
        const linkCookies = getSetCookieHeaders(linkResult.headers);
        const { forwarded, names } = filterForwardableStateCookies(linkCookies, COOKIE_PREFIX);
        return {
          kind: "redirect",
          url: redirectUrl,
          forwardCookies: forwarded,
          forwardedNames: names,
          userId: bridge.userId,
        };
      }

      // No URL — log the actual response body so we can see what Better
      // Auth is complaining about. Without this we just see "no URL" and
      // have no signal on whether it's an auth issue, a config issue,
      // or something else.
      return { kind: "no-url", status, bodySnippet: bodyText.slice(0, 300) };
    }

    return { kind: "failed", error: "linkSocialAccount returned a non-Response" };
  } catch (err) {
    return { kind: "failed", error: err instanceof Error ? err.message : "Unknown error" };
  }
}

// ─── Install URL: org-bound state ────────────────────────────────────────────

/**
 * Bind the install state to the org OWNER — the resulting GitHub
 * installation belongs to the org, not the team member who clicked
 * Install. Every team member sees + uses the same installations via
 * resolveCloudOwnerById. Solo SaaS users (personal org) bind to
 * themselves.
 */
export async function buildOrgScopedInstallUrl(
  organizationId: string,
): Promise<{ url: string; state: string; ownerUserId: string }> {
  const { ownerUserId } = await resolveCloudOwnerById(organizationId);
  const state = await issueInstallState(ownerUserId);
  const baseUrl = githubAuth.getInstallUrl();
  const url = `${baseUrl}?state=${encodeURIComponent(state)}`;
  return { url, state, ownerUserId };
}

// ─── Install callback: state-based attribution ───────────────────────────────

export type GithubInstallAttributionResult =
  | { kind: "ok"; installation: { id: number; account: { login: string; type: string } }; organizationId: string }
  | { kind: "missing-params" }
  | { kind: "state-expired" }
  | { kind: "invalid-installation-id"; raw: string }
  | { kind: "pending-approval" }
  | { kind: "failed"; installationId: number; error: string };

export async function attributeGithubInstall(input: {
  installationIdRaw: string | undefined;
  setupAction: string | undefined;
  state: string | undefined;
  clientIp: string | null;
  userAgent: string | null;
}): Promise<GithubInstallAttributionResult> {
  const { installationIdRaw, setupAction, state, clientIp, userAgent } = input;

  if (!installationIdRaw || !state) {
    return { kind: "missing-params" };
  }

  // peekAndConsumeInstallState verifies+burns the state without the
  // userId-binding check that consumeInstallState does — the user's
  // browser hits this endpoint anonymously after the github.com
  // round-trip, so there's no session userId to compare against. The
  // 16-byte random state IS the binding.
  console.log(
    `[github install-callback] hit installation_id=${installationIdRaw} setup_action=${setupAction} state=${state.slice(0, 8)}…`,
  );
  const stateRow = await peekAndConsumeInstallState(state);
  if (!stateRow) {
    console.log("[github install-callback] state not found or expired");
    return { kind: "state-expired" };
  }
  const userId = stateRow.userId;
  const installationId = Number(installationIdRaw);
  if (!Number.isFinite(installationId)) {
    return { kind: "invalid-installation-id", raw: installationIdRaw };
  }

  // setup_action="request" means the user lacked admin perms on the org
  // and submitted an approval request instead of installing directly.
  // GitHub will fire installation.created later when the admin approves;
  // at that point our webhook can take over (the org admin's userId may
  // also be linked). No row to write yet.
  if (setupAction === "request") {
    return { kind: "pending-approval" };
  }

  try {
    // App-JWT lookup — SaaS holds the GitHub App private key, so this
    // works without any user OAuth token. Returns the installation's
    // account (org or user the App was installed on).
    const installation = await githubAuth.appFetch<{
      id: number;
      account: { login: string; id: number; avatar_url: string; type: string };
    }>(`https://api.github.com/app/installations/${installationId}`);

    // not ctx-scoped: install-attribution background path. This runs on
    // the SaaS install-callback redirect, which carries the user's
    // session cookie but not a state nonce we can verify against an
    // org. The install_state row written by resolveInstallUrl IS
    // org-aware — see FOLLOW-UP below.
    //
    // FOLLOW-UP: the install_state row has the originating org id —
    // peek that row by installationId BEFORE falling back to
    // memberships[0]. Today the row is consumed elsewhere
    // (peekAndConsumeInstallState) so the linkage exists; threading
    // organizationId from the consumed binding into here would drop
    // the memberships[0] guess for the App-callback path.
    const memberships = await repos.member
      .listByUser(userId)
      .catch(() => [] as Array<{ organizationId: string }>);
    const organizationId =
      memberships[0]?.organizationId ?? `org_${userId}`;

    await repos.gitInstallation.upsert({
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

    await repos.auditEvent
      .create({
        organizationId,
        actorUserId: userId,
        eventType: "github.install",
        resourceType: "github",
        resourceId: String(installationId),
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
        console.warn(
          "[github install-callback] audit emit failed:",
          safeErrorMessage(err),
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
    return { kind: "failed", installationId, error: safeErrorMessage(err) };
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
 * (ownerUserId, owner) via repos.gitInstallation.findByOwner. If the
 * org owner doesn't have an installation for `owner`, returns
 * `not-found` so the caller can respond 404.
 */
export async function mintOrgInstallationToken(
  organizationId: string,
  owner: string,
  repos_?: string[],
): Promise<
  | { kind: "ok"; token: string; expiresAt: string }
  | { kind: "not-found"; owner: string }
> {
  void repos_;
  const { ownerUserId } = await resolveCloudOwnerById(organizationId);

  // Resolve installationId from the ORG OWNER's row — the org's GitHub
  // installations all live on the owner's account. Never trust the
  // client-supplied installationId.
  const installation = await repos.gitInstallation.findByOwner(ownerUserId, owner);
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
    )
    .catch(() => null);
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
