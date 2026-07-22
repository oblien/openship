/**
 * GitLab auth — OAuth (Better Auth) + PAT connection state.
 */

import { generateId } from "@repo/core";
import { APIError } from "better-auth/api";
import { repos } from "@repo/db";
import { env } from "../../config/env";
import { auth } from "../../lib/auth";
import { encrypt, decrypt } from "../../lib/encryption";
import { glFetchSoft, gitlabWebBase } from "./gitlab.http";
import type { GitLabConnectionState, GitLabUser } from "./gitlab.types";

export function isGitlabOAuthConfigured(): boolean {
  return !!(env.GITLAB_CLIENT_ID && env.GITLAB_CLIENT_SECRET);
}

/** Better Auth OAuth access token for providerId=gitlab. */
export async function getUserGitlabToken(userId: string): Promise<string | null> {
  try {
    const tokens = await auth.api.getAccessToken({
      body: { providerId: "gitlab", userId },
    });
    return tokens.accessToken ?? null;
  } catch (error) {
    if (error instanceof APIError) return null;
    throw error;
  }
}

export async function readUserGitlabPat(userId: string): Promise<string | null> {
  const settings = await repos.settings.findByUser(userId);
  if (!settings?.gitlabCloneTokenEncrypted) return null;
  try {
    return decrypt(settings.gitlabCloneTokenEncrypted);
  } catch {
    return null;
  }
}

export async function saveUserGitlabPat(userId: string, token: string): Promise<void> {
  const existing = await repos.settings.findByUser(userId);
  const encrypted = encrypt(token);
  const now = new Date();
  const updates = {
    gitlabCloneTokenEncrypted: encrypted,
    gitlabCloneTokenSetAt: now,
  };
  if (existing) {
    await repos.settings.update(userId, updates);
  } else {
    await repos.settings.upsert({
      id: generateId(),
      userId,
      buildMode: "auto",
      ...updates,
    });
  }
}

export async function clearUserGitlabPat(userId: string): Promise<void> {
  await repos.settings.update(userId, {
    gitlabCloneTokenEncrypted: null,
    gitlabCloneTokenSetAt: null,
  });
}

/**
 * Resolve any usable GitLab credential for this user (PAT first, then OAuth).
 */
export async function resolveGitlabUserCredential(
  userId: string,
): Promise<{ token: string; mode: "pat" | "oauth" } | null> {
  const pat = await readUserGitlabPat(userId);
  if (pat) return { token: pat, mode: "pat" };
  const oauth = await getUserGitlabToken(userId);
  if (oauth) return { token: oauth, mode: "oauth" };
  return null;
}

export async function getGitlabConnectionState(
  userId: string,
): Promise<GitLabConnectionState> {
  const baseUrl = gitlabWebBase();
  const oauthConfigured = isGitlabOAuthConfigured();
  const cred = await resolveGitlabUserCredential(userId);
  if (!cred) {
    return {
      connected: false,
      mode: null,
      login: null,
      avatarUrl: null,
      baseUrl,
      oauthConfigured,
    };
  }

  const user = await glFetchSoft<GitLabUser>(cred.token, { path: "/user" });
  if (!user) {
    return {
      connected: false,
      mode: null,
      login: null,
      avatarUrl: null,
      baseUrl,
      oauthConfigured,
    };
  }

  return {
    connected: true,
    mode: cred.mode,
    login: user.username,
    avatarUrl: user.avatar_url,
    baseUrl,
    oauthConfigured,
  };
}

export async function disconnectGitlabUser(
  userId: string,
  source: "oauth" | "pat" | "all" = "all",
): Promise<void> {
  if (source === "oauth" || source === "all") {
    await repos.account.unlinkProvider(userId, "gitlab");
  }
  if (source === "pat" || source === "all") {
    await clearUserGitlabPat(userId);
  }
}
