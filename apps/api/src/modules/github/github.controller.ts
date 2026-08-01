/**
 * GitHub controller - Hono request handlers.
 *
 * Every handler:
 *   1. Extracts user from context (set by authMiddleware)
 *   2. Validates params/query/body via TypeBox schemas (at the route level)
 *   3. Delegates to service/auth functions
 *   4. Returns a consistent JSON response
 *
 * No direct GitHub API calls here - that's the service's job.
 */

import type { Context } from "hono";
import { env, runtimeTarget } from "../../config/env";
import { auth } from "../../lib/auth";
import { audit, auditContextFrom } from "../../lib/audit";
import * as githubAuth from "./github.auth";
import * as githubService from "./github.service";
import { createGitHubSource } from "./sources";
import { filterAllowedRepos, filterAllowedAccounts, filterTreeEntries } from "./github-access";
import {
  resolveProjectInfo,
  projectInfoToScanResponse,
} from "../deployments/prepare.service";
import { paginateRepoList, type RepoListParams } from "./repo-list";
import { getRequestContext } from "../../lib/request-context";

/** Map a MappedRepository to the owner/repo key the access filter needs.
 *  `full_name` is canonically "owner/repo"; fall back to the discrete
 *  fields when it's absent. `||` (not `??`) so an empty split segment
 *  ("" from a missing full_name) falls through instead of sticking. */
