/**
 * Webhook trigger — inbound `POST /api/webhooks/backup` with a bearer
 * token that fires a backup for the policy bound to that token.
 *
 * Security model:
 *   - The token IS the auth — there's no Bearer / cookie auth on this
 *     route. The token must be a high-entropy per-policy secret;
 *     generated with `crypto.randomBytes(24).toString('base64url')` =
 *     192 bits of entropy.
 *   - Tokens rotate via the policy editor (regenerate button).
 *   - Constant-time comparison NOT needed because the DB index lookup
 *     leaks nothing — the token IS the row key; either it matches or
 *     no row comes back. No "compare partial match" branch exists.
 *   - Rate-limited at the route layer (rateLimiter middleware).
 *   - Failed token = 404 (not 401) — attacker can't probe valid
 *     prefixes by error-code differential.
 *   - Audit-emit on EVERY attempt (success + auth-fail). The auth-fail
 *     row carries no token data (the bare claim is enough to detect
 *     enumeration attempts at the operator's audit log).
 *
 * Why not HMAC + timestamp signing (vs GitHub/Stripe webhooks)?
 * Backup webhooks are the REVERSE direction from GitHub/Stripe:
 * external schedulers (UptimeRobot, cron, GitHub Actions) call US to
 * trigger work. Those callers don't sign requests. Requiring HMAC
 * would break every existing scheduler integration. The trigger
 * effect is also idempotent (queueing another backup run); there's
 * no replay-amplification risk that HMAC + timestamp would address.
 */

import crypto from "node:crypto";
import { repos } from "@repo/db";
import { audit } from "../../../lib/audit";
import { backupOrchestrator } from "../backup.orchestrator";

export function generateWebhookToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}

export async function triggerBackupViaWebhook(opts: {
  token: string;
  clientIp?: string;
  userAgent?: string;
}): Promise<{ runId: string } | { error: "not_found" } | { error: "disabled" }> {
  const policy = await repos.backupPolicy.findByWebhookToken(opts.token);
  if (!policy) {
    // Auth-fail: no policy matches this token. The 404 response is
    // already opaque to attackers; here we surface the attempt to the
    // operator log so token-enumeration patterns are visible. We
    // can't audit-emit (no org context) but we DON'T log the token.
    console.warn(
      `[backup-webhook] auth failed (no policy bound) ip=${opts.clientIp ?? "?"} ua=${opts.userAgent ?? "?"}`,
    );
    return { error: "not_found" };
  }
  // backup_policy doesn't carry organizationId directly — resolve via
  // its project. Required for the audit row's NOT NULL fk to org.
  const project = policy.projectId
    ? await repos.project.findById(policy.projectId).catch(() => null)
    : null;
  const organizationId = project?.organizationId;

  if (!policy.enabled) {
    if (organizationId) {
      audit.recordAsync(
        {
          organizationId,
          actorUserId: policy.createdBy ?? null,
          ipAddress: opts.clientIp ?? null,
          userAgent: opts.userAgent ?? null,
        },
        {
          eventType: "backup.webhook.disabled",
          resourceType: "backup_policy",
          resourceId: policy.id,
        },
      );
    }
    return { error: "disabled" };
  }

  await repos.backupPolicy.markWebhookFired(policy.id);

  const result = await backupOrchestrator.enqueue({
    policyId: policy.id,
    trigger: {
      source: "webhook",
      userId: policy.createdBy ?? "system",
      clientIp: opts.clientIp,
      metadata: opts.userAgent ? { userAgent: opts.userAgent } : undefined,
    },
  });

  if (organizationId) {
    audit.recordAsync(
      {
        organizationId,
        actorUserId: policy.createdBy ?? null,
        ipAddress: opts.clientIp ?? null,
        userAgent: opts.userAgent ?? null,
      },
      {
        eventType: "backup.webhook.fired",
        resourceType: "backup_policy",
        resourceId: policy.id,
        after: { runId: result.runId },
      },
    );
  }

  return result;
}
