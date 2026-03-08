/**
 * Screenshot service — captures website screenshots after deployment.
 *
 * Dispatches to a headless browser service (Puppeteer/Playwright container)
 * and optionally uploads the result to a CDN.
 *
 * Configurable via env vars:
 *   SCREENSHOT_SERVICE_URL  — URL of the screenshot micro-service
 *   CDN_UPLOAD_URL          — URL of the CDN upload endpoint
 *
 * Gracefully no-ops when the screenshot service is not configured.
 */

import { env } from "../config/env";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ScreenshotOptions {
  /** URL to capture */
  url: string;
  /** Viewport width (default 1600) */
  width?: number;
  /** Viewport height (default 900) */
  height?: number;
  /** Device scale factor (default 2 for retina) */
  scale?: number;
  /** Whether to capture full-page screenshot */
  fullPage?: boolean;
  /** Timeout in ms before aborting (default 15000) */
  timeout?: number;
}

export interface ScreenshotResult {
  /** Temporary URL of the captured screenshot */
  tempUrl: string;
  /** CDN URL after upload (null if CDN not configured) */
  cdnUrl: string | null;
  /** Image dimensions */
  width: number;
  height: number;
  /** File size in bytes */
  sizeBytes: number;
}

// ─── Service ─────────────────────────────────────────────────────────────────

const screenshotServiceUrl = env.SCREENSHOT_SERVICE_URL;
const cdnUploadUrl = env.CDN_UPLOAD_URL;

/** Whether the screenshot service is available */
export const screenshotEnabled = !!screenshotServiceUrl;

/**
 * Capture a screenshot of a deployed site.
 * Returns null when screenshot service is not configured.
 */
export async function captureScreenshot(
  opts: ScreenshotOptions,
): Promise<ScreenshotResult | null> {
  if (!screenshotServiceUrl) return null;

  const {
    url,
    width = 1600,
    height = 900,
    scale = 2,
    fullPage = false,
    timeout = 15_000,
  } = opts;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const res = await fetch(`${screenshotServiceUrl}/screenshot`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, width, height, scale, fullPage }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      console.error(`[screenshot] Service returned ${res.status}: ${await res.text()}`);
      return null;
    }

    const data = (await res.json()) as {
      url: string;
      width: number;
      height: number;
      size: number;
    };

    // Upload to CDN if configured
    let cdnUrl: string | null = null;
    if (cdnUploadUrl && data.url) {
      cdnUrl = await uploadToCdn(data.url);
    }

    return {
      tempUrl: data.url,
      cdnUrl,
      width: data.width,
      height: data.height,
      sizeBytes: data.size,
    };
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      console.warn(`[screenshot] Timed out after ${timeout}ms for ${url}`);
    } else {
      console.error(`[screenshot] Failed to capture ${url}:`, err);
    }
    return null;
  }
}

/**
 * Capture a screenshot after deploying a project.
 * Skips backend-only stacks (no UI to screenshot).
 */
export async function capturePostDeployScreenshot(
  siteUrl: string,
  stack: string,
): Promise<ScreenshotResult | null> {
  // Skip for backend-only stacks — no point screenshotting an API
  const skipStacks = new Set([
    "express", "fastify", "hono", "nestjs", "koa", "elysia", "adonis",
    "go", "gin", "fiber", "echo",
    "rust", "actix", "axum", "rocket",
    "python", "django", "flask", "fastapi",
    "rails", "sinatra", "laravel", "symfony",
    "springboot", "quarkus", "dotnet", "phoenix",
    "node", "docker",
  ]);

  if (skipStacks.has(stack)) return null;

  return captureScreenshot({
    url: siteUrl,
    width: 1600,
    height: 900,
    scale: 2,
    timeout: 15_000,
  });
}

// ─── CDN upload ──────────────────────────────────────────────────────────────

async function uploadToCdn(imageUrl: string): Promise<string | null> {
  if (!cdnUploadUrl) return null;

  try {
    const res = await fetch(cdnUploadUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: imageUrl }),
    });

    if (!res.ok) {
      console.error(`[screenshot] CDN upload failed: ${res.status}`);
      return null;
    }

    const data = (await res.json()) as { url: string };
    return data.url;
  } catch (err) {
    console.error("[screenshot] CDN upload error:", err);
    return null;
  }
}

/**
 * Clean up temporary screenshot from the browser service.
 */
export async function cleanupScreenshot(tempUrl: string): Promise<void> {
  if (!screenshotServiceUrl) return;

  try {
    await fetch(`${screenshotServiceUrl}/cleanup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: tempUrl }),
    });
  } catch {
    // Best-effort cleanup
  }
}