function repoKey(r: { full_name?: string; owner?: string; name?: string }) {
  const [owner, repo] = (r.full_name ?? "").split("/");
  return { owner: owner || r.owner || "", repo: repo || r.name || "" };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Safely extract a required route param. */
function param(c: Context, name: string): string {
  const val = c.req.param(name);
  if (!val) throw new Error(`Missing route param: ${name}`);
  return val;
}

function getSetCookieHeaders(headers: Headers): string[] {
  const responseHeaders = headers as Headers & {
    getSetCookie?: () => string[];
  };

  if (typeof responseHeaders.getSetCookie === "function") {
    const cookies = responseHeaders.getSetCookie();
    if (cookies.length > 0) {
      return cookies;
    }
  }

  const cookie = headers.get("set-cookie");
  return cookie ? [cookie] : [];
}

// ─── Status / Connection ─────────────────────────────────────────────────────

/**
 * GET /github/status — connection state for the current user, PLUS the App's
 * installation accounts. Wire shape: `{ state: GitHubConnectionState, accounts:
 * MappedAccount[] }`. This is the Settings card's data source — it probes the
 * cloud for the real App status + installs, decoupled from the gh-first
 * library home (getUserHome). No `mode` field: the global platform mode is
 * `env.CLOUD_MODE` (backend) / `selfHosted` (frontend's PlatformContext).
 */
export async function getStatus(c: Context) {
  const ctx = getRequestContext(c);
  const source = await createGitHubSource(ctx);
  // The Settings card owns the "Install App" affordance, so the install URL is
  // resolved HERE (cloud round-trip in cloud-app mode), alongside the real App
  // status + installs. Members still only see App accounts they're granted.
  const [{ state, accounts }, install] = await Promise.all([
    source.getConnectionStatus(),
    source.resolveInstallUrl(),
  ]);
  const allowedAccounts = await filterAllowedAccounts(ctx, accounts, (a) => a.login);
  // Connect methods, derived server-side from the SAME chain table that resolves
  // credentials. The dashboard used to decide this itself from `selfHosted` /
  // `deployMode`, which is how it ended up offering a forwarding toggle that could
  // never take effect and a Cloud App row on a box with no cloud link.
  const { resolveGitHubCapabilities } = await import("./github.capabilities");
  const { isCloudConnected } = await import("../../lib/cloud/session");
  const capabilities = await resolveGitHubCapabilities(ctx, {
    cloudConnected: await isCloudConnected(ctx.userId).catch(() => false),
  }).catch(() => null);
  return c.json({
    state,
    accounts: allowedAccounts,
    installUrl: install.url,
    cloudUnreachable: install.cloudUnreachable ?? false,
    capabilities,
  });
}

/**
 * GET /github/home — canonical state plus accounts and repos visible from
 * the active source(s). The install URL is offered whenever the App is
 * an option for this user (any non-CLOUD_MODE-only install ships the App
 * install URL so the dashboard can prompt "install on this org").
 */
export async function getHome(c: Context) {
  const ctx = getRequestContext(c);
  const source = await createGitHubSource(ctx);
  const data = await source.getHome();

  // installUrl is an App concept that resolveInstallUrl resolves via the SaaS
  // in cloud-app mode. The gh-first library doesn't need it — the "Install
  // App" affordance lives on the Settings card, which gets it from
  // GET /github/status. So when gh drives the library (state.primary ===
  // "gh-cli") we SKIP the cloud probe entirely, keeping a plain browse 100%
  // local. Only the App/cloud library path resolves it (as before).
  let installUrl = "";
  let cloudUnreachable = false;
  if (data.state.primary !== "gh-cli") {
    const r = await source.resolveInstallUrl();
    installUrl = r.url;
    cloudUnreachable = r.cloudUnreachable ?? false;
  }

  // Default-deny GitHub visibility: a member sees only the repos/accounts
  // the owner granted them. Owner / all-GitHub grant → unchanged (the
  // filters short-circuit). This is the "list" op of the access layer.
  const [repos, accounts] = await Promise.all([
    filterAllowedRepos(ctx, data.repos, repoKey),
    filterAllowedAccounts(ctx, data.accounts, (a) => a.login),
  ]);
  // Same capability payload as /github/status. The library reads /home, so without
  // it here the empty state would have to fall back to guessing platform policy —
  // the duplication this whole thing removes.
  const { resolveGitHubCapabilities } = await import("./github.capabilities");
  const { isCloudConnected } = await import("../../lib/cloud/session");
  const capabilities = await resolveGitHubCapabilities(ctx, {
    cloudConnected: await isCloudConnected(ctx.userId).catch(() => false),
  }).catch(() => null);

  return c.json({
    ...data,
    accounts,
    repos,
    installUrl,
    // cloud-app mode + SaaS down: the card shows "Openship Cloud
    // unreachable" instead of a dead install button (installUrl is "").
    cloudUnreachable,
    capabilities,
  });
}

/**
 * Returned with HTTP 503 when a cloud-app connect step needs the SaaS
 * (OAuth handoff or install URL) but openship.io is unreachable. The
 * dashboard surfaces `message` via getApiErrorMessage → toast, so the
 * user learns the real cause instead of being handed a dead install link.
 */
const CLOUD_UNREACHABLE_CONNECT = {
  error: "cloud_unreachable",
  message:
    "Openship Cloud is unreachable, so GitHub can't be connected right now. GitHub connection runs through Openship Cloud — reconnect it in Settings or check your network, then try again.",
} as const;

/** POST /github/connect - Normalized connection flow.
 *
 *  Returns a consistent shape regardless of auth mode:
 *
 *  Already connected:
 *    { connected: true }
 *
 *  Needs redirect (OAuth or App install):
 *    { connected: false, flow: "redirect", url: "https://..." }
 *
 *  Device flow (desktop with CLIENT_ID):
 *    { connected: false, flow: "device_code", userCode, verificationUri, ... }
 *
 *  Terminal instruction (desktop without CLIENT_ID):
 *    { connected: false, flow: "terminal", command, message }
 *
 *  Cloud unreachable (cloud-app mode, SaaS down):
 *    503 { error: "cloud_unreachable", message }
 *
 *  The frontend is mode-agnostic - it just reacts to `flow`.
 */
export async function connect(c: Context) {
  const ctx = getRequestContext(c);
  const userId = ctx.userId;
  // Per-user resolution — picks "cloud-app" when self-hosted + cloud-
  // connected, otherwise falls back to the static mode. Every branch
  // below sees the actual mode this user should use.
  const mode = await githubAuth.resolveGitHubAuthMode(ctx);

  // Optional `source` discriminator from the dashboard's dual-source
  // (Openship App vs gh CLI) settings panel. When the user explicitly
  // clicks "Connect Openship App", source="oauth" forces the App
  // install flow regardless of whether gh CLI is already authenticated;
  // otherwise the two buttons would be indistinguishable to the server
  // and both would short-circuit on the cli token.
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const source = body && typeof body === "object" && "source" in body
    ? (body.source as "oauth" | "cli" | undefined)
    : undefined;

  // ── Explicit CLI un-suppress (applies in any mode) ───────────────
  // User clicked "Use gh CLI" — they want the prior Disconnect
  // suppression flag cleared so openship reads `gh auth token` again.
  // This MUST run before the mode-based branches below; otherwise in
  // cloud-app mode it would never fire (we'd return the App install
  // URL and the flag would stay set forever).
  //
  // In cloud-app mode there's no further connection step needed once
  // the flag is cleared — the next /github/home refresh sees the CLI
  // available and the dashboard CLI card flips from "Disabled" to
  // "Logged in as @user". Return `connected: true` so the frontend
  // doesn't try to open an auth window.
  //
  // In cli mode we still need to check status (gh might not actually
  // be authed), so we just clear the flag and fall through to the
  // existing cli-mode logic below.
  if (source === "cli") {
    const { setGithubCliDisabled } = await import("../settings/settings.service");
    await setGithubCliDisabled(userId, false);
    if (mode === "cloud-app") {
      return c.json({ connected: true });
    }
  }

  // ── Cloud-app (self-hosted + cloud-connected) ────────────────────
  // SaaS-only architecture: the local instance never holds GitHub OAuth
  // credentials and never runs the OAuth round-trip itself. All GitHub
  // auth flows through api.openship.io.
  //
  // Two-step flow:
  //   1. If the SaaS doesn't yet have a `account` row with
  //      providerId='github' for this user → return the SaaS OAuth
  //      handoff URL. Popup opens it; SaaS bridges to GitHub OAuth;
  //      Better Auth creates the account row on the SaaS DB.
  //   2. Once status.connected is true on SaaS → return the SaaS-bound
  //      install URL (also from cloud-client). User installs; webhook
  //      attributes correctly because the OAuth row now exists.
  //
  // The frontend keeps clicking Connect; the server's response (`step`)
  // tells it which UI to show ("connecting GitHub" vs "installing App").
  if (mode === "cloud-app") {
    const status = await githubAuth.getUserStatus(userId);

    // Step 1: GitHub OAuth via SaaS. The Connect button does this FIRST.
    // Returning the install URL before OAuth is broken — the webhook
    // can't attribute the install to a SaaS user without the account
    // row, and the install becomes orphaned on github.com.
    if (!status.connected) {
      const oauth = await githubAuth.resolveOauthHandoffUrl(userId);
      if (oauth) {
        return c.json({
          connected: false,
          flow: "redirect" as const,
          url: oauth.url,
          step: "oauth" as const,
        });
      }
      // SaaS-only mode: the OAuth handoff URL comes from openship.io. A
      // null here means the SaaS is unreachable. We must NOT degrade to a
      // stateless github.com install link — that skips the OAuth step the
      // webhook needs and orphans the install. Tell the user the truth.
      return c.json(CLOUD_UNREACHABLE_CONNECT, 503);
    }

    // Step 2: OAuth done. Check if installations already exist.
    if (status.connected) {
      const installations = await githubAuth.getUserInstallations(ctx, status);
      if (installations.length > 0 && source !== "oauth") {
        return c.json({ connected: true });
      }
    }

    // Step 2 continued: no installations yet → return install URL.
    const install = await githubAuth.resolveInstallUrl(ctx);
    if (install.cloudUnreachable) {
      return c.json(CLOUD_UNREACHABLE_CONNECT, 503);
    }
    return c.json({
      connected: false,
      flow: "redirect" as const,
      url: install.url,
      state: install.state,
      step: "install" as const,
    });
  }

  // Clicking Connect always means "I want to be connected" - clear any
  // prior cli-suppression flag from a previous Disconnect so the status
  // check below can resolve via the gh CLI fallback if it's available.
  // Skip this when the user explicitly chose the App source — we don't
  // want to silently re-enable cli when they're trying to add the App.
  if (mode === "cli" && source !== "oauth") {
    const { setGithubCliDisabled } = await import("../settings/settings.service");
    await setGithubCliDisabled(userId, false);
  }
  const status = await githubAuth.getUserStatus(userId);

  // ── Explicit App-source request (overrides mode-based routing) ────
  // In cli mode the dashboard shows TWO connect buttons (App + CLI).
  // When the user clicked the App button, ALWAYS run the App install
  // flow — return the install URL (and, if OAuth is missing, kick the
  // OAuth-then-install dance via the redirect endpoint).
  if (source === "oauth") {
    if (!status.connected) {
      // OAuth not present yet — the redirect endpoint will do
      // linkSocialAccount then callbackURL=/auth/callback/install
      // which redirects to the App install URL.
      return c.json({
        connected: false,
        flow: "redirect" as const,
      });
    }
    const installations = await githubAuth.getUserInstallations(ctx, status);
    if (installations.length > 0) {
      return c.json({ connected: true });
    }
    const { url } = await githubAuth.resolveInstallUrl(ctx);
    return c.json({
      connected: false,
      flow: "redirect" as const,
      url,
    });
  }

  // ── Already connected? ─────────────────────────────────────
  if (mode === "token" && status.connected) {
    return c.json({ connected: true });
  }

  if (mode === "cli") {
    if (status.connected) {
      return c.json({ connected: true });
    }
  }

  if (mode === "oauth" && status.connected) {
    return c.json({ connected: true });
  }

  if (mode === "app" && status.connected) {
    const installations = await githubAuth.getUserInstallations(ctx, status);
    if (installations.length > 0) {
      return c.json({ connected: true });
    }

    const { url } = await githubAuth.resolveInstallUrl(ctx);
    return c.json({
      connected: false,
      flow: "redirect" as const,
      url,
    });
  }

  // ── CLI: no token yet ──────────────────────────────────────
  if (mode === "cli") {
    // Dynamic import: gh device flow is self-hosted only; never on the SaaS.
    const { startDeviceFlow, deviceFlowAvailable } = await import("./github.local-auth");

    // The browser device flow is the DEFAULT path: it needs no app registration,
    // no cloud account and no shell on the box. Only when no client id resolves at
    // all do we fall back to telling the operator to run `gh auth login` — which on
    // a remote self-hosted instance means SSH-ing in, so it's a last resort, not
    // the first offer.
    if (!deviceFlowAvailable()) {
      // No device client id on this instance. Ask for a token IN THE UI rather
      // than telling the operator to go run `gh auth login` somewhere — on a
      // container install the api image has no `gh` and cannot see the host's
      // ~/.config/gh, so that instruction was unactionable on the very topology
      // that hits this branch. `gh auth login` stays as a secondary hint because
      // reading hosts.yml still works on a bare install that has it.
      return c.json({
        connected: false,
        flow: "token" as const,
        command: "gh auth login",
        message:
          "Paste a GitHub token to connect this instance. " +
          "Needs the `repo` scope (add `read:org` to see organization repos).",
      });
    }
    try {
      // Completing a device sign-in is the same explicit operator act as pasting a
      // token, so record the opt-in up front — otherwise the finished sign-in
      // stores a credential tokenFor refuses to use.
      const settingsService = await import("../settings/settings.service");
      await settingsService.setGhCliOperatorOptedIn(userId, true);
      const verification = await startDeviceFlow(userId);
      return c.json({
        connected: false,
        flow: "device_code" as const,
        userCode: verification.user_code,
        verificationUri: verification.verification_uri,
        expiresIn: verification.expires_in,
        interval: verification.interval,
      });
    } catch (err) {
      return c.json({ connected: false, error: (err as Error).message }, 500);
    }
  }

  // ── Token mode with no token ───────────────────────────────
  if (mode === "token") {
    return c.json({
      connected: false,
      flow: "terminal" as const,
      command: "GITHUB_TOKEN=ghp_... (set in environment)",
      message: "Set the GITHUB_TOKEN environment variable and restart the server.",
    });
  }

  // ── App / OAuth: need GitHub OAuth → tell frontend to open the redirect popup ──
  return c.json({ connected: false, flow: "redirect" as const });
}

/** GET /github/connect/redirect - Direct browser navigation endpoint.
 *
 *  Instead of returning JSON (which is a cross-origin fetch that can't
 *  persist cookies in the popup's browsing context), this endpoint is
 *  navigated to directly by the popup window. It calls better-auth's
 *  linkSocialAccount, copies the state cookie to the response, and does a
 *  302 redirect to GitHub. The cookie lives in the popup's context so
 *  it's available when GitHub redirects back to the callback URL.
 */
export async function connectRedirect(c: Context) {
  // HIGH #8 — connectRedirect runs per-user (the redirect is initiated
  // from a popup that carries the user's session cookies). The sync
  // `getGitHubAuthMode()` returns the LOCAL-only mode and reports "cli"
  // for a self-hosted instance that's actually cloud-connected, which
  // would send the OAuth callback to `/auth/callback/close` instead of
  // the `/auth/callback/install` path the App-installation flow needs.
  // Resolve per-user so each caller routes through the right callback.
  // connectRedirect may run before authMiddleware has run in some
  // failure modes (no session cookie yet) — fall back to the sync mode
  // when ctx isn't present rather than throwing.
  let mode: githubAuth.GitHubAuthMode;
  try {
    const ctx = getRequestContext(c);
    mode = await githubAuth.resolveGitHubAuthMode(ctx);
  } catch {
    mode = githubAuth.getGitHubAuthMode();
  }

  // Both "app" (this is the SaaS) and "cloud-app" (self-hosted + cloud-
  // connected) install the GitHub App, so both want the install
  // callback URL. CLI / OAuth-only paths just close the popup.
  const path =
    mode === "app" || mode === "cloud-app"
      ? "/auth/callback/install"
      : "/auth/callback/close";

  // Better Auth stores callbackURL/errorCallbackURL verbatim and redirects to
  // them as-is after the OAuth callback (which runs on the API origin). In
  // split-origin SaaS (app.* vs api.*) a relative path would resolve against
  // the API host and dead-end, so absolutize against the dashboard origin.
  // Self-hosted keeps the relative path (resolves against its single origin).
  const dashOrigin = env.CLOUD_MODE ? runtimeTarget.dashboard : "";
  const callbackURL = `${dashOrigin}${path}`;
  // Route link FAILURES to the app's close page (which surfaces the error via
  // localStorage → opener toast) instead of Better Auth's raw error page on
  // the API origin, where the popup would otherwise dead-end.
  const errorCallbackURL = `${dashOrigin}/auth/callback/close`;

  try {
    // Use linkSocialAccount (not signInSocial) because the user is already
    // authenticated - we want to attach GitHub to their existing account.
    const result = await auth.api.linkSocialAccount({
      body: {
        provider: "github",
        callbackURL,
        errorCallbackURL,
        disableRedirect: true,
      },
      headers: c.req.raw.headers,
      asResponse: true,
    });

    if (result instanceof Response) {
      const cookies = getSetCookieHeaders(result.headers);
      let redirectUrl: string | null = null;

      const locationHeader = result.headers.get("location");
      if (locationHeader) {
        redirectUrl = locationHeader;
      }

      try {
        const body = await result.json() as { url?: string };
        redirectUrl = redirectUrl ?? body?.url ?? null;
      } catch {
        // Ignore non-JSON bodies and fall back to headers-only handling.
      }

      if (redirectUrl) {
        const response = c.redirect(redirectUrl);
        for (const cookie of cookies) {
          response.headers.append("Set-Cookie", cookie);
        }
        return response;
      }
    }

    // Fallback: non-Response result with a URL
    if (result && typeof result === "object" && "url" in result) {
      return c.redirect((result as { url: string }).url);
    }
  } catch (err) {
    /* fall through */
  }

  return c.text("Unable to start GitHub authorization", 500);
}

/** GET /github/local-status - Check if the machine has `gh` CLI auth available.
 *  Gated by `localOnly` middleware - never reaches this handler in cloud modes.
 */
export async function getLocalStatus(c: Context) {
  const { getLocalGhStatus } = await import("./github.local-auth");
  const localStatus = await getLocalGhStatus();
  return c.json({
    ...localStatus,
    activeMode: githubAuth.getGitHubAuthMode(),
  });
}

/** GET /github/connect/poll - Poll the device flow status.
 *  Gated by `localOnly` middleware.
 */
export async function pollConnect(c: Context) {
  const ctx = getRequestContext(c);
  const { getDeviceFlowStatus } = await import("./github.local-auth");
  const status = getDeviceFlowStatus(ctx.userId);
  if (!status) {
    return c.json({ status: "none" as const }, 404);
  }
  // NEVER return the access token to the browser. On completion the device flow
  // has already persisted it server-side (startDeviceFlow → gh-cli token store);
  // the client only needs the status. Returning `status` verbatim here leaked the
  // token onto the wire (and into any client logging). Strip it.
  const { token: _token, ...safe } = status;
  return c.json(safe);
}

/**
 * POST /github/instance-token — connect this instance with a pasted GitHub token.
 *
 * The no-setup fallback for an instance with no device client id, and the answer
 * for anyone who'd rather hand over a scoped PAT than sign in interactively. The
 * token lands in the SAME durable slot the device flow writes
 * (`instance_settings.ghDeviceTokenEncrypted`), so it participates as the
 * instance's git identity through `getLocalGhToken()` — one credential source,
 * not a second competing one.
 *
 * Validated before it is stored: `inspectPatScope` proves it works and reports
 * its scopes, `classifyPatScope` decides reject / warn / accept. Storing an
 * unvalidated token would surface as a broken clone deep inside a deploy instead
 * of an error on the field the operator just typed into.
 *
 * Self-hosted only — CLOUD_MODE has no instance-wide git identity by design.
 */
export async function setInstanceToken(c: Context) {
  if (env.CLOUD_MODE) {
    return c.json({ error: "Not available on Openship Cloud", code: "NOT_SUPPORTED" }, 400);
  }
  const ctx = getRequestContext(c);
  const body = await c.req.json<{ token?: string }>().catch(() => null);
  const token = body?.token?.trim();
  if (!token) {
    return c.json({ error: "token is required", code: "INVALID_TOKEN" }, 400);
  }

  let report: Awaited<ReturnType<typeof githubService.inspectPatScope>>;
  try {
    report = await githubService.inspectPatScope(token);
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "Could not validate token", code: "INVALID_TOKEN" },
      400,
    );
  }
  const verdict = githubService.classifyPatScope(report);
  if (!verdict.ok) {
    return c.json({ error: verdict.reason, code: "INSUFFICIENT_SCOPE" }, 400);
  }

  const { setStoredDeviceToken } = await import("./github.local-auth");
  await setStoredDeviceToken(token, "token");
  // Sweep this user's cached GitHub state so /status and the importer see the new
  // identity on the NEXT read. Without it the connection only appeared after the
  // cached verdict aged out — i.e. "I added a token but New Project still fails".
  await githubAuth.invalidateUserGitHubCache(ctx.userId);
  // Clicking connect means "I want to be connected" — clear any prior
  // Disconnect suppression, same as the interactive connect path does.
  const settingsService = await import("../settings/settings.service");
  await settingsService.setGithubCliDisabled(ctx.userId, false);
  // …and record the operator opt-in `tokenFor` gates the stored-credential branch
  // on. Nothing ever set that flag, so a pasted token was stored, the UI said
  // "Connected", and the next deploy still reported "no App/PAT token is
  // available". Pasting a credential into Openship IS the explicit act the flag
  // was designed to capture.
  await settingsService.setGhCliOperatorOptedIn(ctx.userId, true);

  if (ctx.organizationId) {
    audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
      eventType: "github.instance_token.set",
      resourceType: "github",
      resourceId: "*",
      // Login + scopes only. The token itself must never reach the audit log.
      after: { login: report.user, scopes: report.scopes },
    });
  }

  return c.json({ connected: true, login: report.user, warning: verdict.warning });
}

