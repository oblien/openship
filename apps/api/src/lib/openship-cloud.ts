/**
 * Openship Cloud — namespace provisioning + token minting.
 *
 * Runs on the SaaS API (CLOUD_MODE=true) only. Local instances
 * call POST /api/cloud/token to get a namespace-scoped token,
 * then use `new Oblien({ token })` to drive the full pipeline
 * themselves (workspaces.create, build, deploy — everything).
 *
 * Two responsibilities:
 *   1. ensureNamespace(userId) — create-if-not-exists, cached
 *   2. issueNamespaceToken(userId) — mint a scoped token for the namespace
 */

import { Oblien } from "oblien";
import { env } from "../config/env";

// ─── Oblien client (master credentials — SaaS only) ─────────────────────────

let _client: Oblien | null = null;

export function getOblienClient(): Oblien {
  if (_client) return _client;

  const clientId = env.OBLIEN_CLIENT_ID;
  const clientSecret = env.OBLIEN_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Oblien credentials not configured (OBLIEN_CLIENT_ID / OBLIEN_CLIENT_SECRET)");
  }

  _client = new Oblien({ clientId, clientSecret });
  return _client;
}

// ─── Namespace management ────────────────────────────────────────────────────

/** Cache: userId → namespace slug */
const namespaceCache = new Map<string, string>();

function namespaceSlugForUser(userId: string): string {
  return `os-${userId.toLowerCase().replace(/[^a-z0-9-]+/g, "-")}`;
}

/**
 * Ensure an Oblien namespace exists for a user.
 *
 * Slug: normalized `os-{userId}` in lowercase.
 * Uses Oblien's native idempotent `namespaces.ensure` API.
 */
export async function ensureNamespace(userId: string): Promise<string> {
  const cached = namespaceCache.get(userId);
  if (cached) return cached;

  const client = getOblienClient();
  const slug = namespaceSlugForUser(userId);

  const ensured = await client.namespaces.ensure({
    name: `Openship ${userId}`,
    slug,
  });

  const namespace = ensured.data.slug || slug;
  namespaceCache.set(userId, namespace);
  return namespace;
}

// ─── Token minting ───────────────────────────────────────────────────────────

export interface NamespaceTokenResult {
  token: string;
  namespace: string;
  expiresAt: string;
}

/**
 * Issue a namespace-scoped Oblien token for a user.
 *
 * The token gives full access to the user's namespace — create workspaces,
 * manage lifecycle, deploy, etc. Local instances use this to construct
 * `new Oblien({ token })` and run the full CloudRuntime pipeline.
 *
 * TTL: 30 minutes (covers build + deploy + some buffer).
 */
export async function issueNamespaceToken(userId: string): Promise<NamespaceTokenResult> {
  const client = getOblienClient();
  const namespace = await ensureNamespace(userId);

  try {
    const result = await client.tokens.create({
      scope: "namespace",
      namespace,
      ttl: 1800,
    });

    return {
      token: result.token,
      namespace,
      expiresAt: result.expiresAt,
    };
  } catch (err: unknown) {
    console.error("Oblien SDK token issuance error", err);
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to issue Oblien namespace token for ${namespace}: ${message}`);
  }
}
