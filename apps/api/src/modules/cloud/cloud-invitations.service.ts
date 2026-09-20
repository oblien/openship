/**
 * Cloud invitations service — relay organization invitation emails
 * for self-hosted instances through the SaaS's own mail infrastructure.
 *
 * The SaaS receives an authenticated cloud-session call from a local
 * instance and sends the message from its own platform/env transport.
 * Local instances can flip `invitationMailSource=cloud` to take this
 * path without provisioning their own mail server.
 *
 * Rate limit: cap each org at 20 invitations / hour relayed through
 * the SaaS. The local Better-Auth `beforeCreateInvitation` hook
 * already caps per-inviter at 50/hour, but a self-hosted attacker
 * could rotate inviters within their tenant; this is the cross-cutting
 * SaaS-side ceiling.
 */
import { cacheStore } from "@repo/platform/engine/lib/cache-store/index";
import { sendMail } from "@repo/platform/engine/lib/mail";

const INVITATION_RATE_LIMIT_PER_HOUR = 20;
const INVITATION_RATE_LIMIT_TTL_S = 60 * 60;

interface RateCounter {
  count: number;
  windowStartedAt: number;
}

export interface SendCloudInvitationInput {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export type SendCloudInvitationResult =
  | { ok: true; messageId: string }
  | { ok: false; status: 429 | 502; error: string };

export async function sendCloudInvitation(
  organizationId: string,
  input: SendCloudInvitationInput,
): Promise<SendCloudInvitationResult> {
  const limit = await checkAndIncrementRate(organizationId);
  if (!limit.ok) {
    return {
      ok: false,
      status: 429,
      error: `Invitation relay rate limit reached (${INVITATION_RATE_LIMIT_PER_HOUR}/hour for this organization). Try again later.`,
    };
  }

  try {
    // preferSource is intentionally omitted so the SaaS's own auto-select
    // (platform mailbox preferred, env-SMTP fallback) decides delivery.
    // The SaaS IS the cloud — there is nobody to relay to from here.
    await sendMail({
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown mail error";
    console.error(
      `[cloud-invitations] sendMail failed for org=${organizationId}: ${message}`,
    );
    return { ok: false, status: 502, error: `Mail delivery failed: ${message}` };
  }

  return { ok: true, messageId: `cloud-invite-${organizationId}-${Date.now()}` };
}

/**
 * Sliding-window counter keyed by organizationId. Stored in cacheStore
 * (Redis when available, memory otherwise — both share the namespace via
 * the standard cacheStore factory). Resets when the recorded window TTL
 * expires; uses a fresh window stamp inside the value to avoid extending
 * the TTL on each hit.
 */
async function checkAndIncrementRate(
  organizationId: string,
): Promise<{ ok: true } | { ok: false }> {
  const store = await cacheStore<RateCounter>("cloud-invitation-rl");
  const now = Date.now();
  const existing = await store.get(organizationId);
  const windowAgeMs = existing ? now - existing.windowStartedAt : Infinity;
  const inWindow = windowAgeMs < INVITATION_RATE_LIMIT_TTL_S * 1000;
  if (inWindow && existing && existing.count >= INVITATION_RATE_LIMIT_PER_HOUR) {
    return { ok: false };
  }
  const next: RateCounter = inWindow && existing
    ? { count: existing.count + 1, windowStartedAt: existing.windowStartedAt }
    : { count: 1, windowStartedAt: now };
  // Preserve the original window start by computing remaining TTL — keeps the
  // rate-limit window a true sliding sample rather than a per-hit reset.
  const remainingMs = inWindow
    ? INVITATION_RATE_LIMIT_TTL_S * 1000 - windowAgeMs
    : INVITATION_RATE_LIMIT_TTL_S * 1000;
  const ttlSeconds = Math.max(1, Math.ceil(remainingMs / 1000));
  await store.set(organizationId, next, ttlSeconds);
  return { ok: true };
}
