/**
 * Pure crypto helpers for the Oblien webhook receiver — signature
 * verification + idempotency-id derivation. No env/db/SDK imports so they're
 * unit-testable in isolation (the secret is passed in, not read from env).
 *
 * Signature: Oblien signs each delivery as
 *   X-Webhook-Signature = HMAC-SHA256(secret, rawBody) → hex
 * (body only — no timestamp, no `sha256=` prefix, though we tolerate the
 * prefix defensively). Compared in constant time.
 *
 * Idempotency: current deliveries bind JSON `id` to X-Webhook-Id. Legacy usage
 * deliveries can omit the body id; without either id, hash the complete signed
 * payload so distinct updates in the same period are not lost.
 */

import { createHmac, createHash, timingSafeEqual } from "node:crypto";

export interface SignatureCheck {
  ok: boolean;
  reason?: "no_secret" | "missing_header" | "bad_signature";
}

/** Minimal envelope shape needed to derive the idempotency id. */
export interface OblienEventEnvelope {
  id?: string;
  event?: string;
  timestamp?: string | number;
  namespace?: string;
  data?: {
    namespace?: string;
    workspace_id?: string;
    period_end?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export function extractNamespace(payload: OblienEventEnvelope): string | null {
  if (typeof payload.data?.namespace === "string") return payload.data.namespace;
  if (typeof payload.namespace === "string") return payload.namespace;
  return null;
}

/**
 * Verify the Oblien webhook signature. Returns a tagged result so callers can
 * log a typed reason without branching the response (every failure → 401,
 * except a missing secret which is an operator misconfiguration → 503).
 */
export function verifyOblienSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string | undefined,
): SignatureCheck {
  if (!secret) return { ok: false, reason: "no_secret" };
  if (!signatureHeader) return { ok: false, reason: "missing_header" };

  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const provided = signatureHeader.startsWith("sha256=")
    ? signatureHeader.slice("sha256=".length)
    : signatureHeader;

  if (provided.length !== expected.length) {
    return { ok: false, reason: "bad_signature" };
  }
  try {
    const equal = timingSafeEqual(
      Buffer.from(expected, "hex"),
      Buffer.from(provided, "hex"),
    );
    return equal ? { ok: true } : { ok: false, reason: "bad_signature" };
  } catch {
    // Buffer.from on a non-hex string throws lazily on some inputs —
    // treat as a mismatch rather than a 500.
    return { ok: false, reason: "bad_signature" };
  }
}

/** Derive the internal deduplication key after the receiver validates the ids. */
export function deriveOblienEventId(payload: OblienEventEnvelope, deliveryId?: string): string {
  const id = payload.id ?? deliveryId;
  const identity = id
    ? JSON.stringify(["oblien", extractNamespace(payload), id])
    : JSON.stringify(payload);
  return createHash("sha256").update(identity).digest("hex");
}
