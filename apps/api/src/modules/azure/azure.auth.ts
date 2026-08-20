/**
 * Azure DevOps credentials — Entra ID OAuth (Better Auth `microsoft`) or
 * an instance-wide encrypted PAT. Tokens are never written into gitUrl.
 */

import { APIError } from "better-auth/api";
import { repos } from "@repo/db";
import { env } from "../../config/env";
import { auth } from "../../lib/auth";
import { decrypt, encrypt } from "../../lib/encryption";
import type { RequestContext } from "../../lib/request-context";

const AZURE_API_VERSION = "7.1";
const FETCH_TIMEOUT_MS = 20_000;

export function azureOAuthConfigured(): boolean {
  return Boolean(env.AZURE_CLIENT_ID && env.AZURE_CLIENT_SECRET);
}

export async function getUserToken(userId: string): Promise<string | null> {
  try {
    const tokens = await auth.api.getAccessToken({
      body: { providerId: "microsoft", userId },
    });
    return tokens.accessToken ?? null;
  } catch (error) {
    if (error instanceof APIError) return null;
    throw error;
  }
}

export async function getInstancePat(): Promise<string | null> {
  if (env.CLOUD_MODE) return null;
  const settings = await repos.instanceSettings.get();
  const sealed = settings?.azurePatEncrypted;
  if (!sealed) return null;
  try {
    return decrypt(sealed);
  } catch {
    return null;
  }
}

export async function setInstancePat(token: string | null): Promise<void> {
  if (env.CLOUD_MODE) {
    throw new Error("Azure instance PAT is not available in cloud mode");
  }
  await repos.instanceSettings.upsert(
    token
      ? { azurePatEncrypted: encrypt(token), azurePatSetAt: new Date() }
      : { azurePatEncrypted: null, azurePatSetAt: null },
  );
}

export async function hasInstancePat(): Promise<boolean> {
  if (env.CLOUD_MODE) return false;
  const settings = await repos.instanceSettings.get();
  return Boolean(settings?.azurePatEncrypted);
}

/** OAuth token first, then instance PAT. */
export async function getCredential(ctx: RequestContext): Promise<string | null> {
  const oauth = await getUserToken(ctx.userId);
  if (oauth) return oauth;
  return getInstancePat();
}

function authHeader(token: string): string {
  // Entra access tokens are JWTs; Azure PATs are opaque.
  if (token.split(".").length === 3) return `Bearer ${token}`;
  return `Basic ${Buffer.from(`:${token}`).toString("base64")}`;
}

export async function azureFetch<T>(
  url: string,
  ctx: RequestContext,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  const token = await getCredential(ctx);
  if (!token) {
    throw new Error("Azure DevOps is not connected. Connect in Settings → Git or paste a PAT.");
  }

  const parsed = new URL(url);
  if (!parsed.searchParams.has("api-version")) {
    parsed.searchParams.set("api-version", AZURE_API_VERSION);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(parsed.toString(), {
      method: init?.method ?? "GET",
      headers: {
        Authorization: authHeader(token),
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
      },
      body: init?.body ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Azure DevOps API error (${res.status}): ${text.slice(0, 300)}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export async function azureFetchText(
  url: string,
  ctx: RequestContext,
): Promise<string | undefined> {
  const token = await getCredential(ctx);
  if (!token) return undefined;

  const parsed = new URL(url);
  if (!parsed.searchParams.has("api-version")) {
    parsed.searchParams.set("api-version", AZURE_API_VERSION);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(parsed.toString(), {
      headers: { Authorization: authHeader(token), Accept: "text/plain" },
      signal: controller.signal,
    });
    if (!res.ok) return undefined;
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}
