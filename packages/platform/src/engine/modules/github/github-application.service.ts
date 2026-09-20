import { instanceAuthorization } from "../../lib/instance-authorization";
import { assertCloudTenantScope } from "../../lib/cloud/scope";
/**
 * GitHub application operations, retained from the HTTP controller.
 *
 * HTTP and native adapters share these flows, connection state, and presentation.
 * Provider transport remains in the existing service/auth functions.
 */

import type { ExecutionContext } from "../../../context";
import type { GitHubOperations } from "@repo/contracts";
import { AppError, NotFoundError, normalizeRepoPath } from "@repo/core";
import { checkSourceTier } from "./github-access";
import { env } from "@repo/platform/engine/config/env";
import { audit, operationAuditContext } from "../../lib/audit-emitter";
import * as githubAuth from "@repo/platform/engine/modules/github/github.auth";
import * as githubService from "@repo/platform/engine/modules/github/github.service";
import { createGitHubSource } from "@repo/platform/engine/modules/github/sources/index";
import { filterAllowedRepos, filterAllowedAccounts, filterTreeEntries } from "@repo/platform/engine/modules/github/github-access";
import { resolveProjectInfo, projectInfoToScanResponse } from "@repo/platform/engine/modules/deployments/prepare.service";
import { paginateRepoList, type RepoListParams } from "@repo/platform/engine/modules/github/repo-list";
import { hasConfiguredGitHubSource } from "@repo/platform/engine/modules/github/github-source.service";

/** Map a MappedRepository to the owner/repo key the access filter needs.
 *  `full_name` is canonically "owner/repo"; fall back to the discrete
 *  fields when it's absent. `||` (not `??`) so an empty split segment
 *  ("" from a missing full_name) falls through instead of sticking. */