/**
 * POST /github/disconnect - Disconnect from one source (or both).
 *
 * Body / query: { source?: "oauth" | "cli" | "all" }   (default "all")
 *
 * Doesn't uninstall the GitHub App - that happens via webhook only.
 */
export async function disconnect(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req.json().catch(() => ({}));
  const queryParam = c.req.query("source");
  const rawSource = (body?.source ?? queryParam) as string | undefined;
  const source: "oauth" | "cli" | "all" =
    rawSource === "oauth" || rawSource === "cli" || rawSource === "all" ? rawSource : "all";
  await githubAuth.disconnectUser(ctx.userId, source);
  if (ctx.organizationId) {
    audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
      eventType: "github.disconnect",
      resourceType: "github",
      resourceId: "*",
      after: { source },
    });
  }
  return c.json({ success: true, source });
}

// ─── Accounts / Organisations ────────────────────────────────────────────────
//
// `getHome` (GET /github/home → getUserHome service) is the SINGLE
// dashboard entry point — it returns { state, accounts, repos } in one
// round trip. The previous fan-out endpoints (/accounts, /orgs,
// /orgs/repos) duplicated the same `/user/orgs` fetch across three
// helpers (listUserAccounts, listUserOrgsViaApi, listUserOrgsWithReposViaApi)
// and were never called from the dashboard after the consolidation.
// All deleted. Anything that still needs the per-org breakdown can
// derive it from the unified home response.

