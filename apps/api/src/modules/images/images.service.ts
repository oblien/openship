/**
 * Image catalog - thin proxy over Oblien `workspaces.images.list`.
 *
 * The catalog is global (same images for everyone), so we cache it in
 * memory for a few minutes. Filtering by `search` / `category` happens
 * on the Oblien side, so each unique (search, category) tuple gets its
 * own cache slot.
 *
 * Resolution:
 *  - SaaS instance (CLOUD_MODE=true)  → master Oblien client.
 *  - Local instance with cloud linked → per-user namespace-scoped token.
 *  - Local instance without cloud      → throws "cloud-not-connected".
 *    The dashboard treats that as "show only the Custom image tile".
 */

import { Oblien } from "@repo/adapters";
import { env } from "@repo/platform/engine/config/env";
import { getOblienClient } from "@repo/platform/engine/lib/openship-cloud";
import { getOrgCloudToken } from "@repo/platform/engine/lib/cloud/client";
import { cacheStore } from "@repo/platform/engine/lib/cache-store/index";

export interface ImageCatalogEntry {
  /** Unique slug, e.g. "postgres" - what the user picks in the catalog */
  id?: string;
  /** Display name, e.g. "PostgreSQL" */
  name?: string;
  /** Docker image string the service will run with, e.g. "postgres:16-alpine" */
  image?: string;
  /** URL to logo / icon (rendered in the catalog grid). May be relative. */
  logo?: string;
  /** Short description shown on the card */
  description?: string;
  /** Free-form category - "database", "cache", "messaging", etc. */
  category?: string;
  /** Tag chips */
  tags?: string[];
  /** Default exposed ports (e.g. [5432]) */
  ports?: number[];
  /** Suggested env keys with optional default values */
  defaultEnv?: Array<{ key: string; value?: string; description?: string }>;
  /** Anything else the Oblien catalog returns - passed through for forward compat. */
  [key: string]: unknown;
}

interface CatalogParams {
  search?: string;
  category?: string;
}

const CACHE_TTL_S = 5 * 60;

function cacheKey(userId: string | "saas", params: CatalogParams): string {
  return `${userId}::${params.search ?? ""}::${params.category ?? ""}`;
}

/**
 * Pick the right Oblien client for the current deployment mode.
 * Throws "cloud-not-connected" when the org has no cloud link.
 *
 * The catalog is org-shared — every team member sees the same images
 * via the org owner's namespace.
 */
async function getClientForOrg(organizationId: string): Promise<Oblien> {
  if (env.CLOUD_MODE) {
    return getOblienClient();
  }
  const tok = await getOrgCloudToken(organizationId);
  if (!tok) throw new Error("cloud-not-connected");
  return new Oblien({ token: tok.token });
}

function normalizeImages(raw: unknown): ImageCatalogEntry[] {
  if (!raw || typeof raw !== "object") return [];
  const obj = raw as Record<string, unknown>;
  // Common shapes: { data: [...] }, { images: [...] }, or raw [...]
  const list =
    Array.isArray(obj.data) ? obj.data :
    Array.isArray(obj.images) ? obj.images :
    Array.isArray(raw) ? raw :
    [];
  return list.filter((x): x is ImageCatalogEntry => !!x && typeof x === "object");
}

export async function listImages(
  organizationId: string,
  params: CatalogParams = {},
): Promise<ImageCatalogEntry[]> {
  const store = await cacheStore<ImageCatalogEntry[]>("oblien-image-catalog");
  const key = cacheKey(env.CLOUD_MODE ? "saas" : organizationId, params);
  const hit = await store.get(key);
  if (hit) return hit;

  const client = await getClientForOrg(organizationId);
  const response = await client.workspaces.images.list(params);
  const images = normalizeImages(response);
  await store.set(key, images, CACHE_TTL_S);
  return images;
}
