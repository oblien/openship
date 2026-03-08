/**
 * Webhook service — provider registry and signature helpers.
 *
 * Providers register themselves at startup so the controller can dispatch
 * to the correct handler without importing provider-specific code directly.
 */

import crypto from "crypto";
import type { WebhookProvider, WebhookProviderName } from "./webhook.types";

// ─── Provider registry ───────────────────────────────────────────────────────

const providers = new Map<WebhookProviderName, WebhookProvider>();

export function registerWebhookProvider(provider: WebhookProvider) {
  providers.set(provider.name, provider);
}

export function getWebhookProvider(name: WebhookProviderName): WebhookProvider | undefined {
  return providers.get(name);
}

export function listWebhookProviders(): WebhookProviderName[] {
  return Array.from(providers.keys());
}

// ─── Shared crypto helpers ───────────────────────────────────────────────────

/**
 * Verify an HMAC-SHA256 signature (used by GitHub, many others).
 *
 * @param payload  Raw request body
 * @param secret   Shared secret
 * @param signature Header value (e.g. "sha256=abc...")
 * @param prefix   Prefix before the hex digest (default "sha256=")
 */
export function verifyHmacSha256(
  payload: string | Buffer,
  secret: string,
  signature: string,
  prefix = "sha256=",
): boolean {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
  const computed = `${prefix}${crypto.createHmac("sha256", secret).update(buf).digest("hex")}`;

  if (signature.length !== computed.length) return false;

  return crypto.timingSafeEqual(
    Buffer.from(signature, "utf8"),
    Buffer.from(computed, "utf8"),
  );
}