// ─── Repositories ────────────────────────────────────────────────────────────

/** GET /github/repos - List repos for an owner from the active GitHub source.
 *  Source resolution (App installation / gh CLI / user token) lives in ONE
 *  place — the GitHubSource adapter (createGitHubSource) — so this and
 *  listOrgRepos can't drift. null = no usable GitHub source → 400. */
export async function listRepos(c: Context) {
  const ctx = getRequestContext(c);
  const owner = c.req.query("owner");
  const repos = await (await createGitHubSource(ctx)).listReposForOwner(owner || undefined);
  if (repos === null) return c.json({ error: "Not connected to GitHub" }, 400);
  const allowed = await filterAllowedRepos(ctx, repos, repoKey);
  return c.json(paginateRepoList(allowed, parseRepoListParams(c)));
}

/** GET /github/orgs/:org/repos - List repos for an organisation.
 *  Same GitHubSource adapter as listRepos. */
export async function listOrgRepos(c: Context) {
  const ctx = getRequestContext(c);
  const org = param(c, "org");
  const repos = await (await createGitHubSource(ctx)).listReposForOwner(org);
  if (repos === null) return c.json({ error: "Not connected to GitHub" }, 400);
  const allowed = await filterAllowedRepos(ctx, repos, repoKey);
  return c.json(paginateRepoList(allowed, parseRepoListParams(c)));
}

