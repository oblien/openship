/**
 * GitLab controller — HTTP handlers for /api/gitlab.
 */

import type { Context } from "hono";
import { auth } from "../../lib/auth";
import { getRequestContext } from "../../lib/request-context";
import { resolveApiPublicUrl } from "../../lib/public-url";
import * as gitlabAuth from "./gitlab.auth";
import * as gitlabService from "./gitlab.service";
import { glFetchSoft, gitlabWebBase, normalizeGitlabBaseUrl } from "./gitlab.http";
import type { GitLabUser } from "./gitlab.types";

export async function getStatus(c: Context) {
  const ctx = getRequestContext(c);
  const state = await gitlabAuth.getGitlabConnectionState(ctx.userId);
  return c.json({ success: true, ...state });
}

export async function getHome(c: Context) {
  const ctx = getRequestContext(c);
  const state = await gitlabAuth.getGitlabConnectionState(ctx.userId);
  if (!state.connected) {
    return c.json({ success: true, state, accounts: [], projects: [] });
  }
  const [accounts, projects] = await Promise.all([
    gitlabService.listNamespaces(ctx).catch(() => []),
    gitlabService.listProjects(ctx).catch(() => []),
  ]);
  return c.json({ success: true, state, accounts, projects });
}

export async function connect(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req.json().catch(() => ({}));
  const mode = body?.mode as string | undefined;
  const pat = typeof body?.token === "string" ? body.token.trim() : "";
  const rawBaseUrl = typeof body?.baseUrl === "string" ? body.baseUrl.trim() : "";

  if (mode === "pat" || pat) {
    if (!pat) {
      return c.json({ success: false, error: "token is required for PAT connect" }, 400);
    }
    let baseUrl = gitlabWebBase();
    if (rawBaseUrl) {
      const normalized = normalizeGitlabBaseUrl(rawBaseUrl);
      if (!normalized) {
        return c.json(
          { success: false, error: "Invalid GitLab URL. Use an origin like https://gitlab.example.com" },
          400,
        );
      }
      baseUrl = normalized;
    }
    const user = await glFetchSoft<GitLabUser>(pat, { path: "/user", baseUrl });
    if (!user) {
      return c.json(
        { success: false, error: "Invalid GitLab personal access token" },
        400,
      );
    }
    await gitlabAuth.saveUserGitlabPat(ctx.userId, pat, baseUrl);
    return c.json({
      success: true,
      connected: true,
      mode: "pat" as const,
      login: user.username,
      baseUrl,
    });
  }

  // OAuth
  if (!gitlabAuth.isGitlabOAuthConfigured()) {
    return c.json(
      {
        success: false,
        error:
          "GitLab OAuth is not configured. Set GITLAB_CLIENT_ID and GITLAB_CLIENT_SECRET, or connect with a personal access token.",
      },
      400,
    );
  }

  const state = await gitlabAuth.getGitlabConnectionState(ctx.userId);
  if (state.connected && state.mode === "oauth") {
    return c.json({ success: true, connected: true });
  }

  return c.json({
    success: true,
    connected: false,
    flow: "redirect" as const,
  });
}

/**
 * Start Better Auth linkSocialAccount for GitLab and return the redirect URL.
 */
export async function connectRedirect(c: Context) {
  const ctx = getRequestContext(c);
  if (!gitlabAuth.isGitlabOAuthConfigured()) {
    return c.json({ error: "GitLab OAuth is not configured" }, 400);
  }

  const callbackURL =
    c.req.query("callbackURL") ||
    `${resolveApiPublicUrl()}/auth/callback/close`;

  try {
    const result = await auth.api.linkSocialAccount({
      body: {
        provider: "gitlab",
        callbackURL,
      },
      headers: c.req.raw.headers,
    });

    const raw = result as unknown as { url?: string; redirect?: string | boolean };
    const url = typeof raw.url === "string" ? raw.url : typeof raw.redirect === "string" ? raw.redirect : null;
    if (!url) {
      return c.json({ error: "Failed to start GitLab OAuth" }, 500);
    }
    return c.redirect(url);
  } catch (err) {
    const message = err instanceof Error ? err.message : "OAuth failed";
    return c.json({ error: message }, 500);
  }
}

export async function disconnect(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req.json().catch(() => ({}));
  const source = (body?.source as "oauth" | "pat" | "all" | undefined) ?? "all";
  await gitlabAuth.disconnectGitlabUser(ctx.userId, source);
  return c.json({ success: true, connected: false });
}

export async function listNamespaces(c: Context) {
  const ctx = getRequestContext(c);
  const accounts = await gitlabService.listNamespaces(ctx);
  return c.json({ success: true, accounts });
}

export async function listProjects(c: Context) {
  const ctx = getRequestContext(c);
  const namespace = c.req.query("namespace") || undefined;
  const search = c.req.query("search") || undefined;
  const projects = await gitlabService.listProjects(ctx, { namespace, search });
  return c.json({ success: true, projects, repos: projects });
}

export async function getProject(c: Context) {
  const ctx = getRequestContext(c);
  const projectId = Number(c.req.param("projectId"));
  if (!Number.isFinite(projectId)) {
    return c.json({ error: "Invalid projectId" }, 400);
  }
  const project = await gitlabService.getProject(ctx, projectId);
  return c.json({ success: true, project });
}

export async function listBranches(c: Context) {
  const ctx = getRequestContext(c);
  const projectId = Number(c.req.param("projectId"));
  if (!Number.isFinite(projectId)) {
    return c.json({ error: "Invalid projectId" }, 400);
  }
  const branches = await gitlabService.listBranches(ctx, projectId);
  return c.json({ success: true, branches });
}

export async function registerWebhook(c: Context) {
  const ctx = getRequestContext(c);
  const projectId = Number(c.req.param("projectId"));
  if (!Number.isFinite(projectId)) {
    return c.json({ error: "Invalid projectId" }, 400);
  }
  const body = await c.req.json().catch(() => ({}));
  const openshipProjectId =
    typeof body?.projectId === "string" ? body.projectId : undefined;
  try {
    const result = await gitlabService.registerWebhook(ctx, projectId, undefined, {
      projectId: openshipProjectId,
    });
    return c.json({ success: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Webhook registration failed";
    return c.json({ success: false, error: message }, 400);
  }
}

export async function getCloneToken(c: Context) {
  const ctx = getRequestContext(c);
  const projectId = Number(c.req.param("projectId"));
  if (!Number.isFinite(projectId)) {
    return c.json({ error: "Invalid projectId" }, 400);
  }
  const openshipProjectId = c.req.query("projectId") || undefined;
  const result = await gitlabService.resolveCloneToken(ctx, openshipProjectId);
  if (!result) {
    return c.json({ error: "No GitLab token available" }, 403);
  }
  const project = await gitlabService.getProject(ctx, projectId);
  const cloneUrl = project.cloneUrl.replace(
    /^https:\/\//,
    `https://${result.username}:${result.token}@`,
  );
  return c.json({
    success: true,
    token: result.token,
    username: result.username,
    cloneUrl,
    baseUrl: result.cloneUrlPrefix,
  });
}

export async function parseUrl(c: Context) {
  const ctx = getRequestContext(c);
  const url = c.req.query("url") || "";
  const baseUrl = await gitlabAuth.resolveUserGitlabBaseUrl(ctx.userId);
  const parsed = gitlabService.parseGitlabRepoUrl(url, { baseUrl });
  if (!parsed) {
    return c.json({ success: false, error: "Not a GitLab repository URL" }, 400);
  }
  return c.json({ success: true, ...parsed, provider: "gitlab" });
}
