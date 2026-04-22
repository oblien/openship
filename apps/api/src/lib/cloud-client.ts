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
import type { CloudPreflightData } from "./cloud-preflight";
import { env } from "../config/env";
import { decrypt } from "./encryption";

export interface CloudAccount {
  name: string;
  email: string;
  image?: string | null;
}

// ─── Namespace token cache ───────────────────────────────────────────────────

interface TokenCache {
  token: string;
  namespace: string;
  expiresAt: number; // epoch ms
}

const tokenCache = new Map<string, TokenCache>();
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

// ─── Authenticated cloud fetch ───────────────────────────────────────────────

/**
 * Make an authenticated request to the SaaS API using the stored cloud session.
 *
 * Handles: read session → decrypt → Bearer auth → 401 session cleanup.
 * Returns the Response, or null if not connected.
 */
async function cloudFetch(
  userId: string,
  path: string,
  init?: RequestInit,
): Promise<Response | null> {
  const settings = await repos.settings.findByUser(userId);
  if (!settings?.cloudSessionToken) return null;

  const sessionToken = decrypt(settings.cloudSessionToken);

  let res: Response;
  try {
    res = await fetch(`${env.OPENSHIP_CLOUD_URL}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...init?.headers,
        Authorization: `Bearer ${sessionToken}`,
      },
    });
  } catch {
    // Network error (ECONNREFUSED, DNS failure, timeout, etc.)
    return null;
  }

  if (res.status === 401) {
    await repos.settings.update(userId, { cloudSessionToken: null });
    tokenCache.delete(userId);
  }

  return res;
}

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

export async function getCloudConnectionStatus(
  userId: string,
): Promise<{ connected: boolean; user?: CloudAccount }> {
  const settings = await repos.settings.findByUser(userId);
  if (!settings?.cloudSessionToken) {
    return { connected: false };
  }

  const res = await cloudFetch(userId, "/api/cloud/account", { method: "GET" });

  if (!res) {
    return { connected: true };
  }

  if (res.status === 401) {
    return { connected: false };
  }

  if (!res.ok) {
    return { connected: true };
  }

  const json = (await res.json()) as { user?: CloudAccount };
  return json.user
    ? { connected: true, user: json.user }
    : { connected: true };
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

  const res = await cloudFetch(userId, "/api/cloud/token", { method: "POST" });
  if (!res || !res.ok) return null;

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

export async function getCloudPreflight(
  userId: string,
  input: { slug?: string; customDomain?: string },
): Promise<CloudPreflightData | null> {
  const res = await cloudFetch(userId, "/api/cloud/preflight", {
    method: "POST",
    body: JSON.stringify(input),
  });

  if (!res || !res.ok) return null;

  const json = (await res.json()) as { data: CloudPreflightData };
  return json.data;
}

// ─── Edge proxy sync ─────────────────────────────────────────────────────────

/**
 * Ask the SaaS to create/update an Oblien edge proxy for a managed domain.
 *
 * Sends just the slug + target IP — the SaaS constructs the full domain.
 */
export async function syncEdgeProxy(
  userId: string,
  slug: string,
  target: string,
): Promise<void> {
  const res = await cloudFetch(userId, "/api/cloud/edge-proxy", {
    method: "POST",
    body: JSON.stringify({ slug, target }),
  });

  if (!res) {
    throw new Error("Cannot sync edge proxy: no Openship Cloud account linked");
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Edge proxy sync failed (${res.status}): ${text}`);
  }
}

// ─── Analytics proxy ─────────────────────────────────────────────────────────

/**
 * Proxy an analytics call through the SaaS using master Oblien credentials.
 *
 * Edge proxies + analytics are account-level — namespace tokens can't access them.
 * Local/desktop instances call this; the SaaS uses its master client.
 */
export async function cloudAnalyticsProxy<T>(
  userId: string,
  operation: "timeseries" | "requests" | "streamToken",
  domain: string,
  params?: Record<string, unknown>,
): Promise<T | null> {
  const res = await cloudFetch(userId, "/api/cloud/analytics", {
    method: "POST",
    body: JSON.stringify({ operation, domain, params }),
  });
  if (!res?.ok) return null;
  return res.json() as Promise<T>;
}

// ─── Billing ─────────────────────────────────────────────────────────────────

/**
 * Proxy a billing request to the SaaS API.
 *
 * Used by local/desktop instances so cloud-connected users can manage
 * their subscription, payment methods, and invoices through the SaaS.
 *
 * Returns the raw Response so the caller can forward status + body.
 * Returns null if the user isn't connected to Openship Cloud.
 */
export async function cloudBillingFetch(
  userId: string,
  path: string,
  init?: { method?: string; body?: string },
): Promise<Response | null> {
  return cloudFetch(userId, `/api/billing${path}`, {
    method: init?.method ?? "GET",
    body: init?.body,
  });
}