/** Parse the repo-list query (page/perPage/search/visibility/sort). All
 *  optional: with no `perPage` the response is the full filtered set (+counts),
 *  so the MCP `list repos` tool and legacy callers are unaffected. */
function parseRepoListParams(c: Context): RepoListParams {
  const num = (raw?: string) => {
    const n = Number(raw);
    return raw && Number.isFinite(n) ? n : undefined;
  };
  const visibility = c.req.query("visibility");
  const sort = c.req.query("sort");
  return {
    page: num(c.req.query("page")),
    perPage: num(c.req.query("perPage")),
    search: c.req.query("search") || undefined,
    visibility:
      visibility === "public" || visibility === "private" || visibility === "all"
        ? visibility
        : undefined,
    sort: sort === "name" || sort === "stars" || sort === "updated" ? sort : undefined,
  };
}

/** GET /github/repos/:owner/:repo - Get a single repository */
export async function getRepo(c: Context) {
  const ctx = getRequestContext(c);
  const owner = param(c, "owner");
  const repo = param(c, "repo");
  const withBranches = c.req.query("branches") === "true";

  const data = await githubService.getRepository(ctx, owner, repo, {
    withBranches,
  });
  return c.json({ data });
}

/** POST /github/repos - Create a new repository */
export async function createRepo(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req.json();

  const data = await githubService.createRepository(ctx, body.name, {
    description: body.description,
    private: body.private,
    owner: body.owner,
      });

  if (ctx.organizationId) {
    audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
      eventType: "github.repo.create",
      resourceType: "github",
      resourceId: (data as { full_name?: string })?.full_name ?? body.name,
      after: { name: body.name, owner: body.owner, private: !!body.private },
    });
  }

  return c.json({ data }, 201);
}

