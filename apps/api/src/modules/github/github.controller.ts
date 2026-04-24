/**
 * GitHub controller — Hono request handlers.
 *
 * Every handler:
 *   1. Extracts user from context (set by authMiddleware)
 *   2. Validates params/query/body via TypeBox schemas (at the route level)
 *   3. Delegates to service/auth functions
 *   4. Returns a consistent JSON response
 *
 * No direct GitHub API calls here — that's the service's job.
 */

import type { Context } from "hono";
import { env } from "../../config/env";
import { auth } from "../../lib/auth";
import * as githubAuth from "./github.auth";
import * as localAuth from "./github.local-auth";
import * as githubService from "./github.service";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Extract authenticated user ID from Hono context (set by authMiddleware). */
function getUserId(c: Context): string {
  const user = c.get("user");
  return user?.id;
}

/** Safely extract a required route param. */
function param(c: Context, name: string): string {
  const val = c.req.param(name);
  if (!val) throw new Error(`Missing route param: ${name}`);
  return val;
}

// ─── Status / Connection ─────────────────────────────────────────────────────

/** GET /github/status — Check if user is connected to GitHub */
export async function getStatus(c: Context) {
  const userId = getUserId(c);
  const status = await githubAuth.getUserStatus(userId);
  return c.json({ ...status, mode: githubAuth.getGitHubAuthMode() });
}

/** GET /github/home — User's GitHub home: status + accounts + repos */
export async function getHome(c: Context) {
  const userId = getUserId(c);
  const data = await githubService.getUserHome(userId);
  const mode = githubAuth.getGitHubAuthMode();
  return c.json({
    ...data,
    selfHosted: !env.CLOUD_MODE,
    installUrl: mode === "app" ? githubAuth.getInstallUrl() : undefined,
  });
}

/** POST /github/connect — Normalized connection flow.
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
 *  The frontend is mode-agnostic — it just reacts to `flow`.
 */
