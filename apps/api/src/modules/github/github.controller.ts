/** HTTP input, status, and cookie adapters for shared GitHub operations. */
import type { Context } from "hono";
import { env, runtimeTarget } from "@repo/platform/engine/config/env";
import { auth } from "@repo/platform/engine/lib/auth";
import * as githubAuth from "@repo/platform/engine/modules/github/github.auth";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { getRequestContext } from "../../lib/request-context";
import { operationContext, operationData } from "../../lib/operation-context";
import type { RepoListParams } from "@repo/platform/engine/modules/github/repo-list";
const ops = () => getPlatformKernel().github;
const call = (c: Context) => operationContext(c);
const repo = (c: Context) => ({ owner: c.req.param("owner")!, repo: c.req.param("repo")! });
export async function getStatus(c: Context) {
  
  const data = await operationData(c, ops().getStatus(call(c)));
  return c.json(data, 200);
}
export async function getHome(c: Context) {
  
  const data = await operationData(c, ops().getHome(call(c)));
  return c.json(data, 200);
}
export async function getLocalStatus(c: Context) {
  
  const data = await operationData(c, ops().getLocalStatus(call(c)));
  return c.json(data, 200);
}
export async function connect(c: Context) {
  
  const data = await operationData(c, ops().connect(call(c), await c.req.json().catch(() => ({}))));
  return c.json(data, 200);
}
export async function claimInstallation(c: Context) {
  
  const data = await operationData(c, ops().claimInstallation(call(c), await c.req.json()));
  return c.json(data, 200);
}
export async function setInstanceToken(c: Context) {
  
  const data = await operationData(c, ops().setInstanceToken(call(c), await c.req.json()));
  return c.json(data, 200);
}
export async function disconnect(c: Context) {
  const body = await c.req.json().catch(() => ({}));
  const data = await operationData(c, ops().disconnect(call(c), { source: body.source ?? c.req.query("source") }));
  return c.json(data, 200);
}
export async function listRepos(c: Context) {
  
  const data = await operationData(c, ops().listRepos(call(c), { ...parseRepoListParams(c), owner: c.req.query("owner") }));
  return c.json(data, 200);
}
export async function listOrgRepos(c: Context) {
  
  const data = await operationData(c, ops().listOrgRepos(call(c), { ...parseRepoListParams(c), org: c.req.param("org")! }));
  return c.json(data, 200);
}
export async function getRepo(c: Context) {
  
  const data = await operationData(c, ops().getRepo(call(c), { ...repo(c), branches: c.req.query("branches") === "true" }));
  return c.json({ data }, 200);
}
export async function createRepo(c: Context) {
  
  const data = await operationData(c, ops().createRepo(call(c), await c.req.json()));
  return c.json({ data }, 201);
}
export async function deleteRepo(c: Context) {
  
  const data = await operationData(c, ops().deleteRepo(call(c), repo(c)));
  return c.json(data, 200);
}
export async function listBranches(c: Context) {
  const data = await operationData(c, ops().listBranches(call(c), {
    ...repo(c),
    page: Number(c.req.query("page") ?? 1),
  }));
  return c.json(data, 200);
}
export async function getCloneToken(c: Context) {
  
  const data = await operationData(c, ops().getCloneToken(call(c), repo(c)));
  return c.json(data, 200);
}
export async function detectStack(c: Context) {
  
  const data = await operationData(c, ops().detectStack(call(c), { ...repo(c), branch: c.req.query("branch"), composePath: c.req.query("composePath") }));
  return c.json({ data }, 200);
}
export async function listFiles(c: Context) {
  
  const data = await operationData(c, ops().listFiles(call(c), { ...repo(c), branch: c.req.query("branch"), path: c.req.query("path") }));
  return c.json({ data }, 200);
}
export async function listTree(c: Context) {
  
  const data = await operationData(c, ops().listTree(call(c), { ...repo(c), branch: c.req.query("branch") }));
  return c.json({ data }, 200);
}
export async function getFile(c: Context) {
  
  const data = await operationData(c, ops().getFile(call(c), { ...repo(c), branch: c.req.query("branch"), file: c.req.query("file")! }));
  return c.json({ data }, 200);
}
export async function listWebhooks(c: Context) {
  
  const data = await operationData(c, ops().listWebhooks(call(c), repo(c)));
  return c.json({ data }, 200);
}
export async function registerWebhook(c: Context) {
  
  const data = await operationData(c, ops().registerWebhook(call(c), repo(c)));
  return c.json({ data }, 200);
}
export async function deleteWebhook(c: Context) {
  const body = await c.req.json();
  const data = await operationData(c, ops().deleteWebhook(call(c), { ...body, ...repo(c) }));
  return c.json(data, 200);
}
export async function pollConnect(c: Context) {
  const data = await operationData(c, ops().pollConnect(call(c)));
  return c.json(data, data.status === "none" ? 404 : 200);
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
    mode === "app" || mode === "cloud-app" ? "/auth/callback/install" : "/auth/callback/close";

  // In a self-hosted local-App flow, POST /github/connect minted this nonce for
  // the authenticated user + active workspace before OAuth began. Better Auth
  // preserves callbackURL in its signed OAuth state, so threading it here makes
  // both possible landing paths (dashboard page or direct API fallback) retain
  // the same installation binding. An injected value is harmless: the final
  // claim accepts only a live DB nonce belonging to the authenticated caller.
  const installState = c.req.query("install_state")?.trim();
  const callbackPath =
    installState && mode === "app" ? `${path}?state=${encodeURIComponent(installState)}` : path;

  // Better Auth stores callbackURL/errorCallbackURL verbatim and redirects to
  // them as-is after the OAuth callback (which runs on the API origin). In
  // split-origin SaaS (app.* vs api.*) a relative path would resolve against
  // the API host and dead-end, so absolutize against the dashboard origin.
  // Self-hosted keeps the relative path (resolves against its single origin).
  const dashOrigin = env.CLOUD_MODE ? runtimeTarget.dashboard : "";
  const callbackURL = `${dashOrigin}${callbackPath}`;
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
        const body = (await result.json()) as { url?: string };
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