/** DELETE /github/repos/:owner/:repo - Delete a repository */
export async function deleteRepo(c: Context) {
  const ctx = getRequestContext(c);
  const owner = param(c, "owner");
  const repo = param(c, "repo");

  await githubService.deleteRepository(ctx, owner, repo);

  if (ctx.organizationId) {
    audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
      eventType: "github.repo.delete",
      resourceType: "github",
      resourceId: `${owner}/${repo}`,
      before: { owner, repo },
    });
  }

  return c.json({ success: true });
}

// ─── Branches ────────────────────────────────────────────────────────────────

/** GET /github/repos/:owner/:repo/branches - List branches */
export async function listBranches(c: Context) {
  const ctx = getRequestContext(c);
  const owner = param(c, "owner");
  const repo = param(c, "repo");

  const data = await githubService.listBranches(ctx, owner, repo);
  return c.json({ data });
}

/**
 * GET /github/repos/:owner/:repo/clone-token - mint a short-lived GitHub App
 * installation token and return a ready-to-run `git clone` command for the
 * repo.
 *
 * Cloud / GitHub-App mode only: gh-CLI and PAT modes have no installation
 * token, so this 409s there. The token is installation-scoped (the same
 * credential the build pipeline clones with) and expires within the hour.
 */
export async function getCloneToken(c: Context) {
  const ctx = getRequestContext(c);
  const owner = param(c, "owner");
  const repo = param(c, "repo");

  // Narrow the token to THIS repo. An installation token otherwise reaches every
  // repo the installation covers, so a caller granted one repo would walk away
  // with an owner-wide credential — broader than their grant, and long-lived
  // enough to matter. The route also requires `content-whole`, because a clone
  // cannot be path-filtered.
  const token = await githubAuth.getInstallationToken(ctx, owner, undefined, {
    repositories: [repo],
  });
  if (!token) {
    return c.json(
      {
        error:
          "No GitHub App installation token is available for this owner. Connect the Openship GitHub App (cloud) for this account to use a clone token.",
      },
      409,
    );
  }

  const cloneUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
  return c.json({ token, cloneUrl, command: `git clone ${cloneUrl}` });
}

