/**
 * Cloud client — used by local/self-hosted instances to get
 * an Oblien namespace token from api.openship.io.
 *
 * Auth is fully server-side: the user's Openship Cloud session
 * is stored (encrypted) in user_settings.cloud_session_token.
 * This module reads it from DB, fetches namespace tokens from
 * the SaaS API, and caches them in memory.
 *
 * No client-side cookies or tokens involved.
 */

import { repos } from "@repo/db";
import { env } from "../config/env";
import { decrypt } from "./encryption";

// ─── Namespace token cache ───────────────────────────────────────────────────

interface TokenCache {
  token: string;
  namespace: string;
  expiresAt: number; // epoch ms
}

const tokenCache = new Map<string, TokenCache>();
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

// ─── Cloud session management ────────────────────────────────────────────────

/**
 * Disconnect from Openship Cloud — clear stored session.
 */
export async function disconnectCloud(userId: string): Promise<void> {
  await repos.settings.update(userId, { cloudSessionToken: null });
  tokenCache.delete(userId);
}

/**
 * Check whether the user has a stored cloud session.
 */
export async function isCloudConnected(userId: string): Promise<boolean> {
  const settings = await repos.settings.findByUser(userId);
  return !!settings?.cloudSessionToken;
}

// ─── Namespace token fetching ────────────────────────────────────────────────

/**
 * Get a valid namespace-scoped Oblien token for a user.
 *
 * Reads the stored cloud session from DB, calls POST /api/cloud/token
 * on the SaaS API, caches the result in memory.
 *
 * Returns null if the user isn't connected to Openship Cloud.
 */
export async function getCloudToken(
  userId: string,
): Promise<{ token: string; namespace: string } | null> {
  // Check memory cache first
  const cached = tokenCache.get(userId);
  if (cached && cached.expiresAt - Date.now() > REFRESH_BUFFER_MS) {
    return { token: cached.token, namespace: cached.namespace };
  }

  // Read stored session from DB
  const settings = await repos.settings.findByUser(userId);
  if (!settings?.cloudSessionToken) return null;

  const sessionToken = decrypt(settings.cloudSessionToken);

  // Fetch namespace token from SaaS API
  const url = `${env.OPENSHIP_CLOUD_URL}/api/cloud/token`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${sessionToken}`,
    },
  });

  if (!res.ok) {
    // If 401, the stored session is expired — clear it
    if (res.status === 401) {
      await repos.settings.update(userId, { cloudSessionToken: null });
      tokenCache.delete(userId);
    }
    return null;
  }

  const json = (await res.json()) as {
    data: { token: string; namespace: string; expiresAt: string };
  };

  const { token, namespace, expiresAt } = json.data;

  tokenCache.set(userId, {
    token,
    namespace,
    expiresAt: new Date(expiresAt).getTime(),
  });

  return { token, namespace };
}
