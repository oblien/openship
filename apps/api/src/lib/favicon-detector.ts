/**
 * Favicon detection — check if a deployed site has a favicon.
 *
 * Called asynchronously after a successful deployment.
 * Simply checks /favicon.ico — the universal standard.
 *
 * Returns an absolute URL string or null.
 */

import { repos } from "@repo/db";

const FETCH_TIMEOUT = 8_000;

/**
 * Detect and store the favicon for a deployed project.
 * Fire-and-forget — errors are silently ignored.
 */
export async function detectAndStoreFavicon(projectId: string, siteUrl: string): Promise<void> {
  try {
    const base = siteUrl.replace(/\/$/, "");
    const faviconUrl = `${base}/favicon.ico`;

    const res = await fetch(faviconUrl, {
      method: "HEAD",
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
      redirect: "follow",
    });

    if (res.ok) {
      const ct = res.headers.get("content-type") ?? "";
      if (ct.startsWith("image/") || ct === "application/octet-stream") {
        await repos.project.update(projectId, { favicon: faviconUrl });
      }
    }
  } catch {
    // Best-effort — don't break anything if this fails
  }
}