// ─── Stack detection ─────────────────────────────────────────────────────────

/**
 * GET /github/repos/:owner/:repo/detect — derived build config, no file bytes.
 *
 * This is what makes deploy-only access usable. Detecting a stack previously meant
 * the caller reading `package.json`, `docker-compose.yml` and friends through the
 * content endpoints — so any agent that needed to configure a deploy needed
 * permission to crawl the whole repo. Here the server does the reading and returns
 * only its CONCLUSIONS, so the route sits at metadata tier.
 *
 * Reuses `resolveProjectInfo` (the same resolver the deploy pipeline runs) and
 * `projectInfoToScanResponse` (the shared mapping behind the local-folder and
 * folder-upload scans). Reusing the latter is what keeps this safe AND consistent:
 * it already masks env values — repo `.env` contents via `maskEnv` and compose
 * `environment` blocks via `maskScanService` — so detect cannot become a
 * side-channel for the content it replaces, and the wizard gets a payload shape
 * identical to the one it already consumes.
 */
export async function detectStack(c: Context) {
  const ctx = getRequestContext(c);
  const owner = param(c, "owner");
  const repo = param(c, "repo");
  const branch = c.req.query("branch")?.trim();
  const composePath = c.req.query("composePath")?.trim();

  const info = await resolveProjectInfo({
    source: "github",
    owner,
    repo,
    ctx,
    ...(branch ? { branch } : {}),
    ...(composePath ? { composePath } : {}),
  });

  return c.json({ data: projectInfoToScanResponse(info) });
}

// ─── Files ───────────────────────────────────────────────────────────────────

/** GET /github/repos/:owner/:repo/files - List files in a directory */
export async function listFiles(c: Context) {
  const ctx = getRequestContext(c);
  const owner = param(c, "owner");
  const repo = param(c, "repo");
  const branch = c.req.query("branch");
  // The NORMALISED path the middleware authorised (see getFile) — never the raw
  // `?path=`, so the directory checked is the directory listed. "" is the repo
  // root, which is what /files with no path lists.
  const path = c.get("sourcePath") as string | undefined;

  const data = await githubService.listFiles(ctx, owner, repo, {
    branch: branch ?? undefined,
    path: path || undefined,
      });

  // Filter to what this caller's source scope permits. The route declares
  // `source: "content-tree"`, so the permission middleware already resolved the
  // allow-list and stashed it — reuse it rather than resolving the grant twice.
  //
  // The middleware only proved this directory LEADS somewhere granted; without
  // filtering, listing the root under a `src/**` grant would return every
  // top-level name. Absent stash ⇒ empty list ⇒ nothing visible (fail closed).
  const readPaths = (c.get("sourceReadPaths") as string[] | undefined) ?? [];

  // GitHub's contents API returns a single OBJECT — the blob, base64 content
  // included — when `path` names a FILE rather than a directory. So this endpoint
  // can serve content, and `.filter` on a non-array would throw. `project-reader`
  // guards the same shape. Normalise to an array, and treat the single-file case
  // as a FILE so it must be granted outright rather than merely being an ancestor
  // of something granted (which is all the `content-tree` tier proved).
  const isDir = Array.isArray(data);
  const entries = isDir ? data : [data as unknown as (typeof data)[number]];
  const visible = filterTreeEntries(entries, readPaths, (entry) => ({
    path: entry.path,
    isDirectory: isDir ? entry.type === "dir" : false,
  }));

  // Preserve the response shape: an array for a directory, the entry itself for a
  // file. A file the caller may not see is absent, not empty — same IDOR-safe 404
  // convention the permission middleware uses.
  if (!isDir) {
    if (visible.length === 0) {
      return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
    }
    return c.json({ data: visible[0] });
  }
  return c.json({ data: visible });
}

