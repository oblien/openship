/**
 * Favicon detection - check if a deployed site has a favicon.
 *
 * Called asynchronously on project reads when the favicon cache is stale.
 * Simply checks /favicon.ico - the universal standard.
 *
 * Returns an absolute URL string or null.
 */

import { repos } from "@repo/db";
import { env } from "../config/env";
import { safeFetch } from "./safe-fetch";

const FETCH_TIMEOUT = 8_000;
const FAVICON_REFRESH_TTL_MS = 24 * 60 * 60 * 1000;
const inFlightRefreshes = new Set<string>();

interface FaviconRefreshProject {
  id: string;
  slug?: string | null;
  activeDeploymentId?: string | null;
  favicon?: string | null;
  faviconCheckedAt?: Date | string | null;
}

interface RefreshOptions {
  hostname?: string | null;
}

function normalizeSiteUrl(siteUrlOrHostname: string): string {
  const trimmed = siteUrlOrHostname.trim().replace(/\/$/, "");
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function isRefreshDue(project: FaviconRefreshProject): boolean {
  if (!project.faviconCheckedAt) return true;

  const checkedAt = new Date(project.faviconCheckedAt);
  if (Number.isNaN(checkedAt.getTime())) return true;

  return Date.now() - checkedAt.getTime() >= FAVICON_REFRESH_TTL_MS;
}

async function resolvePreferredSiteUrl(
  project: FaviconRefreshProject,
  options?: RefreshOptions,
): Promise<string | null> {
  if (options?.hostname?.trim()) {
    return normalizeSiteUrl(options.hostname);
  }

  const primaryDomain = await repos.domain.getPrimaryByProject(project.id);
  if (primaryDomain?.verified && primaryDomain.hostname?.trim()) {
    return normalizeSiteUrl(primaryDomain.hostname);
  }

  return null;
}

async function probeFavicon(siteUrl: string): Promise<string | null> {
  const base = normalizeSiteUrl(siteUrl);
  if (!base) return null;

  const faviconUrl = `${base}/favicon.ico`;

  const tryProbe = async (method: "HEAD" | "GET") => {
    // SSRF-safe: `base` is a project's (attacker-controllable-DNS) domain. Pin the
    // resolved IP; reject internal targets on the multi-tenant SaaS, allow the
    // operator's own LAN on self-hosted.
    const res = await safeFetch(faviconUrl, {
      method,
      timeoutMs: FETCH_TIMEOUT,
      allowHttp: true,
      allowPrivate: !env.CLOUD_MODE,
      maxRedirects: 3,
    });

    if (!res.ok) {
      return null;
    }

    const ct = res.headers["content-type"] ?? "";
    if (ct.startsWith("image/") || ct === "application/octet-stream") {
      return faviconUrl;
    }

    return null;
  };

  const headResult = await tryProbe("HEAD");
  if (headResult) {
    return headResult;
  }

  const getResult = await tryProbe("GET");
  if (getResult) {
    return getResult;
  }

  return null;
}

export function refreshProjectFaviconIfStale(
  project: FaviconRefreshProject,
  options?: RefreshOptions,
): void {
  if (!project.activeDeploymentId || !isRefreshDue(project)) {
    return;
  }

  if (inFlightRefreshes.has(project.id)) {
    return;
  }

  inFlightRefreshes.add(project.id);
  void (async () => {
    const siteUrl = await resolvePreferredSiteUrl(project, options);
    if (!siteUrl) {
      return;
    }

    await detectAndStoreFavicon(project.id, siteUrl);
  })()
    .catch(() => undefined)
    .finally(() => {
      inFlightRefreshes.delete(project.id);
    });
}

/**
 * Detect and store the favicon for a deployed project.
 * Best-effort: update the cache timestamp on every attempt, but only replace
 * the stored favicon URL when the fetch succeeds.
 */
export async function detectAndStoreFavicon(projectId: string, siteUrl: string): Promise<void> {
  const checkedAt = new Date();

  try {
    const faviconUrl = await probeFavicon(siteUrl);
    if (faviconUrl) {
      await repos.project.updateFaviconCache(projectId, {
        favicon: faviconUrl,
        faviconCheckedAt: checkedAt,
      });
      return;
    }
  } catch {
    // Best-effort - don't break anything if this fails
  }

  await repos.project.updateFaviconCache(projectId, {
    faviconCheckedAt: checkedAt,
  }).catch(() => undefined);
}
