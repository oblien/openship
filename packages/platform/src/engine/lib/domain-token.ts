import { createHmac } from "node:crypto";
import { env } from "../config/env";

/**
 * Deterministic verification token for a hostname.
 * HMAC-SHA256(hostname, secret) → hex prefix. Same input always produces the
 * same output so preview records, stored tokens, and the verify check match —
 * regardless of which path created the domain row (custom-domain connect OR a
 * custom public endpoint via syncProjectPublicRoutes).
 *
 * Lives here (not in domain.service) so `project-route-store` can set the same
 * token on custom endpoint rows without importing the domain service (cycle).
 */
export function generateToken(hostname: string): string {
  return createHmac("sha256", env.BETTER_AUTH_SECRET)
    .update(hostname.toLowerCase())
    .digest("hex")
    .slice(0, 16);
}
