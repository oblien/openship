/**
 * Azure DevOps HTTP handlers. Self-hosted only (routes are localOnly).
 */

import type { Context } from "hono";
import { randomBytes } from "node:crypto";
import { env, runtimeTarget } from "../../config/env";
import { auth } from "../../lib/auth";
import { getRequestContext } from "../../lib/request-context";
import {
  azureOAuthConfigured,
  getUserToken,
  hasInstancePat,
  setInstancePat,
} from "./azure.auth";
import * as azureService from "./azure.service";
import { resolveProjectInfo } from "../deployments/prepare.service";

function param(c: Context, name: string): string {
  const val = c.req.param(name);
  if (!val) throw new Error(`Missing route param: ${name}`);
  return val;
}

function getSetCookieHeaders(headers: Headers): string[] {
  const responseHeaders = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof responseHeaders.getSetCookie === "function") {
    const cookies = responseHeaders.getSetCookie();
    if (cookies.length > 0) return cookies;
  }
  const cookie = headers.get("set-cookie");
  return cookie ? [cookie] : [];
}

export async function getStatus(c: Context) {
  if (env.CLOUD_MODE) {
    return c.json({ error: "Azure DevOps is not available in cloud mode", code: "NOT_SUPPORTED" }, 400);
  }
  const ctx = getRequestContext(c);
  const [oauth, pat] = await Promise.all([
    getUserToken(ctx.userId),
    hasInstancePat(),
  ]);
  const connected = Boolean(oauth || pat);
  let orgs: string[] = [];
  if (connected) {
    try {
      orgs = await azureService.listOrganizations(ctx);
    } catch {
      orgs = [];
    }
  }
  return c.json({
    connected,
    oauth: Boolean(oauth),
    pat,
    oauthConfigured: azureOAuthConfigured(),
    orgs,
  });
}

export async function connect(c: Context) {
  if (env.CLOUD_MODE) {
    return c.json({ error: "Azure DevOps is not available in cloud mode", code: "NOT_SUPPORTED" }, 400);
  }
  if (!azureOAuthConfigured()) {
    return c.json(
      {
        connected: false,
        flow: "token" as const,
        error:
          "Set AZURE_CLIENT_ID and AZURE_CLIENT_SECRET (Entra ID app) or paste a PAT below.",
      },
      400,
    );
  }
  return c.json({ connected: false, flow: "redirect" as const });
}

export async function connectRedirect(c: Context) {
  if (env.CLOUD_MODE || !azureOAuthConfigured()) {
    return c.text("Azure DevOps OAuth is not configured", 400);
  }
  const dashOrigin = env.CLOUD_MODE ? runtimeTarget.dashboard : "";
  const callbackURL = `${dashOrigin}/auth/callback/close`;
  const errorCallbackURL = callbackURL;

  try {
    const result = await auth.api.linkSocialAccount({
      body: {
        provider: "microsoft",
        callbackURL,
        errorCallbackURL,
        disableRedirect: true,
      },
      headers: c.req.raw.headers,
      asResponse: true,
    });

    if (result instanceof Response) {
      const cookies = getSetCookieHeaders(result.headers);
      let redirectUrl: string | null = result.headers.get("location");
      try {
        const body = (await result.json()) as { url?: string };
        redirectUrl = redirectUrl ?? body?.url ?? null;
      } catch {
        /* headers only */
      }
      if (redirectUrl) {
        const response = c.redirect(redirectUrl);
        for (const cookie of cookies) response.headers.append("Set-Cookie", cookie);
        return response;
      }
    }
    if (result && typeof result === "object" && "url" in result) {
      return c.redirect((result as { url: string }).url);
    }
  } catch {
    /* fall through */
  }
  return c.text("Unable to start Azure DevOps authorization", 500);
}

export async function disconnect(c: Context) {
  if (env.CLOUD_MODE) {
    return c.json({ error: "Not available on Openship Cloud", code: "NOT_SUPPORTED" }, 400);
  }
  const ctx = getRequestContext(c);
  await setInstancePat(null);
  // Unlink the Entra account when present — ignore if it was PAT-only.
  try {
    await auth.api.unlinkAccount({
      body: { providerId: "microsoft" },
      headers: c.req.raw.headers,
    });
  } catch {
    /* no microsoft account linked */
  }
  void ctx;
  return c.json({ success: true });
}

export async function setInstanceToken(c: Context) {
  if (env.CLOUD_MODE) {
    return c.json({ error: "Not available on Openship Cloud", code: "NOT_SUPPORTED" }, 400);
  }
  const body = await c.req.json<{ token?: string | null }>().catch(() => null);
  const token = body?.token?.trim() ?? "";
  if (!token) {
    await setInstancePat(null);
    return c.json({ success: true, cleared: true });
  }
  await setInstancePat(token);
  return c.json({ success: true });
}

export async function listOrgs(c: Context) {
  const ctx = getRequestContext(c);
  const orgs = await azureService.listOrganizations(ctx);
  return c.json({ orgs });
}

export async function listRepos(c: Context) {
  const ctx = getRequestContext(c);
  const org = param(c, "org");
  const repos = await azureService.listRepos(ctx, org);
  return c.json({
    repos: repos.map((r) => ({
      id: r.id,
      name: r.name,
      org: r.org,
      project: r.project,
      full_name: `${r.org}/${r.project}/${r.name}`,
      default_branch: r.defaultBranch,
      html_url: r.webUrl,
      private: true,
    })),
  });
}

export async function listBranches(c: Context) {
  const ctx = getRequestContext(c);
  const branches = await azureService.listBranches(
    ctx,
    param(c, "org"),
    param(c, "project"),
    param(c, "repo"),
  );
  return c.json({ branches });
}

export async function detectStack(c: Context) {
  const ctx = getRequestContext(c);
  const org = param(c, "org");
  const project = param(c, "project");
  const repo = param(c, "repo");
  const branch = c.req.query("branch") || undefined;
  const info = await resolveProjectInfo({
    source: "azure",
    owner: org,
    project,
    repo,
    branch,
    ctx,
  });
  return c.json(info);
}

export async function registerWebhook(c: Context) {
  const ctx = getRequestContext(c);
  const org = param(c, "org");
  const projectName = param(c, "project");
  const repo = param(c, "repo");
  const secret = randomBytes(32).toString("hex");
  const { subscriptionId } = await azureService.registerServiceHook(
    ctx,
    org,
    projectName,
    repo,
    secret,
  );
  return c.json({ subscriptionId });
}

export async function deleteWebhook(c: Context) {
  const ctx = getRequestContext(c);
  const org = param(c, "org");
  const subscriptionId = c.req.query("subscriptionId");
  if (!subscriptionId) return c.json({ error: "subscriptionId is required" }, 400);
  await azureService.deleteServiceHook(ctx, org, subscriptionId);
  return c.json({ success: true });
}