function repoKey(r: { full_name?: string; owner?: string; name?: string }) {
  const [owner, repo] = (r.full_name ?? "").split("/");
  return { owner: owner || r.owner || "", repo: repo || r.name || "" };
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
export async function getStatus(ctx: ExecutionContext) {
  const source = await createGitHubSource(ctx);
  // The Settings card owns the "Install App" affordance, so the install URL is
  // resolved HERE (cloud round-trip in cloud-app mode), alongside the real App
  // status + installs. Members still only see App accounts they're granted.
  const [{ state, accounts }, install, customSourcesConfigured] = await Promise.all([
    source.getConnectionStatus(),
    source.resolveInstallUrl(),
    hasConfiguredGitHubSource(ctx.organizationId).catch(() => false),
  ]);
  const allowedAccounts = await filterAllowedAccounts(ctx, accounts, (a) => a.login);
  // Connect methods, derived server-side from the SAME chain table that resolves
  // credentials. The dashboard used to decide this itself from `selfHosted` /
  // `deployMode`, which is how it ended up offering a forwarding toggle that could
  // never take effect and a Cloud App row on a box with no cloud link.
  const { resolveGitHubCapabilities } = await import("@repo/platform/engine/modules/github/github.capabilities");
  const { isCloudConnected } = await import("@repo/platform/engine/lib/cloud/session");
  const capabilities = await resolveGitHubCapabilities(ctx, {
    cloudConnected: await isCloudConnected(ctx.userId).catch(() => false),
  }).catch(() => null);
  return {
    state,
    accounts: allowedAccounts,
    installUrl: install.url,
    cloudUnreachable: install.cloudUnreachable ?? false,
    // Management metadata, deliberately separate from the canonical auth
    // state. It remains true for an invalid source so the dashboard never
    // offers the unrelated legacy App connect/disconnect flow in its place.
    customSourcesConfigured,
    capabilities,
  };
}

/**
 * GET /github/home — canonical state plus accounts and repos visible from
 * the active source(s). The install URL is offered whenever the App is
 * an option for this user (any non-CLOUD_MODE-only install ships the App
 * install URL so the dashboard can prompt "install on this org").
 */
export async function getHome(ctx: ExecutionContext) {
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
  const { resolveGitHubCapabilities } = await import("@repo/platform/engine/modules/github/github.capabilities");
  const { isCloudConnected } = await import("@repo/platform/engine/lib/cloud/session");
  const capabilities = await resolveGitHubCapabilities(ctx, {
    cloudConnected: await isCloudConnected(ctx.userId).catch(() => false),
  }).catch(() => null);

  return {
    ...data,
    accounts,
    repos,
    installUrl,
    // cloud-app mode + SaaS down: the card shows "Openship Cloud
    // unreachable" instead of a dead install button (installUrl is "").
    cloudUnreachable,
    capabilities,
  };
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
export async function connect(ctx: ExecutionContext, input: NonNullable<Parameters<GitHubOperations["connect"]>[0]>) {
  const userId = ctx.userId;
  // Per-user resolution — picks "cloud-app" when self-hosted + cloud-
  // connected, otherwise falls back to the static mode. Every branch
  // below sees the actual mode this user should use.
  let mode = await githubAuth.resolveGitHubAuthMode(ctx);
  if (mode === "cloud-app") assertCloudTenantScope(ctx);

  // Optional `source` discriminator from the dashboard's dual-source
  // (Openship App vs gh CLI) settings panel. When the user explicitly
  // clicks "Connect Openship App", source="oauth" forces the App
  // install flow regardless of whether gh CLI is already authenticated;
  // otherwise the two buttons would be indistinguishable to the server
  // and both would short-circuit on the cli token.
  const body = input;
  const source =
    body && typeof body === "object" && "source" in body
      ? (body.source as "oauth" | "cli" | undefined)
      : undefined;

  if (source === "cli" || (mode === "cli" && source !== "oauth"))
    await instanceAuthorization.assert(ctx, "write");

  // ── Explicit CLI un-suppress (applies in any mode) ───────────────
  // User clicked "Use gh CLI" — they want the prior Disconnect
  // suppression flag cleared so openship reads `gh auth token` again.
  // This MUST run before the mode-based branches below; otherwise in
  // cloud-app mode it would never fire (we'd return the App install
  // URL and the flag would stay set forever).
  //
  // Explicitly selecting CLI must stay a CLI flow even when a custom source
  // makes the workspace's composite mode report "app". Otherwise this button
  // unexpectedly opens the App installation flow. SaaS never exposes the local
  // method, so its canonical App mode remains immutable.
  if (source === "cli") {
    const { setGithubCliDisabled, setGhCliOperatorOptedIn } = await import("@repo/platform/engine/modules/settings/settings.service");
    await setGithubCliDisabled(userId, false);
    await setGhCliOperatorOptedIn(userId, true);
    if (!env.CLOUD_MODE) mode = "cli";
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
  //      install URL (also from cloud-client). The public Setup callback
  //      validates its durable user/workspace nonce, the user's GitHub token,
  //      and the Openship App JWT before atomically claiming the installation.
  //
  // The frontend keeps clicking Connect; the server's response (`step`)
  // tells it which UI to show ("connecting GitHub" vs "installing App").
  if (mode === "cloud-app") {
    const status = await githubAuth.getUserStatus(userId, ctx);

    // Step 1: GitHub OAuth via SaaS. The Connect button does this FIRST.
    // Returning the install URL before OAuth is broken — the webhook
    // can't attribute the install to a SaaS user without the account
    // row, and the install becomes orphaned on github.com.
    if (!status.connected) {
      const oauth = await githubAuth.resolveOauthHandoffUrl(userId);
      if (oauth) {
        return {
          connected: false,
          flow: "redirect" as const,
          url: oauth.url,
          step: "oauth" as const,
        };
      }
      // SaaS-only mode: the OAuth handoff URL comes from openship.io. A
      // null here means the SaaS is unreachable. We must NOT degrade to a
      // stateless github.com install link — that skips the OAuth step the
      // webhook needs and orphans the install. Tell the user the truth.
      throw responseError(CLOUD_UNREACHABLE_CONNECT, 503);
    }

    // Step 2: OAuth done. Check if installations already exist.
    if (status.connected) {
      const installations = await githubAuth.getUserInstallations(ctx, status);
      if (installations.length > 0 && source !== "oauth") {
        return { connected: true };
      }
    }

    // Step 2 continued: no installations yet → return install URL.
    const install = await githubAuth.resolveInstallUrl(ctx);
    if (install.cloudUnreachable) {
      throw responseError(CLOUD_UNREACHABLE_CONNECT, 503);
    }
    return {
      connected: false,
      flow: "redirect" as const,
      url: install.url,
      state: install.state,
      step: "install" as const,
    };
  }

  // Clicking Connect always means "I want to be connected" - clear any
  // prior cli-suppression flag from a previous Disconnect so the status
  // check below can resolve via the gh CLI fallback if it's available.
  // Skip this when the user explicitly chose the App source — we don't
  // want to silently re-enable cli when they're trying to add the App.
  if (mode === "cli" && source !== "oauth") {
    const { setGithubCliDisabled } = await import("@repo/platform/engine/modules/settings/settings.service");
    await setGithubCliDisabled(userId, false);
  }
  const status =
    source === "cli" && !env.CLOUD_MODE
      ? await import("@repo/platform/engine/modules/github/github.local-auth").then(async ({ getLocalGhStatus }) => {
          const local = await getLocalGhStatus();
          return { connected: local.available };
        })
      : await githubAuth.getUserStatus(userId, ctx);

  // ── Explicit App-source request (overrides mode-based routing) ────
  // In cli mode the dashboard shows TWO connect buttons (App + CLI).
  // When the user clicked the App button, ALWAYS run the App install
  // flow — return the install URL (and, if OAuth is missing, kick the
  // OAuth-then-install dance via the redirect endpoint).
  if (source === "oauth") {
    if (!status.connected) {
      // OAuth not present yet — the redirect endpoint will do
      // linkSocialAccount then callbackURL=/auth/callback/install. Mint the
      // workspace-bound install state BEFORE OAuth and carry it through that
      // callback, so a topology that lands on the API callback route never
      // degrades to a stateless GitHub installation URL.
      const install = mode === "app" ? await githubAuth.resolveInstallUrl(ctx) : { state: "" };
      const redirectUrl = install.state
        ? `/api/github/connect/redirect?install_state=${encodeURIComponent(install.state)}`
        : undefined;
      return {
        connected: false,
        flow: "redirect" as const,
        ...(redirectUrl ? { url: redirectUrl } : {}),
      };
    }
    const installations = await githubAuth.getUserInstallations(ctx, status);
    if (installations.length > 0) {
      return { connected: true };
    }
    const { url } = await githubAuth.resolveInstallUrl(ctx);
    return {
      connected: false,
      flow: "redirect" as const,
      url,
    };
  }

  // ── Already connected? ─────────────────────────────────────
  if (mode === "token" && status.connected) {
    return { connected: true };
  }

  if (mode === "cli") {
    if (status.connected) {
      return { connected: true };
    }
  }

  if (mode === "oauth" && status.connected) {
    return { connected: true };
  }

  if (mode === "app" && status.connected) {
    const installations = await githubAuth.getUserInstallations(ctx, status);
    if (installations.length > 0) {
      return { connected: true };
    }

    const { url } = await githubAuth.resolveInstallUrl(ctx);
    return {
      connected: false,
      flow: "redirect" as const,
      url,
    };
  }

  // ── CLI: no token yet ──────────────────────────────────────
  if (mode === "cli") {
    // Dynamic import: gh device flow is self-hosted only; never on the SaaS.
    const { startDeviceFlow, deviceFlowAvailable } = await import("@repo/platform/engine/modules/github/github.local-auth");

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
      return {
        connected: false,
        flow: "token" as const,
        command: "gh auth login",
        message:
          "Paste a GitHub token to connect this instance. " +
          "Needs the `repo` scope (add `read:org` to see organization repos).",
      };
    }
    try {
      // Completing a device sign-in is the same explicit operator act as pasting a
      // token, so record the opt-in up front — otherwise the finished sign-in
      // stores a credential tokenFor refuses to use.
      const settingsService = await import("@repo/platform/engine/modules/settings/settings.service");
      await settingsService.setGhCliOperatorOptedIn(userId, true);
      const verification = await startDeviceFlow(ctx);
      return {
        connected: false,
        flow: "device_code" as const,
        userCode: verification.user_code,
        verificationUri: verification.verification_uri,
        expiresIn: verification.expires_in,
        interval: verification.interval,
      };
    } catch (err) {
      throw responseError({ connected: false, error: (err as Error).message }, 500);
    }
  }

  // ── Token mode with no token ───────────────────────────────
  if (mode === "token") {
    return {
      connected: false,
      flow: "terminal" as const,
      command: "GITHUB_TOKEN=ghp_... (set in environment)",
      message: "Set the GITHUB_TOKEN environment variable and restart the server.",
    };
  }

  // ── App / OAuth: need GitHub OAuth → tell frontend to open the redirect popup ──
  // Local App mode must preserve an authenticated workspace binding across the
  // OAuth round-trip. OAuth-only mode has no installation callback and needs no
  // install state.
  const install = mode === "app" ? await githubAuth.resolveInstallUrl(ctx) : { state: "" };
  const redirectUrl = install.state
    ? `/api/github/connect/redirect?install_state=${encodeURIComponent(install.state)}`
    : undefined;
  return {
    connected: false,
    flow: "redirect" as const,
    ...(redirectUrl ? { url: redirectUrl } : {}),
  };
}

/** POST /github/installations/claim — finalize a self-hosted App setup redirect. */
export async function claimInstallation(ctx: ExecutionContext, input: NonNullable<Parameters<GitHubOperations["claimInstallation"]>[0]>) {
  const body = input;
  const { claimLocalGitHubInstallation } = await import("@repo/platform/engine/modules/github/github.installation-claim");
  const result = await claimLocalGitHubInstallation(ctx, body);
  switch (result.kind) {
    case "ok":
      return { ok: true, installation: result.installation };
    case "pending-approval":
      return { ok: true, pendingApproval: true };
    case "invalid":
      throw responseError({ error: "invalid_installation_claim", message: result.message }, 400);
    case "forbidden":
      throw responseError({ error: "installation_claim_forbidden", message: result.message }, 403);
    case "failed":
      throw responseError({ error: "installation_claim_failed", message: result.message }, 502);
  }
}

/** GET /github/local-status - Check if the machine has `gh` CLI auth available.
 *  Gated by `localOnly` middleware - never reaches this handler in cloud modes.
 */
export async function getLocalStatus(ctx: ExecutionContext) {
  const { getLocalGhStatus } = await import("@repo/platform/engine/modules/github/github.local-auth");
  const localStatus = await getLocalGhStatus();
  return {
    ...localStatus,
    activeMode: githubAuth.getGitHubAuthMode(),
  };
}

/** GET /github/connect/poll - Poll the device flow status.
 *  Gated by `localOnly` middleware.
 */
export async function pollConnect(ctx: ExecutionContext) {
  const { getDeviceFlowStatus } = await import("@repo/platform/engine/modules/github/github.local-auth");
  const status = getDeviceFlowStatus(ctx.userId);
  if (!status) {
    return { status: "none" as const };
  }
  // NEVER return the access token to the browser. On completion the device flow
  // has already persisted it server-side (startDeviceFlow → gh-cli token store);
  // the client only needs the status. Returning `status` verbatim here leaked the
  // token onto the wire (and into any client logging). Strip it.
  const { token: _token, ...safe } = status;
  return safe;
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
export async function setInstanceToken(ctx: ExecutionContext, input: NonNullable<Parameters<GitHubOperations["setInstanceToken"]>[0]>) {
  if (env.CLOUD_MODE) {
    throw responseError({ error: "Not available on Openship Cloud", code: "NOT_SUPPORTED" }, 400);
  }
  const body = input;
  const token = body?.token?.trim();
  if (!token) {
    throw responseError({ error: "token is required", code: "INVALID_TOKEN" }, 400);
  }

  let report: Awaited<ReturnType<typeof githubService.inspectPatScope>>;
  try {
    report = await githubService.inspectPatScope(token);
  } catch (err) {
    throw responseError({
        error: err instanceof Error ? err.message : "Could not validate token",
        code: "INVALID_TOKEN",
      }, 400);
  }
  const verdict = githubService.classifyPatScope(report);
  if (!verdict.ok) {
    throw responseError({ error: verdict.reason, code: "INSUFFICIENT_SCOPE" }, 400);
  }

  const { setStoredDeviceToken, cancelInstanceDeviceFlows } = await import("@repo/platform/engine/modules/github/github.local-auth");
  await cancelInstanceDeviceFlows();
  await setStoredDeviceToken(token, "token");
  // Sweep this user's cached GitHub state so /status and the importer see the new
  // identity on the NEXT read. Without it the connection only appeared after the
  // cached verdict aged out — i.e. "I added a token but New Project still fails".
  await githubAuth.invalidateUserGitHubCache(ctx.userId);
  // Clicking connect means "I want to be connected" — clear any prior
  // Disconnect suppression, same as the interactive connect path does.
  const settingsService = await import("@repo/platform/engine/modules/settings/settings.service");
  await settingsService.setGithubCliDisabled(ctx.userId, false);
  // …and record the operator opt-in `tokenFor` gates the stored-credential branch
  // on. Nothing ever set that flag, so a pasted token was stored, the UI said
  // "Connected", and the next deploy still reported "no App/PAT token is
  // available". Pasting a credential into Openship IS the explicit act the flag
  // was designed to capture.
  await settingsService.setGhCliOperatorOptedIn(ctx.userId, true);

  if (ctx.organizationId) {
    audit.recordAsync(operationAuditContext(ctx), {
      eventType: "github.instance_token.set",
      resourceType: "github",
      resourceId: "*",
      // Login + scopes only. The token itself must never reach the audit log.
      after: { login: report.user, scopes: report.scopes },
    });
  }

  return { connected: true, login: report.user, warning: verdict.warning };
}

/**
 * POST /github/disconnect - Disconnect from one source (or both).
 *
 * Body / query: { source?: "oauth" | "cli" | "all" }   (default "all")
 *
 * Doesn't uninstall the GitHub App - that happens via webhook only.
 */
export async function disconnect(ctx: ExecutionContext, input: NonNullable<Parameters<GitHubOperations["disconnect"]>[0]>) {
  const rawSource = input.source;
  const source: "oauth" | "cli" | "all" =
    rawSource === "oauth" || rawSource === "cli" || rawSource === "all" ? rawSource : "all";
  if (!env.CLOUD_MODE && source !== "oauth") await instanceAuthorization.assert(ctx, "write");
  await githubAuth.disconnectUser(ctx.userId, source);
  if (ctx.organizationId) {
    audit.recordAsync(operationAuditContext(ctx), {
      eventType: "github.disconnect",
      resourceType: "github",
      resourceId: "*",
      after: { source },
    });
  }
  return { success: true, source };
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
export async function listRepos(ctx: ExecutionContext, input: NonNullable<Parameters<GitHubOperations["listRepos"]>[0]>) {
  const owner = input.owner;
  const repos = await (await createGitHubSource(ctx)).listReposForOwner(owner || undefined);
  if (repos === null) throw responseError({ error: "Not connected to GitHub" }, 400);
  const allowed = await filterAllowedRepos(ctx, repos, repoKey);
  return paginateRepoList(allowed, input);
}

/** GET /github/orgs/:org/repos - List repos for an organisation.
 *  Same GitHubSource adapter as listRepos. */
export async function listOrgRepos(ctx: ExecutionContext, input: NonNullable<Parameters<GitHubOperations["listOrgRepos"]>[0]>) {
  const org = input.org;
  const repos = await (await createGitHubSource(ctx)).listReposForOwner(org);
  if (repos === null) throw responseError({ error: "Not connected to GitHub" }, 400);
  const allowed = await filterAllowedRepos(ctx, repos, repoKey);
  return paginateRepoList(allowed, input);
}

/** GET /github/repos/:owner/:repo - Get a single repository */
export async function getRepo(ctx: ExecutionContext, input: NonNullable<Parameters<GitHubOperations["getRepo"]>[0]>) {
  const owner = input.owner;
  const repo = input.repo;
  const withBranches = input.branches;

  const data = await githubService.getRepository(ctx, owner, repo, {
    withBranches,
  });
  return data;
}

/** POST /github/repos - Create a new repository */
export async function createRepo(ctx: ExecutionContext, input: NonNullable<Parameters<GitHubOperations["createRepo"]>[0]>) {
  const body = input;

  const data = await githubService.createRepository(ctx, body.name, {
    description: body.description,
    private: body.private,
    owner: body.owner,
  });

  if (ctx.organizationId) {
    audit.recordAsync(operationAuditContext(ctx), {
      eventType: "github.repo.create",
      resourceType: "github",
      resourceId: (data as { full_name?: string })?.full_name ?? body.name,
      after: { name: body.name, owner: body.owner, private: !!body.private },
    });
  }

  return data;
}

/** DELETE /github/repos/:owner/:repo - Delete a repository */
export async function deleteRepo(ctx: ExecutionContext, input: NonNullable<Parameters<GitHubOperations["deleteRepo"]>[0]>) {
  const owner = input.owner;
  const repo = input.repo;

  await githubService.deleteRepository(ctx, owner, repo);

  if (ctx.organizationId) {
    audit.recordAsync(operationAuditContext(ctx), {
      eventType: "github.repo.delete",
      resourceType: "github",
      resourceId: `${owner}/${repo}`,
      before: { owner, repo },
    });
  }

  return { success: true };
}

// ─── Branches ────────────────────────────────────────────────────────────────

/** GET /github/repos/:owner/:repo/branches - List branches */
export async function listBranches(ctx: ExecutionContext, input: NonNullable<Parameters<GitHubOperations["listBranches"]>[0]>) {
  const owner = input.owner;
  const repo = input.repo;

  const { branches, page, perPage, hasMore } = await githubService.listBranches(ctx, owner, repo, input);
  return { data: branches, pagination: { page, perPage, hasMore } };
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
export async function getCloneToken(ctx: ExecutionContext, input: NonNullable<Parameters<GitHubOperations["getCloneToken"]>[0]>) {
  const owner = input.owner;
  const repo = input.repo;

  await authorizedSource(ctx, input, "content-whole", "");

  // Narrow the token to THIS repo. An installation token otherwise reaches every
  // repo the installation covers, so a caller granted one repo would walk away
  // with an owner-wide credential — broader than their grant, and long-lived
  // enough to matter. The route also requires `content-whole`, because a clone
  // cannot be path-filtered.
  const token = await githubAuth.getInstallationToken(ctx, owner, undefined, {
    repositories: [repo],
  });
  if (!token) {
    throw responseError({
        error:
          "No GitHub App installation token is available for this owner. Connect the Openship GitHub App (cloud) for this account to use a clone token.",
      }, 409);
  }

  const { resolveGitHubWebBaseUrl } = await import("@repo/platform/engine/modules/github/github-source.service");
  const webBaseUrl =
    (await resolveGitHubWebBaseUrl(ctx.organizationId, owner).catch(() => null)) ??
    "https://github.com";
  const cloneOrigin = webBaseUrl.replace(/^https:\/\//, "").replace(/\/+$/, "");
  const cloneUrl = `https://x-access-token:${token}@${cloneOrigin}/${owner}/${repo}.git`;
  return { token, cloneUrl, command: `git clone ${cloneUrl}` };
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
export async function detectStack(ctx: ExecutionContext, input: NonNullable<Parameters<GitHubOperations["detectStack"]>[0]>) {
  const owner = input.owner;
  const repo = input.repo;
  const branch = input.branch?.trim();
  const composePath = input.composePath?.trim();

  const info = await resolveProjectInfo({
    source: "github",
    owner,
    repo,
    ctx,
    ...(branch ? { branch } : {}),
    ...(composePath ? { composePath } : {}),
  });

  return projectInfoToScanResponse(info);
}

// ─── Files ───────────────────────────────────────────────────────────────────

/** GET /github/repos/:owner/:repo/files - List files in a directory */
export async function listFiles(ctx: ExecutionContext, input: NonNullable<Parameters<GitHubOperations["listFiles"]>[0]>) {
  const owner = input.owner;
  const repo = input.repo;
  const branch = input.branch;
  // The NORMALISED path the middleware authorised (see getFile) — never the raw
  // `?path=`, so the directory checked is the directory listed. "" is the repo
  // root, which is what /files with no path lists.
  const { path, readPaths } = await authorizedSource(ctx, input, "content-tree", input.path ?? "");

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
      throw responseError({ error: "Not found", code: "NOT_FOUND" }, 404);
    }
    return visible[0];
  }
  return visible;
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
export async function listTree(ctx: ExecutionContext, input: NonNullable<Parameters<GitHubOperations["listTree"]>[0]>) {
  const owner = input.owner;
  const repo = input.repo;
  const branch = input.branch?.trim();

  const { readPaths } = await authorizedSource(ctx, input, "content-tree", "");
  const entries = await githubService.listRepositoryTree(
    ctx,
    owner,
    repo,
    branch ? { branch } : {},
  );

  const visible = filterTreeEntries(entries, readPaths, (entry) => ({
    path: entry.path,
    isDirectory: entry.type === "dir",
  }));
  return visible;
}

/** GET /github/repos/:owner/:repo/file - Get a single file's content */
export async function getFile(ctx: ExecutionContext, input: NonNullable<Parameters<GitHubOperations["getFile"]>[0]>) {
  const owner = input.owner;
  const repo = input.repo;
  const branch = input.branch;
  // Required, not defaulted. The permission middleware authorises the path in
  // `?file=`; an implicit fallback here would mean the check and the read could
  // disagree — a caller granted only `package.json` would be denied for the root
  // while the handler went on to serve package.json anyway.
  //
  // Read the NORMALISED path the middleware authorised, not the raw query param,
  // so the string checked and the string fetched are the same one. Absent stash ⇒
  // the tier gate did not run ⇒ refuse rather than fall back to the raw value
  // (fail closed: a route mounted without `source` must not serve content here).
  const { path: file } = await authorizedSource(ctx, input, "content", input.file);
  if (!file) {
    throw responseError({ error: "Query parameter `file` is required", code: "FILE_PARAM_REQUIRED" }, 400);
  }

  const data = await githubService.getFileContent(ctx, owner, repo, file, {
    branch: branch ?? undefined,
    json: file.endsWith(".json"),
  });
  return data;
}

// ─── Webhooks ────────────────────────────────────────────────────────────────

/** GET /github/repos/:owner/:repo/webhooks - List repo webhooks */
export async function listWebhooks(ctx: ExecutionContext, input: NonNullable<Parameters<GitHubOperations["listWebhooks"]>[0]>) {
  const owner = input.owner;
  const repo = input.repo;

  const data = await githubService.listWebhooks(ctx, owner, repo);
  return data;
}

/** POST /github/repos/:owner/:repo/webhooks - Register a webhook (create or find existing) */
export async function registerWebhook(ctx: ExecutionContext, input: NonNullable<Parameters<GitHubOperations["registerWebhook"]>[0]>) {
  const userId = ctx.userId;
  const organizationId = ctx.organizationId;
  const owner = input.owner;
  const repo = input.repo;

  const data = await githubService.registerWebhook(ctx, owner, repo);

  if (organizationId) {
    audit.recordAsync(operationAuditContext(ctx), {
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

  return data;
}

/** DELETE /github/repos/:owner/:repo/webhooks - Delete a webhook */
export async function deleteWebhook(ctx: ExecutionContext, input: NonNullable<Parameters<GitHubOperations["deleteWebhook"]>[0]>) {
  const owner = input.owner;
  const repo = input.repo;
  const body = input;

  if (!body.hookId) {
    throw responseError({ error: "hookId is required" }, 400);
  }

  await githubService.deleteWebhook(ctx, owner, repo, body.hookId);

  if (ctx.organizationId) {
    audit.recordAsync(operationAuditContext(ctx), {
      eventType: "github.webhook.delete",
      resourceType: "github",
      resourceId: `${owner}/${repo}`,
      before: { owner, repo, hookId: body.hookId },
    });
  }
  return { success: true };
}

async function authorizedSource(ctx: ExecutionContext, target: { owner: string; repo: string }, tier: "content" | "content-tree" | "content-whole", raw: string) {
  const path = normalizeRepoPath(raw);
  if (path === null) throw new NotFoundError("github", target.owner + "/" + target.repo);
  const { ok, readPaths } = await checkSourceTier(ctx, target, tier, path);
  if (!ok) throw new NotFoundError("github", target.owner + "/" + target.repo + "/" + path);
  return { path, readPaths };
}
function responseError(body: { error?: string; message?: string; code?: string; connected?: boolean }, status: number): AppError {
  return new AppError(body.message ?? body.error ?? "GitHub operation failed", status, body.code ?? (status === 404 ? "NOT_FOUND" : status === 403 ? "FORBIDDEN" : "GITHUB_OPERATION_FAILED"));
}
