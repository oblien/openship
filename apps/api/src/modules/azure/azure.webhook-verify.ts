/**
 * Azure DevOps Service Hook verification — HTTPS Basic Auth password, not SHA-1.
 * Kept free of env/db imports so unit tests can cover the security boundary.
 */

import crypto from "node:crypto";
import type { WebhookVerifyResult } from "../webhooks/webhook.types";

function timingSafeEqualString(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function parseBasicPassword(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Basic\s+(\S+)/i.exec(header.trim());
  if (!match) return null;
  try {
    const decoded = Buffer.from(match[1]!, "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    if (colon < 0) return null;
    return decoded.slice(colon + 1);
  } catch {
    return null;
  }
}

/**
 * Pure verifier: compare the Basic Auth password against candidate secrets.
 */
export function verifyAzureBasicAuth(
  headers: Record<string, string>,
  secrets: string[],
): WebhookVerifyResult {
  const password = parseBasicPassword(
    headers.authorization ?? headers.Authorization,
  );
  if (!password) {
    return { valid: false, error: "Missing Authorization Basic header" };
  }
  if (secrets.length === 0) {
    return { valid: false, error: "No webhook secret configured — signature cannot be verified" };
  }
  const valid = secrets.some((secret) => timingSafeEqualString(password, secret));
  return valid ? { valid: true } : { valid: false, error: "Invalid signature" };
}
