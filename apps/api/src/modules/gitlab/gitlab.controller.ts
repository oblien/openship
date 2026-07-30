/**
 * GitLab controller — HTTP handlers for /api/gitlab.
 */

import type { Context } from "hono";
import { repos } from "@repo/db";
import { auth } from "../../lib/auth";
import { getRequestContext } from "../../lib/request-context";
import { resolveApiPublicUrl } from "../../lib/public-url";
import * as gitlabAuth from "./gitlab.auth";
import * as gitlabService from "./gitlab.service";
import {
  glFetchSoft,
  gitlabWebBase,
  parseAllowedGitlabBaseUrl,
} from "./gitlab.http";
import type { GitLabUser } from "./gitlab.types";

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
      try {
        const normalized = parseAllowedGitlabBaseUrl(rawBaseUrl);
        if (!normalized) {
          return c.json(
            {
              success: false,
              error: "Invalid GitLab URL. Use an origin like https://gitlab.example.com",
            },
            400,
          );
        }
        baseUrl = normalized;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Invalid GitLab URL";
        return c.json({ success: false, error: message }, 400);
      }
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
 * Start Better Auth linkSocialAccount for GitLab and redirect to the provider.
 *
 * Mirrors GitHub's connectRedirect: this route is `.public()` (no
 * authMiddleware / request context) because the popup navigates here
 * directly; session cookies still ride on the request for Better Auth.
 * We MUST forward Better Auth's OAuth state Set-Cookie onto the 302 or
 * the callback can't complete the link.
 */
export async function connectRedirect(c: Context) {
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

    if (result && typeof result === "object" && "url" in result) {
      return c.redirect((result as { url: string }).url);
    }

    return c.json({ error: "Failed to start GitLab OAuth" }, 500);
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

/**
 * Mint a clone credential for a GitLab project.
 *
 * When `?projectId=` (Openship project id) is supplied, the project MUST
 * belong to the caller's org AND be gitProvider=gitlab — otherwise a
 * cross-org IDOR could decrypt any project's cloneTokenEncrypted (including
 * a GitHub PAT stored in the same column). Prefer the caller's own
 * OAuth/PAT when no project id is given.
 */
export async function getCloneToken(c: Context) {
  const ctx = getRequestContext(c);
  const projectId = Number(c.req.param("projectId"));
  if (!Number.isFinite(projectId)) {
    return c.json({ error: "Invalid projectId" }, 400);
  }

  const openshipProjectId = c.req.query("projectId") || undefined;
  if (openshipProjectId) {
    const project = await repos.project.findByIdInOrganization(
      openshipProjectId,
      ctx.organizationId,
    );
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }
    if (project.gitProvider !== "gitlab") {
      return c.json({ error: "Project is not linked to GitLab" }, 400);
    }
  }

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
