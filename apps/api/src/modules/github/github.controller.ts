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
import * as githubAuth from "./github.auth";
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
  return c.json({ ...status, mode: githubAuth.isCloudMode() ? "cloud" : "desktop" });
}

/** GET /github/home — User's GitHub home: status + accounts + repos */
export async function getHome(c: Context) {
  const userId = getUserId(c);
  const data = await githubService.getUserHome(userId);
  return c.json(data);
}

/** POST /github/connect — Returns connection info based on deploy mode.
 *
 *  Cloud mode (GitHub App):
 *    - needsOAuth true/false + url to installation page
 *    - Frontend chains OAuth → install in one popup when needed
 *
 *  Desktop / self-hosted mode (direct OAuth):
 *    - url to Better Auth social sign-in (OAuth only, no App install)
 *    - User's personal token is used — fully local, no cloud involvement
 */
export async function connect(c: Context) {
  const userId = getUserId(c);
  const cloud = githubAuth.isCloudMode();
  const hasToken = !!(await githubAuth.getUserToken(userId));

  if (cloud) {
    // Cloud: GitHub App installation flow
    return c.json({
      mode: "cloud" as const,
      url: githubAuth.getInstallUrl(),
      needsOAuth: !hasToken,
    });
  }

  // Desktop / self-hosted: direct OAuth only
  return c.json({
    mode: "desktop" as const,
    needsOAuth: !hasToken,
  });
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
  const installations = await githubAuth.getUserInstallations(userId);
  const accounts = githubAuth.mapAccounts(installations);
  return c.json({ data: accounts });
}

/** GET /github/orgs — List user's org accounts */
export async function listOrgs(c: Context) {
  const userId = getUserId(c);
  const orgs = await githubService.listUserOrgs(userId);
  return c.json({ data: orgs });
}

/** GET /github/orgs/repos — List all orgs with their repos */
export async function listOrgsWithRepos(c: Context) {
  const userId = getUserId(c);
  const data = await githubService.listUserOrgsWithRepos(userId);
  return c.json({ data });
}

// ─── Repositories ────────────────────────────────────────────────────────────

/** GET /github/repos — List repos (mode-aware) */
export async function listRepos(c: Context) {
  const userId = getUserId(c);
  const owner = c.req.query("owner");
  const cloud = githubAuth.isCloudMode();

  if (!cloud) {
    // Desktop/self-hosted: use personal OAuth token
    const repos = await githubService.listUserOwnedRepos(userId, owner || undefined);
    return c.json({ data: repos });
  }

  // Cloud: use GitHub App installation
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