export async function connect(c: Context) {
  const userId = getUserId(c);
  const mode = githubAuth.getGitHubAuthMode();
  const hasOAuth = !!(await githubAuth.getUserToken(userId));

  // ── Already connected? ─────────────────────────────────────
  if (mode === "token" && env.GITHUB_TOKEN) {
    return c.json({ connected: true });
  }

  if (mode === "cli") {
    const ghCliToken = await localAuth.getLocalGhToken();
    if (ghCliToken || hasOAuth) {
      return c.json({ connected: true });
    }
  }

  if ((mode === "app" || mode === "oauth") && hasOAuth) {
    return c.json({ connected: true });
  }

  // ── CLI: no token yet ──────────────────────────────────────
  if (mode === "cli") {
    // No GITHUB_CLIENT_ID → run `gh auth login` in terminal
    if (!env.GITHUB_CLIENT_ID) {
      return c.json({
        connected: false,
        flow: "terminal" as const,
        command: "gh auth login",
        message: "Run this command in your terminal, then click refresh.",
      });
    }
    // Has CLIENT_ID → start device flow
    try {
      const verification = await localAuth.startDeviceFlow(userId);
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

/** GET /github/connect/redirect — Direct browser navigation endpoint.
 *
 *  Instead of returning JSON (which is a cross-origin fetch that can't
 *  persist cookies in the popup's browsing context), this endpoint is
 *  navigated to directly by the popup window. It calls better-auth's
 *  linkSocialAccount, copies the state cookie to the response, and does a
 *  302 redirect to GitHub. The cookie lives in the popup's context so
 *  it's available when GitHub redirects back to the callback URL.
 */
export async function connectRedirect(c: Context) {
  const userId = getUserId(c);
  const mode = githubAuth.getGitHubAuthMode();

  const callbackURL = "/auth/callback/close";

  try {
    // Use linkSocialAccount (not signInSocial) because the user is already
    // authenticated — we want to attach GitHub to their existing account.
    const result = await auth.api.linkSocialAccount({
      body: {
        provider: "github",
        callbackURL,
      },
      headers: c.req.raw.headers,
      asResponse: true,
    });

    if (result instanceof Response) {
      // better-auth returns a Response with JSON body { url, redirect }
      // and Set-Cookie headers for the state. We need to:
      // 1. Read the URL from the JSON body
      // 2. Copy the Set-Cookie headers
      // 3. Return a real 302 redirect

      const cookies = result.headers.getSetCookie();
      
      // Try to get the redirect URL from the body
      let redirectUrl: string | null = null;
      try {
        const body = await result.json() as { url?: string };
        redirectUrl = body?.url ?? null;
      } catch {
        // If the response is already a redirect (3xx), use the Location header
        redirectUrl = result.headers.get("location");
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

/** GET /github/local-status — Check if the machine has `gh` CLI auth available.
 *  Gated by `localOnly` middleware — never reaches this handler in cloud modes.
 */
export async function getLocalStatus(c: Context) {
  const localStatus = await localAuth.getLocalGhStatus();
  return c.json({
    ...localStatus,
    activeMode: githubAuth.getGitHubAuthMode(),
  });
}

/** GET /github/connect/poll — Poll the device flow status.
 *  Gated by `localOnly` middleware.
 */
export async function pollConnect(c: Context) {
  const userId = getUserId(c);
  const status = localAuth.getDeviceFlowStatus(userId);
  if (!status) {
    return c.json({ status: "none" as const }, 404);
  }
  return c.json(status);
}

/** POST /github/disconnect — Disconnect GitHub (remove installations) */
export async function disconnect(c: Context) {
  const userId = getUserId(c);
  await githubAuth.disconnectUser(userId);
  return c.json({ success: true });
}

// ─── Accounts / Organisations ────────────────────────────────────────────────

/** GET /github/accounts — List connected GitHub accounts (user + orgs) */
export async function listAccounts(c: Context) {
  const userId = getUserId(c);
  const mode = githubAuth.getGitHubAuthMode();

  if (mode !== "app") {
    // Non-app modes: build account list from /user + /user/orgs
    const status = await githubAuth.getUserStatus(userId);
    if (!status.connected) return c.json({ data: [] });
    const accounts = await githubService.listUserAccounts(userId, status);
    return c.json({ data: accounts });
  }

  const installations = await githubAuth.getUserInstallations(userId);
  const accounts = githubAuth.mapAccounts(installations);
  return c.json({ data: accounts });
}

/** GET /github/orgs — List user's org accounts */
export async function listOrgs(c: Context) {
  const userId = getUserId(c);
  const mode = githubAuth.getGitHubAuthMode();

  if (mode !== "app") {
    const orgs = await githubService.listUserOrgsViaApi(userId);
    return c.json({ data: orgs });
  }

  const orgs = await githubService.listUserOrgs(userId);
  return c.json({ data: orgs });
}

/** GET /github/orgs/repos — List all orgs with their repos */
export async function listOrgsWithRepos(c: Context) {
  const userId = getUserId(c);
  const mode = githubAuth.getGitHubAuthMode();

  if (mode !== "app") {
    const data = await githubService.listUserOrgsWithReposViaApi(userId);
    return c.json({ data });
  }

  const data = await githubService.listUserOrgsWithRepos(userId);
  return c.json({ data });
}

// ─── Repositories ────────────────────────────────────────────────────────────

/** GET /github/repos — List repos (mode-aware) */
export async function listRepos(c: Context) {
  const userId = getUserId(c);
  const owner = c.req.query("owner");
  const mode = githubAuth.getGitHubAuthMode();

  if (mode !== "app") {
    // If the owner matches the authenticated user, fetch their own repos
    // (not /orgs/{owner}/repos which would 404 for a user account)
    const status = await githubAuth.getUserStatus(userId);
    const isOwnAccount = owner && status.connected && owner === status.login;
    const repos = await githubService.listUserOwnedRepos(userId, isOwnAccount ? undefined : (owner || undefined));
    return c.json({ data: repos });
  }

  // App mode: use GitHub App installation
  if (!owner) {
    const status = await githubAuth.getUserStatus(userId);
    if (!status.connected) {
      return c.json({ error: "Not connected to GitHub" }, 400);
    }
    const repos = await githubService.listInstallationRepos(userId, status.login);
    return c.json({ data: repos });
  }

  const repos = await githubService.listInstallationRepos(userId, owner);
  return c.json({ data: repos });
}

/** GET /github/orgs/:org/repos — List repos for an organisation */
export async function listOrgRepos(c: Context) {
  const userId = getUserId(c);
  const org = param(c, "org");
  const mode = githubAuth.getGitHubAuthMode();

  if (mode !== "app") {
    const repos = await githubService.listUserOwnedRepos(userId, org);
    return c.json({ data: repos });
  }

  const repos = await githubService.listInstallationRepos(userId, org);
  return c.json({ data: repos });
}

/** GET /github/repos/:owner/:repo — Get a single repository */
export async function getRepo(c: Context) {
  const userId = getUserId(c);
  const owner = param(c, "owner");
  const repo = param(c, "repo");
  const withBranches = c.req.query("branches") === "true";

  const data = await githubService.getRepository(userId, owner, repo, { withBranches });
  return c.json({ data });
}

/** POST /github/repos — Create a new repository */
export async function createRepo(c: Context) {
  const userId = getUserId(c);
  const body = await c.req.json();

  const data = await githubService.createRepository(userId, body.name, {
    description: body.description,
    private: body.private,
    owner: body.owner,
  });

  return c.json({ data }, 201);
}

/** DELETE /github/repos/:owner/:repo — Delete a repository */
export async function deleteRepo(c: Context) {
  const userId = getUserId(c);
  const owner = param(c, "owner");
  const repo = param(c, "repo");

  await githubService.deleteRepository(userId, owner, repo);
  return c.json({ success: true });
}

// ─── Branches ────────────────────────────────────────────────────────────────

/** GET /github/repos/:owner/:repo/branches — List branches */
export async function listBranches(c: Context) {
  const userId = getUserId(c);
  const owner = param(c, "owner");
  const repo = param(c, "repo");

  const data = await githubService.listBranches(userId, owner, repo);
  return c.json({ data });
}

// ─── Files ───────────────────────────────────────────────────────────────────

/** GET /github/repos/:owner/:repo/files — List files in a directory */
export async function listFiles(c: Context) {
  const userId = getUserId(c);
  const owner = param(c, "owner");
  const repo = param(c, "repo");
  const branch = c.req.query("branch");
  const path = c.req.query("path");

  const data = await githubService.listFiles(userId, owner, repo, { branch: branch ?? undefined, path: path ?? undefined });
  return c.json({ data });
}

/** GET /github/repos/:owner/:repo/file — Get a single file's content */
export async function getFile(c: Context) {
  const userId = getUserId(c);
  const owner = param(c, "owner");
  const repo = param(c, "repo");
  const file = c.req.query("file") ?? "package.json";
  const branch = c.req.query("branch");

  const data = await githubService.getFileContent(userId, owner, repo, file, {
    branch: branch ?? undefined,
    json: file.endsWith(".json"),
  });
  return c.json({ data });
}

// ─── Webhooks ────────────────────────────────────────────────────────────────

/** GET /github/repos/:owner/:repo/webhooks — List repo webhooks */
export async function listWebhooks(c: Context) {
  const userId = getUserId(c);
  const owner = param(c, "owner");
  const repo = param(c, "repo");

  const data = await githubService.listWebhooks(userId, owner, repo);
  return c.json({ data });
}

/** POST /github/repos/:owner/:repo/webhooks — Register a webhook (create or find existing) */
export async function registerWebhook(c: Context) {
  const userId = getUserId(c);
  const owner = param(c, "owner");
  const repo = param(c, "repo");

  const data = await githubService.registerWebhook(userId, owner, repo);
  return c.json({ data });
}

/** DELETE /github/repos/:owner/:repo/webhooks — Delete a webhook */
export async function deleteWebhook(c: Context) {
  const userId = getUserId(c);
  const owner = param(c, "owner");
  const repo = param(c, "repo");
  const body = await c.req.json();

  if (!body.hookId) {
    return c.json({ error: "hookId is required" }, 400);
  }

  await githubService.deleteWebhook(userId, owner, repo, body.hookId);
  return c.json({ success: true });
}
