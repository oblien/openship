import type { Context, Next } from "hono";
import { env } from "../config";

/**
 * Middleware that restricts a route to self-hosted instances only.
 *
 * Returns 404 when CLOUD_MODE=true (i.e. the managed openship.com SaaS).
 * Self-hosted deployments (docker, bare, desktop) — even those using
 * GitHub App auth or OAuth — retain full local filesystem access.
 *
 * This prevents RCE via local path endpoints on the public SaaS site
 * while keeping the feature available for all self-hosted setups.
 */
export async function localOnly(c: Context, next: Next) {
  if (env.CLOUD_MODE) {
    return c.notFound();
  }

  await next();
}