/**
 * GET /github/repos/:owner/:repo/tree — the whole tree, flat and recursive.
 *
 * Powers the path picker in the source-access modal: choosing which paths a grant
 * covers is not something anyone should do by typing globs blind. One recursive
 * fetch lets the client build a collapsible tree AND search it without a request
 * per directory.
 *
 * Filtered by the CALLER's own read paths, which is what stops this becoming a
 * way to enumerate a repo you can't read: an org owner sees everything, and a
 * member granting access to someone else can only ever offer paths they hold
 * themselves. `listRepositoryTree` handles GitHub's truncation for huge repos.
 */
export async function listTree(c: Context) {
  const ctx = getRequestContext(c);
  const owner = param(c, "owner");
  const repo = param(c, "repo");
  const branch = c.req.query("branch")?.trim();

  const entries = await githubService.listRepositoryTree(
    ctx,
    owner,
    repo,
    branch ? { branch } : {},
  );

  const readPaths = (c.get("sourceReadPaths") as string[] | undefined) ?? [];
  const visible = filterTreeEntries(entries, readPaths, (entry) => ({
    path: entry.path,
    isDirectory: entry.type === "dir",
  }));
  return c.json({ data: visible });
}

/** GET /github/repos/:owner/:repo/file - Get a single file's content */
export async function getFile(c: Context) {
  const ctx = getRequestContext(c);
  const owner = param(c, "owner");
  const repo = param(c, "repo");
  const branch = c.req.query("branch");
  // Required, not defaulted. The permission middleware authorises the path in
  // `?file=`; an implicit fallback here would mean the check and the read could
  // disagree — a caller granted only `package.json` would be denied for the root
  // while the handler went on to serve package.json anyway.
  //
  // Read the NORMALISED path the middleware authorised, not the raw query param,
  // so the string checked and the string fetched are the same one. Absent stash ⇒
  // the tier gate did not run ⇒ refuse rather than fall back to the raw value
  // (fail closed: a route mounted without `source` must not serve content here).
  const file = c.get("sourcePath") as string | undefined;
  if (!file) {
    return c.json(
      { error: "Query parameter `file` is required", code: "FILE_PARAM_REQUIRED" },
      400,
    );
  }

  const data = await githubService.getFileContent(ctx, owner, repo, file, {
    branch: branch ?? undefined,
    json: file.endsWith(".json"),
      });
  return c.json({ data });
}

// ─── Webhooks ────────────────────────────────────────────────────────────────

/** GET /github/repos/:owner/:repo/webhooks - List repo webhooks */
export async function listWebhooks(c: Context) {
  const ctx = getRequestContext(c);
  const owner = param(c, "owner");
  const repo = param(c, "repo");

  const data = await githubService.listWebhooks(ctx, owner, repo);
  return c.json({ data });
}

/** POST /github/repos/:owner/:repo/webhooks - Register a webhook (create or find existing) */
export async function registerWebhook(c: Context) {
  const ctx = getRequestContext(c);
  const userId = ctx.userId;
  const organizationId = ctx.organizationId;
  const owner = param(c, "owner");
  const repo = param(c, "repo");

  const data = await githubService.registerWebhook(ctx, owner, repo);

  if (organizationId) {
    audit.recordAsync(auditContextFrom(c, organizationId, userId), {
      eventType: "github.webhook.register",
      resourceType: "github",
      resourceId: `${owner}/${repo}`,
      after: {
        owner,
        repo,
        hookId: (data as { id?: number | string })?.id ?? null,
      },
    });
  }

  return c.json({ data });
}

/** DELETE /github/repos/:owner/:repo/webhooks - Delete a webhook */
export async function deleteWebhook(c: Context) {
  const ctx = getRequestContext(c);
  const owner = param(c, "owner");
  const repo = param(c, "repo");
  const body = await c.req.json();

  if (!body.hookId) {
    return c.json({ error: "hookId is required" }, 400);
  }

  await githubService.deleteWebhook(ctx, owner, repo, body.hookId);

  if (ctx.organizationId) {
    audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
      eventType: "github.webhook.delete",
      resourceType: "github",
      resourceId: `${owner}/${repo}`,
      before: { owner, repo, hookId: body.hookId },
    });
  }
  return c.json({ success: true });
}
